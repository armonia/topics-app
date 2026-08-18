/**
 * Due revive nello stesso istante devono produrre UN solo PTY.
 *
 * PERCHÉ ESISTE. `POST /api/terminal/sessions/:id/revive` non aveva nessuna
 * serializzazione — a differenza di `/reload`, che si difende con
 * `reloadingSessionIds` e un 409. Due client sulla stessa tab dormiente (o un
 * client che ritenta una richiesta lenta) passavano entrambi la lettura
 * `status = 'dormant'` e chiamavano `createSession` per lo STESSO id: due PTY
 * sotto una sola voce di mappa. Il frame `exit` del bridge è chiavettato per
 * solo id, senza pid né generazione, quindi il primo dei due a morire portava
 * via il superstite — chiudendo i suoi socket e cancellando la sua riga — e da
 * quel momento il PTY vivo non stava né nella mappa del server né nel DB.
 *
 * LA BARRA: due revive concorrenti → esattamente UN frame `create` sul bridge, e
 * DUE 200 che descrivono la stessa sessione. Gli unit test non possono vederlo:
 * il difetto è nel concorso fra due richieste HTTP e il bridge, non dentro una
 * funzione.
 *
 * PERCHÉ NON PIÙ «una 200 e una 409» (2026-08-15). Serializzare rispondendo 409
 * al perdente sposta il problema sul client, che non ha modo di distinguere quel
 * 409 da un fallimento vero: `closedTabRecord.reopenClosedTab` ricadeva su
 * `POST /api/terminal/sessions` e coniava un SECONDO terminale (le «due tab, una
 * piena e una vuota»), e l'auto-revive di `SingleTerminalPane` lasciava su
 * l'overlay «Sessione scaduta» senza più niente che lo ritentasse. Ora il
 * perdente ASPETTA il vincitore e riceve la stessa sessione: un doppio click fa
 * UN terminale, con lo scrollback del PTY che è nato davvero.
 *
 * Il bridge è finto (un socket unix che parla il protocollo vero e RITARDA
 * l'ack: senza quel ritardo la prima revive finisce prima che la seconda
 * cominci e la corsa non esiste), tutto il resto è codice di produzione.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { createInterface } from "node:readline";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";

const TEST_ROOT = testTmpDir("terminal-revive-race");
const TEST_DATA = `${TEST_ROOT}/data`;
// Corto di proposito: un socket unix non supera i 104 caratteri di path.
const SOCKET_PATH = `${TEST_ROOT}/b.sock`;
const CWD = `${TEST_ROOT}/wt`;

interface FakeBridge {
  /** Ogni messaggio ricevuto dal server, in ordine. */
  received: { type?: string; id?: string }[];
  /** Quanto aspettare prima di rispondere `created` (apre la finestra di corsa). */
  ackDelayMs: number;
  close(): Promise<void>;
}

function startFakeBridge(): Promise<FakeBridge> {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* non c'era */ }
  const sockets = new Set<net.Socket>();
  let nextPid = 4000;
  const bridge: FakeBridge = {
    received: [],
    ackDelayMs: 150,
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
      let msg: { type?: string; id?: string };
      try { msg = JSON.parse(line); } catch { return; }
      bridge.received.push(msg);
      if (msg.type === "list") {
        socket.write(JSON.stringify({ type: "list", sessions: [] }) + "\n");
      } else if (msg.type === "ping") {
        socket.write(JSON.stringify({ type: "pong" }) + "\n");
      } else if (msg.type === "create") {
        setTimeout(() => {
          try { socket.write(JSON.stringify({ type: "created", id: msg.id, pid: nextPid++ }) + "\n"); } catch { /* chiuso */ }
        }, bridge.ackDelayMs);
      }
    });
  });
  return new Promise((resolve) => server.listen(SOCKET_PATH, () => resolve(bridge)));
}

let bridge: FakeBridge;
let ctx: AppContext;
let terminalRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;

async function call(path: string, method: string, body?: object): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await terminalRouter(req, url, url.pathname, method);
  if (!res) throw new Error(`nessuna route per ${method} ${path}`);
  return res;
}

/** Una tab dormiente come la lascia il parcheggio: riga nel DB, nessun PTY. */
function seedDormant(id: string): void {
  ctx.db.run(
    `INSERT INTO terminal_sessions (id, name, cwd, command, type, cols, rows, skip_permissions, created_at, status)
     VALUES (?, ?, ?, ?, 'shell', 120, 30, 1, ?, 'dormant')`,
    [id, id, CWD, "/bin/sh", new Date().toISOString()],
  );
}

function createFramesFor(id: string): number {
  return bridge.received.filter((m) => m.type === "create" && m.id === id).length;
}

beforeAll(async () => {
  setupTestDataDir(TEST_DATA);
  fs.mkdirSync(CWD, { recursive: true });
  // Il bridge del test è SUO: mai quello del server vero. Il path si congela al
  // primo import del modulo, che sotto `bun test` può essere avvenuto in un
  // ALTRO file, quindi si usa il seam esplicito.
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  bridge = await startFakeBridge();

  ctx = await createTestAppContext();
  const { createTerminalRouter, _setPtyBridgeSocketPath, disconnectBridge } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(SOCKET_PATH);
  terminalRouter = createTerminalRouter(ctx) as typeof terminalRouter;
  // Il router si aggancia al bridge in fire-and-forget: si aspetta che la
  // `list` di riconciliazione sia arrivata, o la prima revive parlerebbe a un
  // socket ancora chiuso.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !bridge.received.some((m) => m.type === "list")) {
    await new Promise((r) => setTimeout(r, 50));
  }
}, 30_000);

afterAll(async () => {
  const { disconnectBridge, _setPtyBridgeSocketPath } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(null);
  await bridge?.close();
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

describe("POST /revive è serializzato sull'id", () => {
  test("due revive concorrenti: un solo create, e due risposte sulla STESSA sessione", async () => {
    const id = "term-race-1";
    seedDormant(id);
    const before = createFramesFor(id);

    const [a, b] = await Promise.all([
      call(`/api/terminal/sessions/${id}/revive`, "POST"),
      call(`/api/terminal/sessions/${id}/revive`, "POST"),
    ]);

    // Nessuno dei due riceve un errore: il perdente ha aspettato il vincitore.
    // Con il 409 al suo posto, chi chiama non poteva distinguerlo da un 404 e
    // coniava un secondo terminale.
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = await Promise.all([a.json(), b.json()]) as { id: string }[];
    expect(bodies.map((r) => r.id)).toEqual([id, id]);
    // LA BARRA. Senza il cancello qui ce ne sono DUE, e il secondo PTY non
    // sopravvive al primo `exit`.
    expect(createFramesFor(id) - before).toBe(1);
    // E la riga è viva una volta sola.
    const row = ctx.db.query("SELECT status FROM terminal_sessions WHERE id = ?").get(id) as { status?: string } | undefined;
    expect(row?.status).toBe("active");
  }, 20_000);

  test("una revive su una sessione GIÀ viva torna quella, senza un secondo create", async () => {
    // Il perdente della doppia click non deve leggere "not found" per una tab
    // che ha davanti agli occhi, e nemmeno farsi costruire un secondo PTY
    // sopra: la revive è idempotente dal lato di chi chiama.
    const id = "term-race-1";
    const before = createFramesFor(id);
    const res = await call(`/api/terminal/sessions/${id}/revive`, "POST");
    expect(res.status).toBe(200);
    expect((await res.json() as { id: string }).id).toBe(id);
    expect(createFramesFor(id) - before).toBe(0);
  }, 20_000);
});
