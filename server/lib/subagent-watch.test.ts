/**
 * Il cursore incrementale del watcher dei sub-agent, e le sue guardie.
 *
 * Questi casi non esistevano — non potevano: la mappa delle sessioni, il timer
 * e il cursore in byte vivevano dentro la closure di `createTopicsRouter`, e da
 * fuori non c'era modo di far avanzare un giro di polling né di dargli un
 * transcript finto. Ora il modulo prende `transcriptDir` e espone `pollOnce`,
 * quindi la logica che decide COSA è già stato letto si può interrogare.
 *
 * Il provider finto NON è `openclaw`, così il recapito prende la strada del
 * risultato grezzo e nessun test tocca la rete.
 * @covers SUBAGENT-06, SUBAGENT-07
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, renameSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSubagentWatcher, extractTextContent, type SubagentWatcher } from "./subagent-watch";
import type { Topic, StoredMessage } from "../types";
import type { AIProvider } from "../providers";
import { createSubagentWake, type SubagentWakeRequest } from "../services/subagent-wake";

const SESSION_KEY = "topic:abc123";
const TOPIC_ID = "topic-abc123";

/** Una riga di transcript che annuncia la fine di un sub-agent. */
function completionLine(childKey: string, result: string, task = "fare la cosa"): string {
  const text =
    `[Internal task completion event]\n` +
    `session_key: agent:${childKey}\n` +
    `task: ${task}\n` +
    `<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>${result}<<<END_UNTRUSTED_CHILD_RESULT>>>`;
  return JSON.stringify({ message: { content: text } }) + "\n";
}

function harness(opts: { watchTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-watch-"));
  // Il nome che `findSessionJSONL` cerca: <sessionId>-<slug della chiave>.jsonl
  const jsonl = join(dir, `sess-${SESSION_KEY.replace(/:/g, "-")}.jsonl`);
  writeFileSync(jsonl, "");

  const topic = { id: TOPIC_ID, sessionKey: SESSION_KEY, name: "Chat" } as unknown as Topic;
  const appended: Array<{ sessionKey: string; content: string }> = [];
  const broadcasts: Array<Record<string, unknown>> = [];
  const unreadBumps: string[] = [];

  const watcher = createSubagentWatcher({
    gatewayUrl: "http://gateway.invalid",
    gatewayToken: "t",
    getTopicById: () => topic,
    getTopicBySessionKey: () => topic,
    saveSingleTopic: () => {},
    appendLocalMessage: (sessionKey, _role, content) => {
      appended.push({ sessionKey, content });
      return { id: `m${appended.length}`, role: "assistant", content, timestamp: "" } as StoredMessage;
    },
    broadcastToAll: (m) => { broadcasts.push(m as unknown as Record<string, unknown>); },
    bumpUnread: (id) => { unreadBumps.push(id); },
    // Non-openclaw ⇒ recapito grezzo, nessuna fetch.
    resolveProvider: () => ({ name: "anthropic" }) as unknown as AIProvider,
    transcriptDir: dir,
    pollIntervalMs: 60_000, // il timer non deve mai scattare da sé: comanda pollOnce
    watchTimeoutMs: opts.watchTimeoutMs,
  });

  return { dir, jsonl, watcher, appended, broadcasts, unreadBumps };
}

let live: SubagentWatcher | null = null;
let liveDir: string | null = null;
afterEach(() => {
  live?.stop();
  live = null;
  if (liveDir) rmSync(liveDir, { recursive: true, force: true });
  liveDir = null;
});

function start(opts: { watchTimeoutMs?: number } = {}) {
  const h = harness(opts);
  live = h.watcher;
  liveDir = h.dir;
  return h;
}

describe("createSubagentWatcher — cursore e recapito", () => {
  it("parte dalla FINE del file: la storia già scritta non viene ri-recapitata", () => {
    const h = start();
    writeFileSync(h.jsonl, completionLine("old", "risultato vecchio"));
    h.watcher.watch(TOPIC_ID, SESSION_KEY);
    h.watcher.pollOnce();
    expect(h.appended).toEqual([]);
  });

  it("recapita un evento aggiunto dopo l'inizio della sorveglianza", () => {
    const h = start();
    h.watcher.watch(TOPIC_ID, SESSION_KEY);
    appendFileSync(h.jsonl, completionLine("c1", "ho finito"));
    h.watcher.pollOnce();
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].sessionKey).toBe(SESSION_KEY);
    expect(h.appended[0].content).toContain("ho finito");
    expect(h.appended[0].content).toContain("fare la cosa");
    expect(h.unreadBumps).toEqual([TOPIC_ID]);
  });

  it("non rilegge ciò che ha già letto: un secondo giro a vuoto non recapita nulla", () => {
    const h = start();
    h.watcher.watch(TOPIC_ID, SESSION_KEY);
    appendFileSync(h.jsonl, completionLine("c1", "uno"));
    h.watcher.pollOnce();
    h.watcher.pollOnce();
    expect(h.appended).toHaveLength(1);
  });

  it("dedup per session_key del figlio: lo stesso evento due volte si recapita una volta", () => {
    const h = start();
    h.watcher.watch(TOPIC_ID, SESSION_KEY);
    appendFileSync(h.jsonl, completionLine("c1", "uno"));
    h.watcher.pollOnce();
    appendFileSync(h.jsonl, completionLine("c1", "uno di nuovo"));
    h.watcher.pollOnce();
    expect(h.appended).toHaveLength(1);
  });

  it("una riga finale a metà si riavvolge: si recapita quando è completa, non prima", () => {
    const h = start();
    h.watcher.watch(TOPIC_ID, SESSION_KEY);
    const full = completionLine("c1", "risultato intero");
    const cut = Math.floor(full.length / 2);
    appendFileSync(h.jsonl, full.slice(0, cut));
    h.watcher.pollOnce();
    expect(h.appended).toEqual([]); // JSON monco: non si consegna niente

    appendFileSync(h.jsonl, full.slice(cut));
    h.watcher.pollOnce();
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].content).toContain("risultato intero");
  });

  it("troncamento: se il file rimpicciolisce sotto il cursore si riparte da zero", () => {
    const h = start();
    h.watcher.watch(TOPIC_ID, SESSION_KEY);
    appendFileSync(h.jsonl, completionLine("c1", "primo") + completionLine("c2", "secondo"));
    h.watcher.pollOnce();
    expect(h.appended).toHaveLength(2);

    // Riscrittura più corta: il cursore è oltre la nuova fine.
    writeFileSync(h.jsonl, completionLine("c3", "dopo il troncamento"));
    h.watcher.pollOnce();
    expect(h.appended).toHaveLength(3);
    expect(h.appended[2].content).toContain("dopo il troncamento");
  });

  it("rotazione: un file NUOVO al posto del vecchio (inode diverso) si rilegge da capo", () => {
    const h = start();
    h.watcher.watch(TOPIC_ID, SESSION_KEY);
    appendFileSync(h.jsonl, completionLine("c1", "prima della rotazione"));
    h.watcher.pollOnce();
    expect(h.appended).toHaveLength(1);

    // Stesso path, inode diverso, e abbastanza lungo da NON essere un troncamento:
    // solo la guardia sull'inode può accorgersene.
    const rotated = `${h.jsonl}.new`;
    writeFileSync(rotated, completionLine("c2", "dopo la rotazione".padEnd(400, "!")));
    renameSync(rotated, h.jsonl);
    h.watcher.pollOnce();
    expect(h.appended).toHaveLength(2);
    expect(h.appended[1].content).toContain("dopo la rotazione");
  });

  it("le righe che non sono eventi di completamento si ignorano senza rumore", () => {
    const h = start();
    h.watcher.watch(TOPIC_ID, SESSION_KEY);
    appendFileSync(
      h.jsonl,
      JSON.stringify({ message: { content: "un messaggio qualunque" } }) + "\n" +
        "non è nemmeno JSON\n" +
        "\n" +
        completionLine("c1", "questo sì"),
    );
    h.watcher.pollOnce();
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].content).toContain("questo sì");
  });

  it("scaduto il tempo, la sessione smette di essere sorvegliata", () => {
    const h = start({ watchTimeoutMs: -1 }); // già scaduta al primo giro
    h.watcher.watch(TOPIC_ID, SESSION_KEY);
    expect(h.watcher.watchedCount()).toBe(1);
    appendFileSync(h.jsonl, completionLine("c1", "troppo tardi"));
    h.watcher.pollOnce();
    expect(h.watcher.watchedCount()).toBe(0);
    expect(h.appended).toEqual([]);
  });

  it("sorvegliare due volte la stessa sessione non la duplica", () => {
    const h = start();
    h.watcher.watch(TOPIC_ID, SESSION_KEY);
    h.watcher.watch(TOPIC_ID, SESSION_KEY);
    expect(h.watcher.watchedCount()).toBe(1);
  });
});

describe("extractTextContent", () => {
  it("passa attraverso una stringa", () => {
    expect(extractTextContent("ciao")).toBe("ciao");
  });

  it("concatena i soli blocchi di testo, saltando gli altri", () => {
    expect(
      extractTextContent([
        { type: "text", text: "uno" },
        { type: "tool_use", name: "Bash" },
        { type: "text", text: "due" },
      ]),
    ).toBe("uno\ndue");
  });

  it("su qualunque altra cosa torna stringa vuota invece di lanciare", () => {
    expect(extractTextContent(null)).toBe("");
    expect(extractTextContent(42)).toBe("");
    expect(extractTextContent({ text: "non è un array" })).toBe("");
  });
});

describe("deliverExit - the report of a spawn_agent child", () => {
  const outcome = { status: "completed" as const, partial: false, text: "Report: 3 files" };

  function exitWatcher() {
    const topic = { id: TOPIC_ID, sessionKey: SESSION_KEY, name: "Chat" } as unknown as Topic;
    const appended: string[] = [];
    const watcher = createSubagentWatcher({
      gatewayUrl: "http://gateway.invalid",
      gatewayToken: "t",
      getTopicById: () => topic,
      getTopicBySessionKey: () => topic,
      saveSingleTopic: () => {},
      appendLocalMessage: (_sk, _role, content) => {
        appended.push(content);
        return { id: `m${appended.length}`, role: "assistant", content, timestamp: "" } as StoredMessage;
      },
      broadcastToAll: () => {},
      bumpUnread: () => {},
      resolveProvider: () => ({ name: "anthropic" }) as unknown as AIProvider,
      pollIntervalMs: 60_000,
    });
    live = watcher;
    return { watcher, appended };
  }

  it("writes at once, and only once per child", () => {
    const { watcher, appended } = exitWatcher();
    watcher.deliverExit({ parentSessionKey: SESSION_KEY, childId: "c2", name: "lane-a", outcome, exitCode: 0 });
    watcher.deliverExit({ parentSessionKey: SESSION_KEY, childId: "c2", name: "lane-a", outcome, exitCode: 0 });
    expect(appended).toHaveLength(1);
  });
});

describe("deliverExit - one report per turn, and the wake (SUBAGENT-11, SUBAGENT-12)", () => {
  const completed = { status: "completed" as const, partial: false, text: "Report: 3 files" };

  function watcherWith(requestWake?: (r: SubagentWakeRequest) => void) {
    const topic = { id: TOPIC_ID, sessionKey: SESSION_KEY, name: "Chat" } as unknown as Topic;
    const rows: Array<{ content: string; blocks?: unknown }> = [];
    const watcher = createSubagentWatcher({
      gatewayUrl: "http://gateway.invalid",
      gatewayToken: "t",
      getTopicById: () => topic,
      getTopicBySessionKey: () => topic,
      saveSingleTopic: () => {},
      appendLocalMessage: (_sk, _role, content, _autore, blocks) => {
        rows.push({ content, blocks });
        return { id: `m${rows.length}`, role: "assistant", content, timestamp: "" } as StoredMessage;
      },
      broadcastToAll: () => {},
      bumpUnread: () => {},
      resolveProvider: () => ({ name: "anthropic" }) as unknown as AIProvider,
      pollIntervalMs: 60_000,
      ...(requestWake ? { requestWake } : {}),
    });
    live = watcher;
    return { watcher, rows };
  }

  it("a child steered into a second turn reports it too", () => {
    const { watcher, rows } = watcherWith();
    watcher.deliverExit({ parentSessionKey: SESSION_KEY, childId: "c3", name: "scout", outcome: completed, exitCode: null, turn: 1 });
    watcher.deliverExit({ parentSessionKey: SESSION_KEY, childId: "c3", name: "scout", outcome: completed, exitCode: null, turn: 2 });
    watcher.deliverExit({ parentSessionKey: SESSION_KEY, childId: "c3", name: "scout", outcome: completed, exitCode: null, turn: 2 });
    expect(rows).toHaveLength(2);
  });

  it("an early 'never arrived' does not swallow the turn's real end", () => {
    const { watcher, rows } = watcherWith();
    const undelivered = { status: "undelivered" as const, partial: false, text: "", reason: { code: "no-prompt" as const } };
    watcher.deliverExit({ parentSessionKey: SESSION_KEY, childId: "c4", name: "scout", outcome: undelivered, exitCode: null, turn: 1 });
    watcher.deliverExit({ parentSessionKey: SESSION_KEY, childId: "c4", name: "scout", outcome: completed, exitCode: null, turn: 1 });
    expect(rows).toHaveLength(2);
  });

  it("the row carries the card block, under the name the parent chose", () => {
    const { watcher, rows } = watcherWith();
    watcher.deliverExit({ parentSessionKey: SESSION_KEY, childId: "c5", name: "foglio-tab", outcome: completed, exitCode: null, model: "claude-sonnet-5-5" });
    expect(rows[0]!.content.startsWith('**Sotto-agente "foglio-tab", esito:**')).toBe(true);
    expect(rows[0]!.blocks).toEqual([{ kind: "subagent-result", results: [expect.objectContaining({ agentId: "c5", name: "foglio-tab", status: "completed", model: "claude-sonnet-5-5" })] }]);
  });

  it("a stop the parent asked for waits for the parent's own turn to end, then lands as a row and starts no turn", async () => {
    // The parent is inside its own stop_agent call: a row written now would be a
    // `message:new` in the middle of its turn, which the window owning that stream drops.
    let busy = true;
    const posted: string[] = [];
    const wake = createSubagentWake({
      debounceMs: 10, pollMs: 5, endGraceMs: 20,
      isBusy: () => busy,
      canWake: () => "wake",
      route: async (req) => { posted.push(((await req.json()) as { sessionKey: string }).sessionKey); return new Response("data: [DONE]\n\n"); },
    });
    let settled = 0;
    const { watcher, rows } = watcherWith((r) => wake.request(r));
    const byParent = { status: "stopped" as const, partial: true, text: "Mapping the call sites", reason: { code: "stopped-by-parent" as const } };
    watcher.deliverExit({ parentSessionKey: SESSION_KEY, childId: "c7", name: "scout", outcome: byParent, exitCode: null, settle: () => { settled++; } });
    expect(rows).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(rows).toHaveLength(0);
    expect(settled).toBe(0);
    busy = false;
    await wake.idle();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.blocks).toEqual([{ kind: "subagent-result", results: [expect.objectContaining({ agentId: "c7", status: "stopped", reason: { code: "stopped-by-parent" } })] }]);
    expect(settled).toBe(1);
    expect(posted).toEqual([]);
  });

  it("any other stop still wakes the parent", async () => {
    const asked: SubagentWakeRequest[] = [];
    const { watcher, rows } = watcherWith((r) => asked.push(r));
    const tabClosed = { status: "stopped" as const, partial: true, text: "Mapping the call sites", reason: { code: "tab-closed" as const } };
    watcher.deliverExit({ parentSessionKey: SESSION_KEY, childId: "c8", name: "scout", outcome: tabClosed, exitCode: null });
    expect(asked.map((r) => r.result.agentId)).toEqual(["c8"]);
    expect(rows).toHaveLength(0);
  });

  it("with the wake wired the result goes there, and no row is written at once", () => {
    const asked: SubagentWakeRequest[] = [];
    let settled = 0;
    const { watcher, rows } = watcherWith((r) => asked.push(r));
    watcher.deliverExit({ parentSessionKey: SESSION_KEY, childId: "c6", name: "scout", outcome: completed, exitCode: null, settle: () => { settled++; } });
    expect(rows).toHaveLength(0);
    expect(asked.map((r) => [r.parentSessionKey, r.result.agentId, r.result.turn])).toEqual([[SESSION_KEY, "c6", 1]]);
    asked[0]!.writeRow();
    asked[0]!.settle();
    expect(rows).toHaveLength(1);
    expect(settled).toBe(1);
  });
});
