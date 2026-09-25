/**
 * QUANTE VOLTE lo store di una sessione viaggia sul ponte, al boot.
 *
 * Il setaccio di boot fa due cose in fila su ogni sessione sopravvissuta:
 * chiede alla sonda se c'è un turno in volo (`brokerTurnState`, che è un
 * `attach(id, 0)` muto: replay INTEGRALE dello store) e, se la risposta è
 * «open», riadotta — e la fase 1 di `reattach` rifà lo STESSO `attach(id, 0)`.
 * Due volte lo stesso store, per sessione, sull'unico socket del ponte, e tutto
 * prima che l'utente veda qualcosa: in produzione 27 store fino a 6,9 MB sono
 * ~166 MB spediti e ripiegati al posto di 83.
 *
 * Qui si contano gli `attach` sul client del ponte — chiamate E byte — sulle
 * due vie, su due sessioni con lo STESSO store: la vecchia (la sonda butta il
 * suo scan) e la nuova (`park: true`: la sonda lo parcheggia, la riadozione lo
 * adotta e salta la fase 1). La differenza dev'essere esattamente un replay
 * integrale.
  * @covers CCLI-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { recordedBackgroundSession } from "./claude/background-work.fixture";

const REPO_ROOT = join(import.meta.dir, "..", "..");
let tempDir = "";
const SOCK = join(tmpdir(), `ai-bridge-bootreplay-${process.pid}.sock`);
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

let ProviderCtor: any;
let seedTopic: (sessionKey: string, id: string) => void;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "ai-bridge-bootreplay-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE", "1");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", SOCK);

  const { initDatabase, getDatabase } = await import("../db");
  initDatabase(REPO_ROOT);
  seedTopic = (sessionKey, id) => {
    const now = new Date().toISOString();
    getDatabase().prepare(
      `INSERT OR IGNORE INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    ).run(id, id, id, sessionKey, now, now);
  };
  const { ClaudeCodeProvider } = await import("./claude-code");
  ProviderCtor = ClaudeCodeProvider;
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
});

afterAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  try {
    const { closeDatabase } = await import("../db");
    closeDatabase();
  } catch {}
  try {
    const pidPath = SOCK.replace(/\.sock$/, ".pid");
    if (existsSync(pidPath)) process.kill(Number(readFileSync(pidPath, "utf8").trim()), "SIGTERM");
  } catch {}
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * La forma dello store che il boot trova davvero: un turno CHIUSO alle spalle
 * (con la sua zavorra: è quello che rende un replay integrale costoso) e uno
 * ANCORA APERTO in coda — un `ask_user_question` senza risposta, il caso che
 * porta alla riadozione. Poi il figlio dorme, quindi lo store è FERMO e ogni
 * byte contato qui sotto è deterministico.
 */
const PADDING = "z".repeat(4000);
function writeStoreCli(name: string): string {
  const p = join(tempDir, name);
  const lines: string[] = [];
  for (let i = 0; i < 16; i++) {
    lines.push(`printf '{"type":"assistant","message":{"content":[{"type":"text","text":"${PADDING}"}]}}\\n'`);
  }
  lines.push(`printf '{"type":"result","result":"turno-vecchio","usage":{"input_tokens":1,"output_tokens":1},"duration_ms":1,"total_cost_usd":0}\\n'`);
  lines.push(`printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_boot","name":"mcp__topics__ask_user_question","input":{"questions":[{"question":"Riprendo?","header":"Boot","options":[{"label":"Sì"}]}]}}]}}\\n'`);
  lines.push("sleep 30");
  writeFileSync(p, `#!/bin/sh\nread line\n${lines.join("\n")}\n`);
  chmodSync(p, 0o755);
  return p;
}

function makeHandler() {
  const asks: string[] = [];
  const handler: any = {
    onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {},
    onSubAgentUpdate: () => {},
    onUserInputRequired: (toolId: string) => { asks.push(toolId); },
    onAborted: () => {}, onDone: () => {}, onError: () => {},
  };
  return { handler, asks };
}

/** Porta la sessione allo stato «riavvio a turno aperto»: il figlio ha scritto
 *  il suo store nel daemon e ora dorme, e nessun provider lo sta guidando. */
async function seedSurvivingSession(sessionKey: string, topicId: string): Promise<number> {
  seedTopic(sessionKey, topicId);
  const provA = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
  const hA = makeHandler();
  provA.sendChat(sessionKey, "ciao", hA.handler).catch(() => { /* A muore al riavvio */ });
  const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
  const bridge = getAiBridgeClient();
  const endOffset = async () => (await bridge.list()).find((s) => s.id === sessionKey)?.endOffset ?? 0;
  // Lo store è completo quando ha smesso di crescere: il figlio ha finito di
  // scrivere ed è andato a dormire. Due letture uguali di fila bastano.
  let last = -1;
  await waitFor(async () => {
    const now = await endOffset();
    const stable = now > 0 && now === last;
    last = now;
    return stable;
  }, 10_000, 100);
  // Provider A esce di scena SENZA uccidere il figlio (è ciò che fa uno
  // spegnimento pulito: `stop()` stacca e basta) — da qui in poi è un
  // sopravvissuto che nessuno guida, esattamente come al boot.
  provA.stop();
  return last;
}

describe("boot · un solo replay dello store per sessione", () => {
  test("la sonda che PARCHEGGIA dimezza gli attach(0): 2 → 1, e risparmia un intero store", async () => {
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeStoreCli("fake-bootstore.sh"));
    const keyPrima = "topic:boot-replay-prima";
    const keyAfter = "topic:boot-replay-dopo";
    const storePrima = await seedSurvivingSession(keyPrima, "t-boot-prima");
    const storeAfter = await seedSurvivingSession(keyAfter, "t-boot-dopo");
    // Stesso figlio, stesso copione: gli store DEVONO essere identici, o i byte
    // delle due vie non sarebbero confrontabili.
    expect(storeAfter).toBe(storePrima);
    expect(storePrima).toBeGreaterThan(50_000);

    // Il contatore: ogni `attach` sul client del ponte, con i byte che il
    // daemon ha effettivamente rispedito ([from, endOffset]).
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    const bridge = getAiBridgeClient() as any;
    const vero = bridge.attach.bind(bridge);
    const attacchi: Array<{ id: string; from: number; bytes: number }> = [];
    bridge.attach = async (id: string, from: number) => {
      const res = await vero(id, from);
      attacchi.push({ id, from, bytes: Math.max(0, (res.endOffset ?? 0) - from) });
      return res;
    };
    const suDi = (id: string) => attacchi.filter((a) => a.id === id);
    const byteDi = (id: string) => suDi(id).reduce((n, a) => n + a.bytes, 0);
    const replayIntegraliDi = (id: string) => suDi(id).filter((a) => a.from === 0).length;

    try {
      // ── PRIMA · la sonda butta il suo scan ────────────────────────────────
      // (nessun `park`: è letteralmente il comportamento di ieri)
      const provPrima = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
      expect(await provPrima.brokerTurnState(keyPrima)).toBe("open");
      const hPrima = makeHandler();
      // La riadozione NON si aspetta: un turno fermo su una domanda si risolve
      // solo quando la domanda finisce, e qui il figlio dorme apposta. Ciò che
      // si misura è finito appena la fase 2 ha attaccato.
      const drivePrima = provPrima.reattach(keyPrima, hPrima.handler);
      drivePrima.catch(() => { /* il figlio verrà ucciso a fine test */ });
      await waitFor(() => suDi(keyPrima).length >= 3, 10_000);

      // ── DOPO · la sonda PARCHEGGIA, la riadozione adotta ──────────────────
      const provDopo = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
      expect(await provDopo.brokerTurnState(keyAfter, { park: true })).toBe("open");
      const hAfter = makeHandler();
      const driveAfter = provDopo.reattach(keyAfter, hAfter.handler);
      driveAfter.catch(() => {});
      await waitFor(() => suDi(keyAfter).length >= 2, 10_000);

      // La misura, PRIMA delle asserzioni: quando la barra è rossa i numeri
      // sono la diagnosi, e un log che non esce perché l'expect è saltato
      // prima non serve a nessuno.
      const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
      console.log(
        `[misura] store ${kb(storePrima)} · PRIMA ${replayIntegraliDi(keyPrima)} replay integrali, ` +
        `${suDi(keyPrima).length} attach, ${kb(byteDi(keyPrima))} · ` +
        `DOPO ${replayIntegraliDi(keyAfter)} replay integrali, ${suDi(keyAfter).length} attach, ${kb(byteDi(keyAfter))} ` +
        `(−${(100 * (1 - byteDi(keyAfter) / byteDi(keyPrima))).toFixed(0)}%)`,
      );

      // LA BARRA. Prima: due replay integrali (sonda + fase 1) più l'attach
      // mirato della fase 2. Dopo: UNO solo, più lo stesso attach mirato.
      expect(replayIntegraliDi(keyPrima)).toBe(2);
      expect(replayIntegraliDi(keyAfter)).toBe(1);
      expect(suDi(keyPrima).length).toBe(3);
      expect(suDi(keyAfter).length).toBe(2);

      // E in byte: la differenza è ESATTAMENTE un intero store, non un'inezia.
      expect(byteDi(keyPrima) - byteDi(keyAfter)).toBe(storePrima);
      // La fase 2 resta mirata su entrambe le vie: riparte da dopo l'ultimo
      // `result`, non da zero (altrimenti il risparmio se lo mangerebbe lei).
      const fase2Dopo = suDi(keyAfter).find((a) => a.from > 0);
      expect(fase2Dopo).toBeDefined();
      expect(fase2Dopo!.bytes).toBeLessThan(storeAfter / 4);

      // Il parcheggio non lascia niente dietro: lo scan è stato RECLAMATO dalla
      // riadozione, non è rimasto attaccato in un angolo.
      expect((provDopo as any).parkedScans.size).toBe(0);
    } finally {
      bridge.attach = vero;
      for (const k of [keyPrima, keyAfter]) { try { bridge.kill(k); } catch { /* pulizia best-effort */ } }
    }
  }, 40_000);

  /**
   * L'offset di ripartenza della fase 2, alla RIGA e non alla fetta.
   *
   * `consumedOffset` sta alla FINE del chunk che il daemon ha consegnato — e in
   * un replay il chunk è tutto lo store. Ripartire da lì significa saltare
   * tutto ciò che nella stessa fetta veniva dopo il `result`: cioè la testa del
   * turno ancora aperto. Qui quella testa È la domanda: se l'offset è sbagliato
   * la fase 2 non rispedisce niente, `pendingInputs` resta vuoto e il pannello
   * non torna a schermo — un turno vivo letto come finito.
   */
  test("la fase 2 riparte subito dopo la riga del `result`: la domanda aperta torna a schermo", async () => {
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeStoreCli("fake-bootstore2.sh"));
    const sessionKey = "topic:boot-replay-riga";
    const store = await seedSurvivingSession(sessionKey, "t-boot-riga");

    const prov = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
    expect(await prov.brokerTurnState(sessionKey, { park: true })).toBe("open");

    // Lo scan parcheggiato ha già l'offset: dev'essere BEN dentro lo store (la
    // riga del result), non alla sua fine (la fetta).
    const parcheggiato = (prov as any).parkedScans.get(sessionKey);
    expect(parcheggiato).toBeDefined();
    const daDove = parcheggiato.pp.replayAfterLastResultOffset as number;
    expect(daDove).toBeGreaterThan(0);
    expect(daDove).toBeLessThan(store);

    const h = makeHandler();
    const drive = prov.reattach(sessionKey, h.handler);
    drive.catch(() => {});
    // La prova che l'offset era giusto: la domanda è stata ritrovata nel
    // replay mirato e ri-emessa verso il nuovo handler.
    await waitFor(() => h.asks.length > 0, 10_000);
    expect(h.asks).toContain("toolu_boot");

    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    try { getAiBridgeClient().kill(sessionKey); } catch { /* pulizia best-effort */ }
  }, 40_000);

  test("senza promessa di riadozione la sonda non parcheggia niente, e due sonde di fila non si pestano", async () => {
    setEnv("TOPICS_CLAUDE_CLI_PATH", writeStoreCli("fake-bootstore3.sh"));
    const sessionKey = "topic:boot-replay-sonda";
    await seedSurvivingSession(sessionKey, "t-boot-sonda");

    const prov = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
    // La rotta della storia sonda a ogni caricamento della chat e non riadotta
    // niente: un parcheggio lì sarebbe un attacco al daemon per ricarica.
    expect(await prov.brokerTurnState(sessionKey)).toBe("open");
    expect((prov as any).parkedScans.size).toBe(0);

    // Con la promessa, invece, lo scan resta — e una SECONDA sonda risponde da
    // quello, senza spedire di nuovo lo store.
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    const bridge = getAiBridgeClient() as any;
    const vero = bridge.attach.bind(bridge);
    let attach = 0;
    bridge.attach = async (id: string, from: number) => { attach++; return vero(id, from); };
    try {
      expect(await prov.brokerTurnState(sessionKey, { park: true })).toBe("open");
      expect(attach).toBe(1);
      expect((prov as any).parkedScans.size).toBe(1);
      expect(await prov.brokerTurnState(sessionKey, { park: true })).toBe("open");
      expect(attach).toBe(1); // la risposta arriva dal parcheggio
      expect((prov as any).parkedScans.size).toBe(1);
    } finally {
      bridge.attach = vero;
    }

    // Spegnimento: gli scan parcheggiati non sono in `this.processes`, quindi
    // se `stop()` li dimentica restano attaccati al daemon per sempre.
    prov.stop();
    expect((prov as any).parkedScans.size).toBe(0);

    try { getAiBridgeClient().kill(sessionKey); } catch { /* pulizia best-effort */ }
  }, 40_000);
});

/**
 * A CLOSED TURN WITH ITS AGENT STILL RUNNING IS NOT A TURN IN FLIGHT (card C9).
 *
 * Chat 3019832f, 25/09: the server restarted while the chat waited for its
 * background agent. The store held the agent's lines after the last `result`
 * (they carry `parent_tool_use_id`), the scan read them as an open turn, and the
 * boot adopted a turn that only the agent's end could close; the stall judge
 * later recycled it and killed the agent. Read correctly, the tail is closed,
 * and the session must still be KEPT, not reaped: its work is alive, and the
 * wake it brings when it reports has to be heard.
 *
 * The store is the recorded CLI session (`claude/background-work.fixture.ts`):
 * up to the agent's lines before the first wake, then the fake CLI waits for a
 * trigger and prints that wake, the Monitor's first tick.
 */
describe("boot · the agent's lines after the last result", () => {
  test("the tail is closed, the session is kept attached, and the next wake is heard", async () => {
    const events = recordedBackgroundSession();
    const firstResult = events.findIndex((e) => e.type === "result");
    const nextInit = events.findIndex((e, i) => i > firstResult && e.type === "system" && e.subtype === "init");
    const wakeEnd = events.findIndex((e, i) => i > nextInit && e.type === "result");
    const before = join(tempDir, "bg-before.ndjson");
    const wake = join(tempDir, "bg-wake.ndjson");
    const trigger = join(tempDir, "bg-wake.go");
    writeFileSync(before, events.slice(0, nextInit).map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(wake, events.slice(nextInit, wakeEnd + 1).map((e) => JSON.stringify(e)).join("\n") + "\n");
    const cli = join(tempDir, "fake-bgstore.sh");
    writeFileSync(cli, `#!/bin/sh\nread line\ncat '${before}'\nwhile [ ! -f '${trigger}' ]; do sleep 0.05; done\ncat '${wake}'\nsleep 30\n`);
    chmodSync(cli, 0o755);
    setEnv("TOPICS_CLAUDE_CLI_PATH", cli);

    const sessionKey = "topic:boot-bg-agent";
    await seedSurvivingSession(sessionKey, "t-boot-bg-agent");
    const prov = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    try {
      // Before the fix: "open", and the boot adopted a turn nobody had opened.
      expect(await prov.brokerTurnState(sessionKey, { park: true })).toBe("idle");
      expect((prov as any).parkedScans.size).toBe(0);
      // Not reaped either: the probe kept the session as its process, and the
      // boot asks exactly that before it reaps.
      expect(prov.ownsSession(sessionKey)).toBe(true);
      expect(prov.hasBackgroundWork(sessionKey)).toBe(true);
      expect(prov.isTurnProcessAlive(sessionKey)).toBe(false);

      // The Monitor ticks: the CLI wakes itself, and somebody is listening.
      const wakes: string[] = [];
      let done = null as string | null;
      ProviderCtor.observeWokenTurns((sk: string) => {
        wakes.push(sk);
        const h = makeHandler();
        h.handler.onDone = (r: { result?: string }) => { done = r?.result ?? ""; };
        prov.adoptWokenTurn(sk, h.handler);
      });
      writeFileSync(trigger, "");
      await waitFor(() => done !== null, 10_000);
      expect(wakes).toEqual([sessionKey]);
      expect(String(done)).toBe(String(events[wakeEnd]!.result));
    } finally {
      ProviderCtor.observeWokenTurns(() => {});
      try { getAiBridgeClient().kill(sessionKey); } catch { /* best-effort cleanup */ }
    }
  }, 40_000);

  test("two probes at once: the session is kept once and the wake is still heard", async () => {
    // The boot sweep and a /api/chat probe can ask about the same key together.
    // Each used to scan with its own attach; the second, finding the first one
    // kept, tore its scan down by KEY and detached the kept one with it.
    const events = recordedBackgroundSession();
    const firstResult = events.findIndex((e) => e.type === "result");
    const nextInit = events.findIndex((e, i) => i > firstResult && e.type === "system" && e.subtype === "init");
    const wakeEnd = events.findIndex((e, i) => i > nextInit && e.type === "result");
    const before = join(tempDir, "bg2-before.ndjson");
    const wake = join(tempDir, "bg2-wake.ndjson");
    const trigger = join(tempDir, "bg2-wake.go");
    writeFileSync(before, events.slice(0, nextInit).map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(wake, events.slice(nextInit, wakeEnd + 1).map((e) => JSON.stringify(e)).join("\n") + "\n");
    const cli = join(tempDir, "fake-bgstore2.sh");
    writeFileSync(cli, `#!/bin/sh\nread line\ncat '${before}'\nwhile [ ! -f '${trigger}' ]; do sleep 0.05; done\ncat '${wake}'\nsleep 30\n`);
    chmodSync(cli, 0o755);
    setEnv("TOPICS_CLAUDE_CLI_PATH", cli);

    const sessionKey = "topic:boot-bg-twice";
    await seedSurvivingSession(sessionKey, "t-boot-bg-twice");
    const prov = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    try {
      expect(await Promise.all([prov.brokerTurnState(sessionKey, { park: true }), prov.brokerTurnState(sessionKey)])).toEqual(["idle", "idle"]);
      expect(prov.hasBackgroundWork(sessionKey)).toBe(true);
      const wakes: string[] = [];
      let done = null as string | null;
      ProviderCtor.observeWokenTurns((sk: string) => {
        wakes.push(sk);
        const h = makeHandler();
        h.handler.onDone = (r: { result?: string }) => { done = r?.result ?? ""; };
        prov.adoptWokenTurn(sk, h.handler);
      });
      writeFileSync(trigger, "");
      await waitFor(() => done !== null, 10_000);
      expect(wakes).toEqual([sessionKey]);
    } finally {
      ProviderCtor.observeWokenTurns(() => {});
      try { getAiBridgeClient().kill(sessionKey); } catch { /* best-effort cleanup */ }
    }
  }, 40_000);

  /** A store written by the fake CLI and left there: `lines` then sleep. */
  function storeCli(name: string, lines: unknown[]): string {
    const body = join(tempDir, `${name}.ndjson`);
    writeFileSync(body, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const cli = join(tempDir, `${name}.sh`);
    writeFileSync(cli, `#!/bin/sh\nread line\ncat '${body}'\nsleep 30\n`);
    chmodSync(cli, 0o755);
    return cli;
  }

  test("a restart between the last report and the wake's first word: the wake is a turn in flight, not an idle child", async () => {
    // The CLI prints the empty snapshot BEFORE the notification and the wake
    // that answers it (fixture lines 268-272). Ending there, the store has no
    // line of the model yet, only its `system/init`.
    const events = recordedBackgroundSession();
    const lastInit = events.findLastIndex((e) => e.type === "system" && e.subtype === "init");
    setEnv("TOPICS_CLAUDE_CLI_PATH", storeCli("bg-final-wake", events.slice(0, lastInit + 1)));
    const sessionKey = "topic:boot-bg-final";
    await seedSurvivingSession(sessionKey, "t-boot-bg-final");
    const prov = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    try {
      expect(prov.hasBackgroundWork(sessionKey)).toBe(false);
      expect(await prov.brokerTurnState(sessionKey)).toBe("open");
    } finally {
      try { getAiBridgeClient().kill(sessionKey); } catch { /* best-effort cleanup */ }
    }
  }, 40_000);

  test("a /compact that already ended is not a turn in flight", async () => {
    const lines = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok" },
      { type: "system", subtype: "init", session_id: "s" },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 1000 } },
      { type: "result", subtype: "success", is_error: false, num_turns: 0, result: "" },
    ];
    setEnv("TOPICS_CLAUDE_CLI_PATH", storeCli("compact-over", lines));
    const sessionKey = "topic:boot-compact-over";
    await seedSurvivingSession(sessionKey, "t-boot-compact-over");
    const prov = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    try {
      expect(await prov.brokerTurnState(sessionKey)).toBe("idle");
    } finally {
      try { getAiBridgeClient().kill(sessionKey); } catch { /* best-effort cleanup */ }
    }
  }, 40_000);

  test("news replayed at boot is dated by the child's last write, so a job silent for hours is not kept", async () => {
    // Without the daemon's clock every restart re-dated the snapshot to "now",
    // and a task that stopped reporting hours ago survived every restart.
    const events = recordedBackgroundSession();
    const firstResult = events.findIndex((e) => e.type === "result");
    setEnv("TOPICS_CLAUDE_CLI_PATH", storeCli("bg-stale", events.slice(0, firstResult + 1)));
    const sessionKey = "topic:boot-bg-stale";
    await seedSurvivingSession(sessionKey, "t-boot-bg-stale");
    const { getAiBridgeClient } = await import("../lib/ai-bridge-client");
    const bridge = getAiBridgeClient() as any;
    const vero = bridge.attach.bind(bridge);
    try {
      // The real daemon reports the true last write: fresh, so it is kept.
      const fresh = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
      expect(await fresh.brokerTurnState(sessionKey)).toBe("idle");
      expect(fresh.hasBackgroundWork(sessionKey)).toBe(true);
      fresh.stop();
      // Written forty minutes ago: a long silent job, alive for every clock, and
      // kept as the session's process, so the boot's reap leaves it alone.
      bridge.attach = async (id: string, from: number) => ({ ...(await vero(id, from)), lastDataAt: Date.now() - 40 * 60_000 });
      const quiet = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
      expect(await quiet.brokerTurnState(sessionKey)).toBe("idle");
      expect(quiet.ownsSession(sessionKey)).toBe(true);
      expect(quiet.hasBackgroundWork(sessionKey)).toBe(true);
      quiet.stop();
      // The same store, last written three hours ago.
      bridge.attach = async (id: string, from: number) => ({ ...(await vero(id, from)), lastDataAt: Date.now() - 3 * 60 * 60_000 });
      const late = new ProviderCtor({ type: "claude-code", defaultWorkspace: tempDir });
      expect(await late.brokerTurnState(sessionKey)).toBe("idle");
      expect(late.hasBackgroundWork(sessionKey)).toBe(false);
      expect((late as any).processes.has(sessionKey)).toBe(false);
    } finally {
      bridge.attach = vero;
      try { bridge.kill(sessionKey); } catch { /* best-effort cleanup */ }
    }
  }, 40_000);
});
