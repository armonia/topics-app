/**
 * AcpProvider contro un agente ACP VERO (finto, ma un processo).
 *
 * Il finto agente è `acp/fake-agent.fixture.ts`, lanciato con `bun`: così il
 * test attraversa spawn, env, framing su stdio e morte del figlio — cioè i
 * pezzi che in un'integrazione su stdio si rompono davvero. Un peer in-process
 * proverebbe solo la parte che già sappiamo giusta.
 */
import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase, getDatabase } from "../db";
import { AcpProvider, type AcpProviderConfig } from "./acp";
import { readProviderSession, writeProviderSession } from "./acp/session-store";
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
  process.env.DATA_DIR = join(tmpRoot, "data");
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

  test("uno stop del watchdog NON si traveste da stop umano", async () => {
    const provider = makeProvider();
    const rec = recorder();
    const turn = provider.sendChat("topic:slow2", "SLOW", rec.handler);
    await untilSlowStarted(rec);
    await provider.abort("topic:slow2", undefined, "watchdog");
    await turn;
    expect(rec.aborted[0]!.turnEnd).toEqual({ end: "cancelled", cause: "watchdog" });
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

  test("listModels è vuoto: ACP v1 non li elenca, e inventarli sarebbe peggio", async () => {
    expect(await makeProvider().listModels()).toEqual([]);
  });

  test("la strategia di contesto è inline-system: la storia la tiene l'agente", () => {
    const provider = makeProvider();
    expect(provider.contextStrategy).toBe("inline-system");
    expect(provider.capabilities.has("history")).toBe(false);
    expect(provider.capabilities.has("sessions")).toBe(true);
  });
});
