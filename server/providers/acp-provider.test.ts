/**
 * AcpProvider contro un agente ACP VERO (finto, ma un processo).
 *
 * Il finto agente è `acp/fake-agent.fixture.ts`, lanciato con `bun`: così il
 * test attraversa spawn, env, framing su stdio e morte del figlio — cioè i
 * pezzi che in un'integrazione su stdio si rompono davvero. Un peer in-process
 * proverebbe solo la parte che già sappiamo giusta.
 *
 * @covers THINK-01
 */
import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase, getDatabase } from "../db";
import { AcpProvider, type AcpProviderConfig } from "./acp";
import { readProviderSession, writeProviderSession } from "./acp/session-store";
import { newTranslateState } from "./acp/translate";
import { engineCommandsFor, resetCliSlashCommands } from "../lib/slash-command-source";
// `sessionHasPendingSend` is new: through the namespace, so the file still loads
// on the code before it and only its own test fails.
import * as registry from "./index";
import type { ProviderDoneMessage, StreamHandler, ToolArgs } from "./types";

const FAKE_AGENT = join(import.meta.dir, "acp", "fake-agent.fixture.ts");

let tmpRoot: string;
const live: AcpProvider[] = [];

function makeProvider(overrides: Partial<AcpProviderConfig> = {}): AcpProvider {
  const p = new AcpProvider({
    type: "acp",
    name: "finto",
    command: process.execPath, // bun: contiene "/" quindi si usa così com'è
    args: [FAKE_AGENT],
    defaultWorkspace: tmpRoot,
    ...overrides,
  });
  live.push(p);
  p.start();
  return p;
}

/** Raccoglie tutto ciò che il provider spinge verso la chat. */
function recorder() {
  const text: string[] = [];
  const thinking: string[] = [];
  const tools: Array<{ id: string; name: string; args?: ToolArgs }> = [];
  const toolArgs: Array<{ id: string; args: ToolArgs }> = [];
  const results: Array<{ id: string; result: string; isError?: boolean }> = [];
  const context: Array<{ tokens: number; model?: string; window?: number }> = [];
  const done: ProviderDoneMessage[] = [];
  const aborted: ProviderDoneMessage[] = [];
  const errors: string[] = [];
  const handler: StreamHandler = {
    onTextDelta: (chunk) => text.push(chunk),
    onThinkingDelta: (chunk) => thinking.push(chunk),
    onToolStart: (id, name, args) => tools.push({ id, name, args }),
    onToolArgsUpdate: (id, args) => toolArgs.push({ id, args }),
    onToolResult: (id, result, isError) => results.push({ id, result, isError }),
    onContextSize: (tokens, model, window) => context.push({ tokens, model, window }),
    onDone: (m) => done.push(m ?? {}),
    onAborted: (m) => aborted.push(m ?? {}),
    onError: (e) => errors.push(e),
  };
  return { handler, text, thinking, tools, toolArgs, results, context, done, aborted, errors,
    get full() { return text.join(""); } };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "acp-provider-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
    initDatabase(tmpRoot);
});

afterEach(() => {
  while (live.length) live.pop()!.stop();
});

afterAll(() => {
  try { closeDatabase(); } catch { /* già chiuso */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* già sparito */ }
});

describe("turno normale", () => {
  test("il testo arriva alla chat e il turno finisce con end_turn", async () => {
    const provider = makeProvider();
    const rec = recorder();
    await provider.sendChat("topic:1", "ciao", rec.handler);
    expect(rec.errors).toEqual([]);
    expect(rec.full).toContain("ciao");
    expect(rec.done).toHaveLength(1);
    expect(rec.done[0]!.turnEnd).toEqual({ end: "end_turn" });
    expect(rec.done[0]!.result).toBe(rec.full);
  });

  test("il pensiero NON finisce nel testo (non va trascritto)", async () => {
    const provider = makeProvider();
    const rec = recorder();
    await provider.sendChat("topic:think", "THINK e rispondi", rec.handler);
    expect(rec.thinking).toEqual(["rifletto"]);
    expect(rec.full).not.toContain("rifletto");
  });

  test("una tool call diventa riga con titolo leggibile + risultato", async () => {
    const provider = makeProvider();
    const rec = recorder();
    await provider.sendChat("topic:tool", "TOOL", rec.handler);
    expect(rec.tools).toEqual([
      { id: "call-1", name: "Leggo la configurazione", args: { path: "/etc/hosts", kind: "read" } },
    ]);
    expect(rec.results).toEqual([{ id: "call-1", result: "127.0.0.1 localhost", isError: false }]);
  });

  test("usage_update → onContextSize con nome del provider e finestra dichiarata", async () => {
    const provider = makeProvider();
    const rec = recorder();
    await provider.sendChat("topic:usage", "USAGE", rec.handler);
    expect(rec.context).toEqual([{ tokens: 12_345, model: "finto", window: 200_000 }]);
  });

  test("un rifiuto dell'agente arriva come tale, non come errore generico", async () => {
    const provider = makeProvider();
    const rec = recorder();
    await provider.sendChat("topic:refuse", "REFUSE", rec.handler);
    expect(rec.errors).toEqual([]);
    expect(rec.done[0]!.turnEnd).toEqual({ end: "refusal" });
  });
});

describe("permessi", () => {
  test("una richiesta di permesso si concede (scelta del piano), e l'agente prosegue", async () => {
    const provider = makeProvider();
    const rec = recorder();
    await provider.sendChat("topic:perm", "PERM", rec.handler);
    // L'agente ci rimanda l'optionId scelto: deve essere il più permissivo offerto.
    expect(rec.full).toContain("perm:sempre");
    expect(rec.done[0]!.turnEnd).toEqual({ end: "end_turn" });
  });
});

describe("sessione", () => {
  test("due turni nella stessa chat riusano la STESSA sessione dell'agente", async () => {
    const provider = makeProvider();
    const a = recorder();
    const b = recorder();
    await provider.sendChat("topic:reuse", "primo", a.handler);
    await provider.sendChat("topic:reuse", "secondo", b.handler);
    const idA = a.full.match(/\[(sess-\d+)\//)?.[1];
    const idB = b.full.match(/\[(sess-\d+)\//)?.[1];
    expect(idA).toBeTruthy();
    expect(idB).toBe(idA!);
  });

  test("/clear forgets the agent session: the next prompt opens a NEW one (CMD-09)", async () => {
    const provider = makeProvider();
    const a = recorder();
    await provider.sendChat("topic:clear", "primo", a.handler);
    const before = a.full.match(/\[(sess-\d+)\//)?.[1];
    expect(before).toBeTruthy();

    await provider.resetSession("topic:clear");
    expect(readProviderSession(getDatabase(), "finto", "topic:clear"), "the id on disk would bring it back with session/load").toBeNull();

    const b = recorder();
    await provider.sendChat("topic:clear", "dopo il clear", b.handler);
    const after = b.full.match(/\[(sess-\d+)\//)?.[1];
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    expect(b.full).toContain("/new]");
  });

  test("chat diverse → sessioni diverse", async () => {
    const provider = makeProvider();
    const a = recorder();
    const b = recorder();
    await provider.sendChat("topic:x", "uno", a.handler);
    await provider.sendChat("topic:y", "due", b.handler);
    expect(a.full.match(/\[(sess-\d+)\//)?.[1]).not.toBe(b.full.match(/\[(sess-\d+)\//)?.[1]);
  });

  test("l'id finisce su disco: è ciò che sopravvive al riavvio del server", async () => {
    const provider = makeProvider();
    const rec = recorder();
    await provider.sendChat("topic:persist", "ciao", rec.handler);
    const row = readProviderSession(getDatabase(), "finto", "topic:persist");
    expect(row?.providerSessionId).toBe(rec.full.match(/\[(sess-\d+)\//)?.[1]);
    expect(row?.cwd).toBe(tmpRoot);
  });

  test("dopo un riavvio la sessione ricordata si RICARICA invece di ripartire vuota", async () => {
    const first = makeProvider();
    const a = recorder();
    await first.sendChat("topic:reload", "ciao", a.handler);
    const id = a.full.match(/\[(sess-\d+)\//)?.[1];
    first.stop();

    const second = makeProvider(); // processo nuovo, memoria solo su disco
    const b = recorder();
    await second.sendChat("topic:reload", "di nuovo", b.handler);
    expect(b.full).toContain(`[${id}/loaded]`);
  });

  test("una sessione ricordata ma ILLEGGIBILE per l'agente non blocca la chat", async () => {
    writeProviderSession(getDatabase(), "finto", "topic:rotta", "non-esiste", tmpRoot);
    const provider = makeProvider();
    const rec = recorder();
    await provider.sendChat("topic:rotta", "ciao", rec.handler);
    expect(rec.errors).toEqual([]);
    expect(rec.full).toContain("/new]"); // ne ha aperta una nuova
    expect(readProviderSession(getDatabase(), "finto", "topic:rotta")!.providerSessionId).not.toBe("non-esiste");
  });

  test("cwd cambiata → sessione nuova, non la vecchia nella cartella sbagliata", async () => {
    const other = join(tmpRoot, "altrove");
    mkdirSync(other, { recursive: true });
    writeProviderSession(getDatabase(), "finto", "topic:moved", "sess-999", other);
    const provider = makeProvider();
    const rec = recorder();
    await provider.sendChat("topic:moved", "ciao", rec.handler);
    expect(rec.full).toContain("/new]");
    expect(readProviderSession(getDatabase(), "finto", "topic:moved")!.cwd).toBe(tmpRoot);
  });
});

/**
 * Attende che il turno lento sia DAVVERO cominciato, invece di dormire.
 *
 * Il fixture manda `slow:started` appena entra nel ramo SLOW (vedi
 * `acp/fake-agent.fixture.ts`). Prima qui c'era `await Bun.sleep(150)` col
 * commento "il tempo che la sessione esista davvero": sotto carico 150ms non
 * bastano, l'abort partiva prima della sessione e il turno finiva con
 * ACP_PROVIDER_STOPPED invece di `cancelled` — due test che fallivano a caso.
 * Aspettare la condizione invece del tempo li rende deterministici.
 */
async function untilSlowStarted(rec: { full: string }, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!rec.full.includes("slow:started")) {
    if (Date.now() > deadline) throw new Error("il turno lento non e' mai partito");
    await Bun.sleep(2);
  }
}

describe("stop e morte", () => {
  test("abort → cancelled con la causa giusta, e passa da onAborted non da onError", async () => {
    const provider = makeProvider();
    const rec = recorder();
    const turn = provider.sendChat("topic:slow", "SLOW", rec.handler);
    await untilSlowStarted(rec);
    await provider.abort("topic:slow", undefined, "user");
    await turn;
    expect(rec.errors).toEqual([]);
    expect(rec.done).toEqual([]);
    expect(rec.aborted).toHaveLength(1);
    expect(rec.aborted[0]!.turnEnd).toEqual({ end: "cancelled", cause: "user" });
  });

  test("a prompt sent right after a Stop waits for the stopped one to answer, and takes nothing of its tail (CHAT-QUEUE-07)", async () => {
    // The agent answers a cancel with the tail of what it was writing. Sent at
    // once, the next prompt ran beside the stopped one and that tail landed in
    // the new turn's row: `state.handler` was already the new one.
    const provider = makeProvider();
    const first = recorder();
    const turn = provider.sendChat("topic:linger", "SLOW LINGER", first.handler);
    await untilSlowStarted(first);
    await provider.abort("topic:linger", undefined, "user");
    const second = recorder();
    await provider.sendChat("topic:linger", "next", second.handler);
    await turn;
    expect(second.full).not.toContain("linger:tail");
    expect(second.full).toContain("next");
    expect(first.full).toContain("linger:tail");
    expect(first.aborted[0]!.turnEnd).toEqual({ end: "cancelled", cause: "user" });
  });

  test("a prompt waiting for the stopped one, stopped in turn, is never sent", async () => {
    const provider = makeProvider();
    const first = recorder();
    const turn = provider.sendChat("topic:linger2", "SLOW LINGER", first.handler);
    await untilSlowStarted(first);
    await provider.abort("topic:linger2", undefined, "user");
    const second = recorder();
    const waiting = provider.sendChat("topic:linger2", "never", second.handler);
    await provider.abort("topic:linger2", undefined, "user");
    expect(await waiting).toEqual({ notSent: true });
    await turn;
    expect(second.full).toBe("");
    expect(second.done).toEqual([]);
  });

  test("uno stop del watchdog NON si traveste da stop umano", async () => {
    const provider = makeProvider();
    const rec = recorder();
    const turn = provider.sendChat("topic:slow2", "SLOW", rec.handler);
    await untilSlowStarted(rec);
    await provider.abort("topic:slow2", undefined, "watchdog");
    await turn;
    expect(rec.aborted[0]!.turnEnd).toEqual({ end: "cancelled", cause: "watchdog" });
  });

  test("a cancel nobody asked for carries no cause: it is not a person's Stop", async () => {
    // With `cause: "user"` here the chat route logs «stream aborted by user»,  allow-italian: quotes the log title
    // and the resume sweep reads that line as the person having pressed Stop.
    const provider = makeProvider();
    const rec = recorder();
    await provider.sendChat("topic:selfcancel", "SELFCANCEL", rec.handler);
    expect(rec.errors).toEqual([]);
    expect(rec.aborted).toHaveLength(1);
    expect(rec.aborted[0]!.turnEnd).toEqual({ end: "cancelled" });
  });

  test("a turn past the 30-minute cap cancels the prompt still running in the agent", async () => {
    // The cap closed the turn in error and left the prompt alive in the agent:
    // no `session/cancel`, so it kept running tools for a turn the chat showed
    // as over, and its updates kept landing in that closed turn's row.
    const realSetTimeout = globalThis.setTimeout;
    const PROMPT_CAP_MS = 30 * 60 * 1000;
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
      realSetTimeout(fn, ms === PROMPT_CAP_MS ? 300 : ms, ...rest)) as typeof setTimeout;
    try {
      const provider = makeProvider();
      const rec = recorder();
      const turn = provider.sendChat("topic:cap", "SLOW LINGER", rec.handler);
      await untilSlowStarted(rec);
      await turn;
      expect(rec.errors.join("\n")).toContain("ACP_PROMPT_TIMEOUT");
      const state = (provider as unknown as { sessions: Map<string, { prompt?: Promise<unknown> }> }).sessions.get("topic:cap")!;
      // The agent answers the cancel (after its tail): the prompt settles.
      const deadline = Date.now() + 3_000;
      while (state.prompt && Date.now() < deadline) await Bun.sleep(10);
      expect(state.prompt).toBeUndefined();
      // The tail of a turn already closed in error does not reach its row.
      expect(rec.full).not.toContain("linger:tail");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("il processo che muore a metà turno diventa un errore, non una promise appesa", async () => {
    const provider = makeProvider();
    const rec = recorder();
    await provider.sendChat("topic:crash", "CRASH", rec.handler);
    expect(rec.done).toEqual([]);
    expect(rec.errors).toHaveLength(1);
    expect(rec.errors[0]).toContain("PROCESS_DIED");
  });

  test("dopo la morte, il turno successivo riparte con un processo nuovo", async () => {
    const provider = makeProvider();
    await provider.sendChat("topic:crash2", "CRASH", recorder().handler);
    const rec = recorder();
    await provider.sendChat("topic:dopo", "ciao", rec.handler);
    expect(rec.errors).toEqual([]);
    expect(rec.done[0]!.turnEnd).toEqual({ end: "end_turn" });
  });

  test("isTurnProcessAlive segue il processo, non la sessione", async () => {
    const provider = makeProvider();
    expect(provider.isTurnProcessAlive("topic:1")).toBe(false);
    await provider.sendChat("topic:1", "ciao", recorder().handler);
    expect(provider.isTurnProcessAlive("topic:1")).toBe(true);
    provider.stop();
    expect(provider.isTurnProcessAlive("topic:1")).toBe(false);
  });
});

/** Every notification the provider sends to the agent, from now on. */
function notifications(provider: AcpProvider): Array<{ method: string; params: Record<string, unknown> }> {
  const peer = (provider as unknown as { peer: { notify: (m: string, p: Record<string, unknown>) => void } }).peer;
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
  const real = peer.notify.bind(peer);
  peer.notify = (method, params) => { seen.push({ method, params }); real(method, params); };
  return seen;
}

describe("/clear during a running prompt (CMD-09)", () => {
  test("cancels the prompt still running in the agent", async () => {
    const provider = makeProvider();
    const first = recorder();
    const turn = provider.sendChat("topic:clearbusy", "SLOW", first.handler);
    await untilSlowStarted(first);
    const sent = notifications(provider);

    await provider.resetSession("topic:clearbusy");
    expect(sent.map((n) => n.method), "the agent kept working on a cleared conversation").toContain("session/cancel");
    const outcome = await Promise.race([turn.then(() => "settled"), Bun.sleep(2_000).then(() => "still running")]);
    expect(outcome).toBe("settled");
    expect(first.aborted[0]?.turnEnd).toEqual({ end: "cancelled", cause: "user" });
  });

  test("drops the send queued behind it: it never reaches the fresh session", async () => {
    const provider = makeProvider();
    const first = recorder();
    const turn = provider.sendChat("topic:clearqueue", "SLOW LINGER", first.handler);
    await untilSlowStarted(first);
    const second = recorder();
    const waiting = provider.sendChat("topic:clearqueue", "queued", second.handler);

    await provider.resetSession("topic:clearqueue");
    const outcome = await Promise.race([waiting, Bun.sleep(2_000).then(() => "still waiting")]);
    expect(outcome).toEqual({ notSent: true });
    await turn;
    expect(second.full).toBe("");
    expect(second.done).toEqual([]);
  });
});

describe("complete (fuori dalla chat)", () => {
  test("gira su una sessione usa-e-getta: non sporca il contesto del turno vero", async () => {
    const provider = makeProvider();
    const rec = recorder();
    await provider.sendChat("topic:titolo", "conversazione", rec.handler);
    const chatSession = rec.full.match(/\[(sess-\d+)\//)?.[1];

    const out = await provider.complete([{ role: "user", content: "dammi un titolo" }]);
    const usedSession = out.content.match(/\[(sess-\d+)\//)?.[1];
    expect(out.content).toContain("dammi un titolo");
    expect(usedSession).toBeTruthy();
    expect(usedSession).not.toBe(chatSession);
  });

  test("at its 30-minute cap it cancels the prompt in the agent, as a chat turn does", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const PROMPT_CAP_MS = 30 * 60 * 1000;
    const provider = makeProvider();
    await provider.sendChat("topic:warm", "ciao", recorder().handler);
    const sent = notifications(provider);
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
      realSetTimeout(fn, ms === PROMPT_CAP_MS ? 300 : ms, ...rest)) as typeof setTimeout;
    try {
      await expect(provider.complete([{ role: "user", content: "SLOW" }])).rejects.toThrow("ACP_PROMPT_TIMEOUT");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    const cancel = sent.find((n) => n.method === "session/cancel");
    expect(cancel, "the throwaway session kept running in the agent").toBeTruthy();
    expect(typeof cancel!.params.sessionId).toBe("string");
  });
});

describe("diagnostica", () => {
  test("con l'eseguibile al suo posto è pronto, anche prima dell'handshake", async () => {
    const provider = makeProvider();
    const d = await provider.diagnose();
    expect(d.name).toBe("finto");
    expect(d.status).toBe("ready");
    expect(provider.connected).toBe(true);
    expect(d.requirements.find((r) => r.key === "finto-handshake")?.present).toBe(false);
  });

  test("dopo il primo turno l'handshake risulta fatto", async () => {
    const provider = makeProvider();
    await provider.sendChat("topic:1", "ciao", recorder().handler);
    const d = await provider.diagnose();
    expect(d.requirements.find((r) => r.key === "finto-handshake")?.present).toBe(true);
  });

  test("eseguibile assente → unavailable, con il suggerimento su ACP_AGENTS", async () => {
    const provider = makeProvider({ command: "questo-agente-non-esiste-42", args: [] });
    const d = await provider.diagnose();
    expect(d.status).toBe("unavailable");
    expect(provider.connected).toBe(false);
    expect(d.requirements[0]!.hint).toContain("ACP_AGENTS");
  });

  test("eseguibile assente → il turno fallisce SUBITO con un motivo leggibile", async () => {
    const provider = makeProvider({ command: "questo-agente-non-esiste-42", args: [] });
    const rec = recorder();
    await provider.sendChat("topic:1", "ciao", rec.handler);
    expect(rec.errors[0]).toContain("ACP_BINARY_NOT_FOUND");
  });

  test("listModels è vuoto finché non si è parlato con l'agente", async () => {
    // Non è pigrizia: prima di una sessione non abbiamo NIENTE di suo da
    // riportare, e riempire la lista di ipotesi sarebbe inventarla.
    expect(await makeProvider().listModels()).toEqual([]);
  });

  test("dopo una sessione, listModels riporta i modelli che l'agente ha annunciato", async () => {
    const provider = makeProvider();
    await provider.sendChat("topic:models", "ciao", recorder().handler);
    expect(await provider.listModels()).toEqual([
      "modello-di-fabbrica",
      "modello-piccolo",
      "modello-grosso",
    ]);
  });

  test("la strategia di contesto è inline-system: la storia la tiene l'agente", () => {
    const provider = makeProvider();
    expect(provider.contextStrategy).toBe("inline-system");
    expect(provider.capabilities.has("history")).toBe(false);
    expect(provider.capabilities.has("sessions")).toBe(true);
  });

  test("solo jcode dichiara l'esecuzione dei task di coding", () => {
    expect(makeProvider({ name: "gemini" }).capabilities.has("coding-tasks")).toBe(false);
    expect(makeProvider({ name: "jcode" }).capabilities.has("coding-tasks")).toBe(true);
  });
});

/**
 * Il modello CHIESTO deve arrivare all'agente.
 *
 * Perché è un blocco a sé. Su Topics il modello si sceglie PER TASK, ed è una
 * leva di costo: un typo su un modello grosso e un refactor sullo stesso
 * modello non costano uguale, e la board lo sa. Il provider ACP però riceveva
 * `options.model` e lo buttava via — il turno riusciva lo stesso, sul modello
 * di default dell'agente, e nessuno se ne accorgeva. Un errore che non dà
 * errore: esattamente la categoria che questi test esistono per prendere.
 *
 * Si chiede all'AGENTE su che modello è finito (`debug/model`), non al
 * provider: chiedere al provider vorrebbe dire farsi confermare da chi ha
 * scritto la richiesta che la richiesta è partita.
 */
describe("il modello per task arriva all'agente", () => {
  /**
   * Su che modello è l'agente adesso, e quante volte gliel'hanno cambiato.
   *
   * Glielo si chiede con un TURNO NORMALE (`QUALEMODELLO`) sulla stessa
   * sessione, e la risposta arriva nel testo: è la stessa strada che fa una
   * chat vera. Il turno di domanda non chiede modelli, quindi non sporca il
   * conto dei cambi che sta misurando.
   */
  async function agentModel(
    provider: AcpProvider,
    sessionKey: string,
  ): Promise<{ current: string; calls: string[] }> {
    const rec = recorder();
    await provider.sendChat(sessionKey, "QUALEMODELLO", rec.handler);
    const m = /MODELLO=(\S*) CAMBI=(\S*)/.exec(rec.full);
    if (!m) throw new Error(`l'agente non ha detto il modello: ${rec.full}`);
    return { current: m[1]!, calls: m[2] ? m[2]!.split(",") : [] };
  }

  test("senza modello richiesto, l'agente resta sul suo: non gli si impone niente", async () => {
    const provider = makeProvider();
    await provider.sendChat("topic:m0", "ciao", recorder().handler);
    expect((await agentModel(provider, "topic:m0")).calls).toEqual([]);
  });

  test("il modello richiesto viene applicato PRIMA del prompt", async () => {
    const provider = makeProvider();
    await provider.sendChat("topic:m1", "ciao", recorder().handler, { model: "modello-piccolo" });
    const seen = await agentModel(provider, "topic:m1");
    expect(seen.current).toBe("modello-piccolo");
    expect(seen.calls).toEqual(["modello-piccolo"]);
  });

  test("stesso modello due turni di fila: non si richiede due volte", async () => {
    // Non è ottimizzazione: la sessione ACP vive in un demone condiviso e il
    // modello ci resta. Richiederlo a ogni prompt sarebbe un giro di rete per
    // turno per non cambiare niente.
    const provider = makeProvider();
    await provider.sendChat("topic:m2", "uno", recorder().handler, { model: "modello-piccolo" });
    await provider.sendChat("topic:m2", "due", recorder().handler, { model: "modello-piccolo" });
    expect((await agentModel(provider, "topic:m2")).calls).toEqual(["modello-piccolo"]);
  });

  test("cambiare modello fra due turni della stessa chat funziona", async () => {
    const provider = makeProvider();
    await provider.sendChat("topic:m3", "uno", recorder().handler, { model: "modello-piccolo" });
    await provider.sendChat("topic:m3", "due", recorder().handler, { model: "modello-grosso" });
    const seen = await agentModel(provider, "topic:m3");
    expect(seen.current).toBe("modello-grosso");
    expect(seen.calls).toEqual(["modello-piccolo", "modello-grosso"]);
  });

  // I due rami di degrado. Il patto è lo stesso: un modello non applicato è un
  // turno che gira su un altro modello, cioè lavoro fatto — mai un turno morto.
  test("agente che non sa cambiare modello: il turno passa lo stesso", async () => {
    const provider = makeProvider({ env: { FAKE_ACP_NO_SET_MODEL: "1" } });
    const rec = recorder();
    await provider.sendChat("topic:m4", "ciao", rec.handler, { model: "modello-piccolo" });
    expect(rec.errors).toEqual([]);
    expect(rec.full).toContain("ciao");
    expect(rec.done).toHaveLength(1);
  });

  test("modello rifiutato per nome: il turno passa, e un ALTRO modello si può ancora chiedere", async () => {
    // La distinzione che conta: «non so cambiare modello» è dell'agente e vale
    // per sempre, «non ho QUESTO modello» è del nome e non deve chiudere la
    // porta al prossimo task che ne chiede un altro.
    const provider = makeProvider({ env: { FAKE_ACP_MODEL_REJECT: "modello-piccolo" } });
    const rec = recorder();
    await provider.sendChat("topic:m5", "uno", rec.handler, { model: "modello-piccolo" });
    expect(rec.errors).toEqual([]);
    await provider.sendChat("topic:m5", "due", recorder().handler, { model: "modello-grosso" });
    expect((await agentModel(provider, "topic:m5")).current).toBe("modello-grosso");
  });
});

/**
 * L'effort di ragionamento del topic arriva all'agente.
 *
 * È la leva più cara della board: sullo stesso lavoro `medium` ha misurato
 * 61,1k token e `xhigh` 108,8k. Su claude-code finisce nei flag di spawn; se il
 * percorso ACP la ignorasse, dispacciare su jcode toglierebbe il freno del
 * costo senza dirlo a nessuno.
 *
 * A differenza del modello NON arriva dalle opzioni del turno: sta sulla riga
 * del topic (migrazione 033), quindi qui la si scrive lì e si guarda se esce
 * dall'altra parte.
 */
describe("l'effort del topic arriva all'agente", () => {
  /** Scrive un topic con quell'effort, come farebbe la board. */
  function topicWithEffort(sessionKey: string, effort: string | null): void {
    const slug = sessionKey.replace(/[^a-z0-9]+/gi, "-");
    const now = new Date().toISOString();
    getDatabase()
      .prepare(
        "INSERT INTO topics (id, name, slug, session_key, effort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(`t-${sessionKey}`, sessionKey, slug, sessionKey, effort, now, now);
  }

  async function agentEffort(
    provider: AcpProvider,
    sessionKey: string,
  ): Promise<{ current: string; calls: string[] }> {
    const rec = recorder();
    await provider.sendChat(sessionKey, "QUALEFFORT", rec.handler);
    const m = /EFFORT=(\S*) CAMBI=(\S*)/.exec(rec.full);
    if (!m) throw new Error(`l'agente non ha detto l'effort: ${rec.full}`);
    return { current: m[1]!, calls: m[2] ? m[2]!.split(",") : [] };
  }

  test("topic senza effort: non si impone niente", async () => {
    topicWithEffort("topic:e0", null);
    const provider = makeProvider();
    await provider.sendChat("topic:e0", "ciao", recorder().handler);
    expect((await agentEffort(provider, "topic:e0")).calls).toEqual([]);
  });

  test("l'effort scritto sul topic viene applicato", async () => {
    topicWithEffort("topic:e1", "xhigh");
    const provider = makeProvider();
    await provider.sendChat("topic:e1", "ciao", recorder().handler);
    expect((await agentEffort(provider, "topic:e1")).current).toBe("xhigh");
  });

  test("non si richiede a ogni turno se non è cambiato", async () => {
    topicWithEffort("topic:e2", "medium");
    const provider = makeProvider();
    await provider.sendChat("topic:e2", "uno", recorder().handler);
    await provider.sendChat("topic:e2", "due", recorder().handler);
    expect((await agentEffort(provider, "topic:e2")).calls).toEqual(["medium"]);
  });

  test("agente che non sa cambiare effort: il turno passa lo stesso", async () => {
    topicWithEffort("topic:e3", "xhigh");
    const provider = makeProvider({ env: { FAKE_ACP_NO_SET_EFFORT: "1" } });
    const rec = recorder();
    await provider.sendChat("topic:e3", "ciao", rec.handler);
    expect(rec.errors).toEqual([]);
    expect(rec.done).toHaveLength(1);
  });

  test("effort rifiutato dal modello: passa, e non si insiste a ogni turno", async () => {
    // È il caso NORMALE su un modello senza thinking: jcode risponde picche, e
    // ripetere la richiesta (e l'avviso) a ogni prompt sarebbe rumore per una
    // preferenza che quel modello non può onorare.
    topicWithEffort("topic:e4", "xhigh");
    const provider = makeProvider({ env: { FAKE_ACP_EFFORT_REJECT: "xhigh" } });
    const rec = recorder();
    await provider.sendChat("topic:e4", "uno", rec.handler);
    await provider.sendChat("topic:e4", "due", recorder().handler);
    expect(rec.errors).toEqual([]);
    expect((await agentEffort(provider, "topic:e4")).calls).toEqual([]);
  });
});

/**
 * The resume sweep asks every provider whether a send is still in flight
 * before it resends (`sessionHasPendingSend`). ACP knew (`promptInFlight`)
 * and did not say, so a prompt still running behind a turn the watchdog had
 * closed looked idle.
 */
describe("a prompt in flight is a pending send", () => {
  test("true while the prompt runs, false once it ends and for an unknown chat", async () => {
    const provider = makeProvider();
    expect(await provider.hasPendingSend("topic:never-seen")).toBe(false);
    const rec = recorder();
    const turn = provider.sendChat("topic:pending", "SLOW", rec.handler);
    await untilSlowStarted(rec);
    expect(await provider.hasPendingSend("topic:pending")).toBe(true);
    await provider.abort("topic:pending", undefined, "watchdog");
    await turn;
    expect(await provider.hasPendingSend("topic:pending")).toBe(false);
  });

  test("the registry asks ACP too", async () => {
    registry.registerProvider({ type: "acp", name: "finto-registry", command: process.execPath, args: [FAKE_AGENT], defaultWorkspace: tmpRoot });
    try {
      const agent = registry.getProvider("finto-registry") as unknown as { sessions: Map<string, unknown> };
      agent.sessions.set("topic:acp-busy", { promptInFlight: true });
      expect(await registry.sessionHasPendingSend("topic:acp-busy")).toBe(true);
      expect(await registry.sessionHasPendingSend("topic:acp-idle")).toBe(false);
    } finally {
      registry.removeProvider("finto-registry");
    }
  });
});

/** @covers CMDUI-01 */
describe("the agent's commands are kept before any turn has a handler", () => {
  test("an announcement with no turn in flight still reaches the menu's list", () => {
    resetCliSlashCommands();
    // Not started: the session is planted as `session/new` leaves it, no handler yet.
    const p = new AcpProvider({ type: "acp", name: "finto-cmds", command: process.execPath, args: [FAKE_AGENT], defaultWorkspace: tmpRoot });
    const inner = p as unknown as {
      sessions: Map<string, unknown>;
      bySessionId: Map<string, string>;
      onSessionUpdate(params: Record<string, unknown>): void;
    };
    inner.sessions.set("topic:cmds", { acpSessionId: "s-cmds", cwd: "/p/acp", translate: newTranslateState(), fullText: "", promptInFlight: false, model: null, effort: null });
    inner.bySessionId.set("s-cmds", "topic:cmds");
    inner.onSessionUpdate({ sessionId: "s-cmds", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "models", description: "List models" }] } });
    expect(engineCommandsFor({ sessionKey: "topic:cmds", provider: "finto-cmds" })?.commands.map((c) => c.name)).toEqual(["models"]);
    resetCliSlashCommands();
  });
});
