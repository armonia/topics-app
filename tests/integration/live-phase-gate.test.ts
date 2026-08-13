/**
 * Il cancello sulle FASI VIVE — la catena intera, non i pezzi.
 *
 * PERCHÉ ESISTE. Le due perdite chiuse il 2026-08-09 (commit 9c380611) vivevano
 * entrambe in stato ricostruito a ogni riavvio del server: 20 sessioni
 * `awaiting-user` su chat archiviate + 1 `starting` immortale, e un frame di
 * riattaccata che annunciava «Lavoro completato» per una tab chiusa da giorni.
 * I pezzi PURI hanno già i loro test (claude-session-tracker.test.ts,
 * pty-activity.test.ts → countsAsActivity, archive-topic.test.ts): quello che
 * mancava è la catena — route → parcheggio → tracker → DB, e bridge →
 * riattaccata → frame → broadcast. È lì che il bug viveva, ed è esattamente il
 * punto dove una regressione non si vede (il sintomo è un banner, giorni dopo).
 *
 * COSA MISURA, sulle tre strade dove la perdita è passata davvero:
 *   (a) archiviare un topic con una sessione in `awaiting-user` la lascia
 *       `dormant` — sia dal percorso singolo (DELETE /api/topics/:id) sia dal
 *       bulk-archive, che è la QUARTA implementazione da cui la perdita è nata;
 *   (b) una riattaccata (bridge che riporta viva una PTY claude-code) registra
 *       la sessione come `dormant`, MAI `starting`, quando il transcript è già
 *       scritto — e resta `starting` per una nascita vera;
 *   (c) il primo frame dopo quella riattaccata non produce nessun
 *       `terminal:activity` (né `busy`, né `finished:true`) e non risveglia la
 *       fase; il SECONDO frame invece sì — o il cancello sarebbe un muto, cioè
 *       un verde che non può fallire.
 *
 * Il bridge è finto (un socket unix che risponde a `list` e spinge frame), ma
 * tutto il resto è il codice di produzione: il router terminali, il router
 * topics, il tracker vero su un DB migrato vero.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";
import type { ClaudeSessionTracker } from "../../server/lib/claude-session-tracker";

// Una radice sola per tutto quello che questo file mette sul disco. Il socket
// vive DENTRO di lei: la radice e' corta apposta, cosi' il path resta sotto i
// 104 caratteri che un socket unix consente (vedi `testTmpDir`).
const ROOT = testTmpDir("live-phase-gate");
const TEST_DATA = join(ROOT, "data");
const FAKE_HOME = join(ROOT, "home");
const SOCKET_PATH = join(ROOT, "bridge.sock");

// Il terminale dichiara `finished` dopo TERMINAL_IDLE_MS (1500) di silenzio.
const IDLE_MS = 1500;
const AFTER_IDLE_MS = IDLE_MS + 400;

const TERM_ID = "term-reattached-1";
const CSID = "11111111-2222-4333-8444-555555555555";
const CWD = join(ROOT, "wt");

/** Il transcript canonico che `deriveTranscriptPath` cerca per (home, cwd, csid). */
function transcriptPath(): string {
  return `${FAKE_HOME}/.claude/projects/${CWD.replace(/[^A-Za-z0-9]/g, "-")}/${CSID}.jsonl`;
}

// ── Il bridge finto ────────────────────────────────────────────────────────
// Parla il protocollo del bridge vero (JSON per riga): risponde a `list` con le
// PTY che dichiariamo vive e ci lascia spingere frame `data` a comando.
interface FakeBridge {
  /** PTY che il bridge dichiara vive alla prossima `list`. */
  alive: { id: string; pid: number }[];
  /** Messaggi ricevuti dal server (per verificare che non uccida niente). */
  received: any[];
  send(msg: object): void;
  close(): Promise<void>;
}

function startFakeBridge(): Promise<FakeBridge> {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* non c'era */ }
  const sockets = new Set<net.Socket>();
  const bridge: FakeBridge = {
    alive: [],
    received: [],
    send(msg) {
      for (const s of sockets) s.write(JSON.stringify(msg) + "\n");
    },
    close() {
      return new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
    },
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => { /* il server chiude quando vuole */ });
    const rl = createInterface({ input: socket });
    rl.on("line", (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      bridge.received.push(msg);
      if (msg.type === "list") {
        socket.write(JSON.stringify({ type: "list", sessions: bridge.alive }) + "\n");
      } else if (msg.type === "ping") {
        socket.write(JSON.stringify({ type: "pong" }) + "\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(SOCKET_PATH, () => resolve(bridge)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Attende che `pred` diventi vera, o fallisce dopo `timeoutMs`. */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(50);
  }
  throw new Error("waitFor: condizione mai verificata entro il timeout");
}

// ── Stato condiviso dal file (una sola app, come in produzione) ─────────────
let bridge: FakeBridge;
let ctx: AppContext;
let tracker: ClaudeSessionTracker;
let broadcasts: any[] = [];
let topicsRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;

/** Ogni `terminal:activity` visto per la sessione riattaccata. */
function activityFor(id: string): any[] {
  return broadcasts.filter((m) => m?.type === "terminal:activity" && m.id === id);
}

async function callTopics(path: string, method: string, body?: object): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await topicsRouter(req, url, url.pathname, method);
  if (!res) throw new Error(`nessuna route per ${method} ${path}`);
  return res;
}

/** Un topic con una sessione claude in fase VIVA, come quelle trapelate. */
async function seedTopicWithLivePhase(name: string, projectPath: string, csid: string): Promise<{ id: string; sessionKey: string }> {
  const res = await callTopics("/api/topics", "POST", { name, projectPath });
  expect(res.status).toBe(201);
  const topic = (await res.json()) as { id: string; sessionKey: string };
  const nowIso = new Date().toISOString();
  ctx.db.prepare(
    `INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at, phase, phase_updated_at)
     VALUES (?, ?, ?, ?, 'awaiting-user', ?)`,
  ).run(topic.sessionKey, csid, nowIso, nowIso, nowIso);
  expect(tracker.getSessionByKey(topic.sessionKey)!.phase).toBe("awaiting-user");
  return topic;
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  setupTestDataDir(TEST_DATA);
  fs.mkdirSync(CWD, { recursive: true });
  // Il bridge del test è SUO: mai quello del server vero. L'env non basta —
  // il path si congela al primo import del modulo, che sotto `bun test` può
  // essere avvenuto in un ALTRO file — quindi si usa il seam esplicito
  // (`_setPtyBridgeSocketPath`), rimesso a posto in afterAll.
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  bridge = await startFakeBridge();

  ctx = await createTestAppContext();
  broadcasts = [];
  (ctx as { broadcastToAll: (msg: object) => void }).broadcastToAll = (msg) => { broadcasts.push(msg); };

  const { createClaudeSessionTracker } = await import("../../server/lib/claude-session-tracker");
  tracker = createClaudeSessionTracker({
    db: ctx.db,
    broadcast: (msg) => broadcasts.push(msg),
    homeDir: FAKE_HOME,
    coalesceWindowMs: 10,
  });
  // ESATTAMENTE il collegamento di produzione (server.ts lo chiama così).
  const { configureSessionParkingForTracker } = await import("../../server/lib/session-parking");
  configureSessionParkingForTracker(tracker);

  const { createTopicsRouter } = await import("../../server/routes/topics");
  topicsRouter = createTopicsRouter(ctx) as typeof topicsRouter;
  // 30 s e non i 5 s di default: qui dentro girano 88 migration su un DB nuovo
  // — su una macchina carica ci stanno larghi, e un hook scaduto è un rosso che
  // non parla del cancello.
}, 30_000);

afterAll(async () => {
  // Il socket finto muore con questo file: lasciarlo nell'env manderebbe i file
  // successivi (stesso processo) a bussare a una porta chiusa.
  const { disconnectBridge, _setPtyBridgeSocketPath } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(null);
  await bridge?.close();
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// (a) Archiviare spegne la fase — su tutte le porte, non su una sola
// ───────────────────────────────────────────────────────────────────────────
describe("catena archivio → parcheggio → tracker", () => {
  test("DELETE /api/topics/:id porta una sessione awaiting-user a dormant", async () => {
    const topic = await seedTopicWithLivePhase("Chat singola", "/tmp/proj-single", "csid-single-1");

    const res = await callTopics(`/api/topics/${topic.id}`, "DELETE", { archived: true });
    expect(res.status).toBe(200);

    expect(tracker.getSessionByKey(topic.sessionKey)!.phase).toBe("dormant");
  });

  test("bulk-archive (la strada da cui la perdita è nata) parcheggia ogni topic del progetto", async () => {
    const a = await seedTopicWithLivePhase("Chat A", "/tmp/proj-bulk", "csid-bulk-a");
    const b = await seedTopicWithLivePhase("Chat B", "/tmp/proj-bulk", "csid-bulk-b");

    const res = await callTopics("/api/topics/bulk-archive", "POST", {
      projectPath: "/tmp/proj-bulk",
      archived: true,
    });
    expect(res.status).toBe(200);

    for (const t of [a, b]) {
      expect(tracker.getSessionByKey(t.sessionKey)!.phase).toBe("dormant");
    }
    // Il cancello che il task chiede: ZERO fasi vive su topic archiviati.
    const liveOnArchived = ctx.db.query(
      `SELECT COUNT(*) AS n FROM claude_code_sessions s
       JOIN topics t ON t.session_key = s.session_key
       WHERE t.archived = 1 AND s.phase NOT IN ('dormant', 'completed', 'error')`,
    ).get() as { n: number };
    expect(liveOnArchived.n).toBe(0);
  });

  test("archiviare NON tocca la fase dei topic aperti", async () => {
    const open = await seedTopicWithLivePhase("Chat aperta", "/tmp/proj-open", "csid-open-1");
    await callTopics("/api/topics/bulk-archive", "POST", { projectPath: "/tmp/proj-bulk", archived: true });
    expect(tracker.getSessionByKey(open.sessionKey)!.phase).toBe("awaiting-user");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) + (c) La riattaccata: fase a riposo, e il suo primo frame non annuncia
// ───────────────────────────────────────────────────────────────────────────
describe("catena riattaccata: bridge → registrazione → primo frame", () => {
  test("una PTY claude-code sopravvissuta con transcript già scritto torna dormant, mai starting", async () => {
    // Il mondo com'è dopo un riavvio del server: la riga in DB c'è, il bridge ha
    // ancora la sua PTY viva, e il transcript ha GIÀ contenuto (il lavoro è di
    // ieri). `terminalStates` invece è vuoto — è solo in memoria.
    fs.mkdirSync(transcriptPath().replace(/\/[^/]+$/, ""), { recursive: true });
    fs.writeFileSync(transcriptPath(), JSON.stringify({ type: "user", timestamp: new Date().toISOString() }) + "\n");
    ctx.db.prepare(
      `INSERT INTO terminal_sessions (id, name, cwd, command, type, cols, rows, skip_permissions, created_at, claude_session_id, status)
       VALUES (?, 'Claude', ?, NULL, 'claude-code', 120, 30, 1, ?, ?, 'active')`,
    ).run(TERM_ID, CWD, new Date().toISOString(), CSID);
    bridge.alive = [{ id: TERM_ID, pid: 4242 }];

    const { createTerminalRouter, disconnectBridge, _setPtyBridgeSocketPath } =
      await import("../../server/routes/terminal");
    // `bun test` gira tutti i file in UN processo: un altro file può aver già
    // importato questo modulo (congelandone il socket) e attaccato il suo
    // bridge. Puntare il nostro + staccare il vecchio è ciò che rende questa
    // catena indipendente dall'ordine dei file.
    _setPtyBridgeSocketPath(SOCKET_PATH);
    disconnectBridge();
    createTerminalRouter(ctx, tracker); // connette il bridge + riconcilia

    await waitFor(() => tracker.getSession(CSID) !== null);
    const state = tracker.getSession(CSID)!;
    expect(state.phase).not.toBe("starting");
    expect(state.phase).toBe("dormant");
    // E la PTY viva non è stata uccisa: la riattaccata è un'adozione.
    expect(bridge.received.some((m) => m.type === "kill")).toBe(false);
  }, 20_000);

  test("il primo frame dopo la riattaccata non annuncia niente e non risveglia la fase", async () => {
    broadcasts.length = 0;
    bridge.send({ type: "data", id: TERM_ID, data: "[2J[H> pronto\r\n" });

    // Oltre la finestra di idle: se quel frame fosse contato, qui ci sarebbe già
    // il `busy:true` e — 1,5 s dopo — il `finished:true` da cui nasce il banner.
    await sleep(AFTER_IDLE_MS);
    expect(activityFor(TERM_ID)).toEqual([]);
    expect(tracker.getSession(CSID)!.phase).toBe("dormant");
  }, 20_000);

  test("il SECONDO frame invece è lavoro vero: busy, finished e fase risvegliata", async () => {
    broadcasts.length = 0;
    bridge.send({ type: "data", id: TERM_ID, data: "\r\nSto leggendo server.ts…\r\n" });

    await waitFor(() => activityFor(TERM_ID).some((m) => m.busy === true));
    await waitFor(() => tracker.getSession(CSID)!.phase === "running");
    await sleep(AFTER_IDLE_MS);
    expect(activityFor(TERM_ID).some((m) => m.finished === true)).toBe(true);
  }, 20_000);
});

// ───────────────────────────────────────────────────────────────────────────
// La contro-prova di (b): una nascita vera resta `starting`
// ───────────────────────────────────────────────────────────────────────────
describe("nascita vera", () => {
  test("senza transcript sul disco la fase iniziale resta starting", () => {
    const fresh = "99999999-8888-4777-8666-555555555555";
    tracker.registerTerminalSession(fresh, { cwd: CWD });
    expect(tracker.getSession(fresh)!.phase).toBe("starting");
  });

  test("un transcript VUOTO è ancora una nascita, non una riattaccata", () => {
    const fresh = "88888888-7777-4666-8555-444444444444";
    const p = `${FAKE_HOME}/.claude/projects/${CWD.replace(/[^A-Za-z0-9]/g, "-")}/${fresh}.jsonl`;
    fs.writeFileSync(p, "");
    tracker.registerTerminalSession(fresh, { cwd: CWD });
    expect(tracker.getSession(fresh)!.phase).toBe("starting");
  });
});
