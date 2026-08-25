/**
 * «Una chiamata API = una fattura», provato sul turno che ha rotto l'invariante.
 *
 * ── Il fatto ────────────────────────────────────────────────────────────────
 * `assistant` NON è un evento per chiamata: la CLI ne emette uno per BLOCCO di
 * contenuto, e ognuno ripete la STESSA `message.usage`. Chi accumula quell'usage
 * senza guardare `message.id` conta lo stesso prompt una volta per blocco.
 *
 * I numeri qui sotto NON sono inventati: sono il turno del topic `dec44329`
 * («trova volo fattibile da salerno...», una sola domanda da 118 caratteri),
 * letto dal transcript della CLI
 * `~/.claude/projects/-Users-utente/4f635de1-....jsonl`.
 * 24 eventi `assistant` con usage, 4 `message.id` distinti, ripetuti 8+9+5+2.
 *
 * Senza la guardia il piede del messaggio mostrava **4.893.590** token per un
 * turno che ne è costati **925.774** (5,29×) e scriveva in DB `cost_cents=2280`
 * ($22,80) invece di $3,66. Ed è il numero che l'utente vedeva «salire a
 * milioni» durante lo streaming.
 * @covers USAGE-03
 */
import { describe, expect, test } from "bun:test";
import { readAssistantCallUsage, readAssistantMessageId } from "./events";
import { accumulateTurnUsage, emptyTurnUsage } from "../../usage/turn-usage";
import { ClaudeCodeProvider } from "../claude-code";
import { SidechainTracker } from "./sidechain-tracker";

/** Una risposta del modello: il suo id, la sua usage, e in quanti blocchi la
 *  CLI l'ha spezzata (cioè quante volte ripete la stessa usage). */
const TURN = [
  { id: "msg_011CdqWYxUpnW8A7otKpXpkN", blocks: 8, input: 2, cacheCreation: 131396, cacheRead: 0, output: 3734 },
  { id: "msg_011CdqWyuo3Pj9JzsjeT4boF", blocks: 9, input: 2, cacheCreation: 68273, cacheRead: 131396, output: 2278 },
  { id: "msg_011CdqX1rZNxH7FJrrKpPcwv", blocks: 5, input: 1, cacheCreation: 85649, cacheRead: 199669, output: 2082 },
  { id: "msg_011CdqX4RgViqQSa9yabaCg6", blocks: 2, input: 2, cacheCreation: 24066, cacheRead: 285318, output: 2348 },
];

/** Gli eventi come li vede il provider: uno per blocco, usage ripetuta. */
function replayTurn(): unknown[] {
  const out: unknown[] = [];
  for (const call of TURN) {
    for (let i = 0; i < call.blocks; i++) {
      out.push({
        type: "assistant",
        message: {
          id: call.id,
          model: "claude-opus-5",
          usage: {
            input_tokens: call.input,
            cache_creation_input_tokens: call.cacheCreation,
            cache_read_input_tokens: call.cacheRead,
            output_tokens: call.output,
          },
        },
      });
    }
  }
  return out;
}

/** La regola del provider, isolata: accumula una volta per `message.id`. */
function bill(events: unknown[], opts?: { dedup: boolean }) {
  const dedup = opts?.dedup ?? true;
  const seen = new Set<string>();
  let turn = emptyTurnUsage();
  let calls = 0;
  for (const ev of events) {
    const usage = readAssistantCallUsage(ev);
    if (!usage) continue;
    const id = readAssistantMessageId(ev);
    if (dedup && id && seen.has(id)) continue;
    if (id) seen.add(id);
    turn = accumulateTurnUsage(turn, usage);
    calls++;
  }
  return { turn, calls };
}

describe("readAssistantMessageId", () => {
  test("è lo stesso su tutti i blocchi di una risposta, diverso fra risposte", () => {
    const ids = replayTurn().map(readAssistantMessageId);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(4);
  });

  test("null quando l'id manca — «assente» non deve poter passare per «già visto»", () => {
    expect(readAssistantMessageId({ type: "assistant", message: { usage: {} } })).toBeNull();
    expect(readAssistantMessageId({ type: "assistant", message: { id: "" } })).toBeNull();
    expect(readAssistantMessageId({ type: "result", message: { id: "msg_x" } })).toBeNull();
  });
});

describe("una chiamata API = una fattura", () => {
  test("il turno di dec44329 costa 925.774 token di prompt, non 4.893.590", () => {
    const { turn, calls } = bill(replayTurn());
    // Le quattro richieste vere, non i 24 eventi.
    expect(calls).toBe(4);
    // 131398 + 199671 + 285319 + 309386 — gli stessi che stanno in DB sulla riga.
    expect(turn.prompt).toBe(925_774);
    expect(turn.completion).toBe(10_442);
    expect(turn.cacheRead).toBe(616_383);
  });

  test("senza la guardia il conto è 5,29× — è il difetto, messo per iscritto", () => {
    const inflated = bill(replayTurn(), { dedup: false });
    expect(inflated.calls).toBe(24);
    expect(inflated.turn.prompt).toBe(4_893_590);
    // Il rapporto che l'utente vedeva: «milioni» per una domanda da 118 caratteri.
    expect(inflated.turn.prompt / 925_774).toBeCloseTo(5.286, 2);
  });

  test("un evento senza id viene fatturato: perdere una chiamata vera è peggio che contarla", () => {
    const anonymous = {
      type: "assistant",
      message: { model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 5 } },
    };
    const { turn, calls } = bill([anonymous, anonymous]);
    expect(calls).toBe(2);
    expect(turn.prompt).toBe(20);
  });

  test("due chiamate con usage IDENTICA ma id diversi restano due", () => {
    const mk = (id: string) => ({
      type: "assistant",
      message: { id, model: "claude-opus-5", usage: { input_tokens: 100, output_tokens: 7 } },
    });
    const { turn, calls } = bill([mk("msg_a"), mk("msg_b")]);
    expect(calls).toBe(2);
    expect(turn.prompt).toBe(200);
  });
});

// ── E ora il provider VERO, non una copia della regola ───────────────────────
// I test qui sopra bloccano l'aritmetica; questi bloccano che `handleStreamEvent`
// la applichi davvero. Senza, la regola può restare giusta mentre il percorso
// che conta smette di usarla.

function stubProcess(sessionKey: string) {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const pp: any = {
    proc: { stdin: { write() { return true; }, end() {} }, kill() {}, on() {}, stdout: { on() {} }, stderr: { on() {} } },
    readline: { on() {}, close() {} },
    io: { writeStdin: () => {}, signal: () => {}, kill: () => {} },
    ready: Promise.resolve(),
    sessionKey,
    consumedOffset: 0,
    stderrBuf: "",
    spawnMeta: { claudeSessionId: "test-session", isNewSession: false },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    alive: true,
    streamHandler: null,
    pendingResolve: null,
    pendingReject: null,
    fullText: "",
    activeToolCalls: new Set(),
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    lastEventAt: Date.now(),
    needsHistoryReplay: false,
    sidechain: new SidechainTracker(),
    pendingInputs: new Map(),
  };
  (provider as any).processes.set(sessionKey, pp);
  return { provider, pp };
}

describe("claude-code · handleStreamEvent fattura una volta per message.id", () => {
  test("i 24 eventi del turno reale producono 4 onCallUsage, per 925.774 token", () => {
    const { provider, pp } = stubProcess("topic:bill1");
    const billed: Array<{ inputTokens: number; outputTokens: number }> = [];
    pp.streamHandler = {
      onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {},
      onCallUsage: (u: any) => billed.push(u),
      onDone: () => {}, onError: () => {},
    };

    for (const ev of replayTurn()) (provider as any).handleStreamEvent(pp, ev);

    expect(billed).toHaveLength(4);
    expect(billed.reduce((a, u) => a + u.inputTokens, 0)).toBe(925_774);
    expect(billed.reduce((a, u) => a + u.outputTokens, 0)).toBe(10_442);
  });

  test("il Set è PER TURNO: lo stesso id in un turno nuovo torna fatturabile", () => {
    const { provider, pp } = stubProcess("topic:bill2");
    const billed: unknown[] = [];
    pp.streamHandler = {
      onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {},
      onCallUsage: (u: unknown) => billed.push(u),
      onDone: () => {}, onError: () => {},
    };
    const ev = replayTurn()[0];

    (provider as any).handleStreamEvent(pp, ev);
    (provider as any).handleStreamEvent(pp, ev);
    expect(billed).toHaveLength(1);

    // Ciò che `sendChat` fa all'inizio di ogni turno.
    pp.billedCallIds?.clear();
    (provider as any).handleStreamEvent(pp, ev);
    expect(billed).toHaveLength(2);
  });

  test("eventi senza message.id (le fixture storiche) restano fatturati come prima", () => {
    const { provider, pp } = stubProcess("topic:bill3");
    const billed: unknown[] = [];
    pp.streamHandler = {
      onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {},
      onCallUsage: (u: unknown) => billed.push(u),
      onDone: () => {}, onError: () => {},
    };
    const anon = { type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 2 } } };
    (provider as any).handleStreamEvent(pp, anon);
    (provider as any).handleStreamEvent(pp, anon);
    expect(billed).toHaveLength(2);
  });
});
