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
    const keyDopo = "topic:boot-replay-dopo";
    const storePrima = await seedSurvivingSession(keyPrima, "t-boot-prima");
    const storeDopo = await seedSurvivingSession(keyDopo, "t-boot-dopo");
    // Stesso figlio, stesso copione: gli store DEVONO essere identici, o i byte
    // delle due vie non sarebbero confrontabili.
    expect(storeDopo).toBe(storePrima);
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
      expect(await provDopo.brokerTurnState(keyDopo, { park: true })).toBe("open");
      const hDopo = makeHandler();
      const driveDopo = provDopo.reattach(keyDopo, hDopo.handler);
      driveDopo.catch(() => {});
      await waitFor(() => suDi(keyDopo).length >= 2, 10_000);

      // La misura, PRIMA delle asserzioni: quando la barra è rossa i numeri
      // sono la diagnosi, e un log che non esce perché l'expect è saltato
      // prima non serve a nessuno.
      const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
      console.log(
        `[misura] store ${kb(storePrima)} · PRIMA ${replayIntegraliDi(keyPrima)} replay integrali, ` +
        `${suDi(keyPrima).length} attach, ${kb(byteDi(keyPrima))} · ` +
        `DOPO ${replayIntegraliDi(keyDopo)} replay integrali, ${suDi(keyDopo).length} attach, ${kb(byteDi(keyDopo))} ` +
        `(−${(100 * (1 - byteDi(keyDopo) / byteDi(keyPrima))).toFixed(0)}%)`,
      );

      // LA BARRA. Prima: due replay integrali (sonda + fase 1) più l'attach
      // mirato della fase 2. Dopo: UNO solo, più lo stesso attach mirato.
      expect(replayIntegraliDi(keyPrima)).toBe(2);
      expect(replayIntegraliDi(keyDopo)).toBe(1);
      expect(suDi(keyPrima).length).toBe(3);
      expect(suDi(keyDopo).length).toBe(2);

      // E in byte: la differenza è ESATTAMENTE un intero store, non un'inezia.
      expect(byteDi(keyPrima) - byteDi(keyDopo)).toBe(storePrima);
      // La fase 2 resta mirata su entrambe le vie: riparte da dopo l'ultimo
      // `result`, non da zero (altrimenti il risparmio se lo mangerebbe lei).
      const fase2Dopo = suDi(keyDopo).find((a) => a.from > 0);
      expect(fase2Dopo).toBeDefined();
      expect(fase2Dopo!.bytes).toBeLessThan(storeDopo / 4);

      // Il parcheggio non lascia niente dietro: lo scan è stato RECLAMATO dalla
      // riadozione, non è rimasto attaccato in un angolo.
      expect((provDopo as any).parkedScans.size).toBe(0);
    } finally {
      bridge.attach = vero;
      for (const k of [keyPrima, keyDopo]) { try { bridge.kill(k); } catch { /* pulizia best-effort */ } }
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
