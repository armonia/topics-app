/**
 * onSessionClosed — a clean or user-requested process exit must NOT surface as
 * "⚠️ Process exited with code N".
 *
 * The CLI exits code 0 on SIGINT, and a persistent broker session can also exit
 * 0 between turns. Previously ANY exit with a live stream fired
 * streamHandler.onError(...), so hitting stop showed a scary error bubble. Now
 * only a genuine non-zero crash is an error; a clean/aborted exit flushes the
 * partial via onAborted (same as an explicit abort).
 */
import { describe, test, expect } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";

function fakePP(over: Record<string, unknown> = {}) {
  return {
    alive: true,
    aborting: false,
    streamHandler: null as null | Record<string, unknown>,
    pendingResolve: null,
    pendingReject: null,
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    ...over,
  };
}

function spyHandler() {
  const calls: string[] = [];
  return {
    calls,
    onError: (m: string) => calls.push(`error:${m}`),
    onAborted: () => calls.push("aborted"),
    onDone: () => calls.push("done"),
  };
}

describe("onSessionClosed — clean/aborted exit is not an error", () => {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const close = (pp: unknown, code: number | null) => (provider as any).onSessionClosed(pp, code);

  test("code 0 with a live stream → onAborted (flush partial), NOT onError", () => {
    const h = spyHandler();
    const pp = fakePP({ streamHandler: h });
    close(pp, 0);
    expect(h.calls).toEqual(["aborted"]);
    expect(pp.streamHandler).toBeNull();
    expect(pp.alive).toBe(false);
  });

  test("aborting flag + non-zero code → still graceful (user stop)", () => {
    const h = spyHandler();
    const pp = fakePP({ streamHandler: h, aborting: true });
    close(pp, 143); // 128+SIGINT
    expect(h.calls).toEqual(["aborted"]);
  });

  test("non-zero code without abort → onError (genuine crash)", () => {
    const h = spyHandler();
    const pp = fakePP({ streamHandler: h });
    close(pp, 1);
    expect(h.calls).toEqual(["error:Process exited with code 1"]);
  });

  test("graceful close rejects a pending turn with ABORTED, not PROCESS_DIED", () => {
    let rejected = "";
    const pp = fakePP({ pendingReject: (e: Error) => { rejected = e.message; } });
    close(pp, 0);
    expect(rejected).toBe("ABORTED");
  });

  test("crash close rejects a pending turn with PROCESS_DIED_<code>", () => {
    let rejected = "";
    const pp = fakePP({ pendingReject: (e: Error) => { rejected = e.message; } });
    close(pp, 1);
    expect(rejected).toBe("PROCESS_DIED_1");
  });

  test("no live stream (normal completion already finalized) → no handler calls", () => {
    const pp = fakePP({ streamHandler: null });
    expect(() => close(pp, 0)).not.toThrow();
  });

  test("recovering (resume hit a missing session) → SESSION_RESET, NO user-facing error", () => {
    // A lost --resume is a recoverable reset: the pending turn rejects with the
    // distinct SESSION_RESET marker (so sendChat can transparently respawn+resend)
    // and NOTHING is surfaced to the handler — no "code 1", no resend note here.
    const h = spyHandler();
    let rejected = "";
    const pp = fakePP({
      streamHandler: h,
      recovering: true,
      pendingReject: (e: Error) => { rejected = e.message; },
    });
    close(pp, 1);
    expect(rejected).toBe("SESSION_RESET");
    expect(h.calls).toEqual([]);
    expect(pp.streamHandler).toBeNull();
  });
});

describe("abort() marks the process as aborting", () => {
  test("sets pp.aborting before the exit event can land", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const signals: string[] = [];
    const pp = fakePP({
      alive: true,
      streamHandler: spyHandler(),
      pendingInputs: new Map(),
      io: { signal: (s: string) => signals.push(s) },
    });
    (provider as any).processes.set("sess-x", pp);
    // La ragione si DICHIARA: `abort` non ha piu' un default. Un default qui
    // era `"user"`, ed e' cosi' che uno spegnimento del server si e' spacciato
    // per uno stop premuto a mano (20/08, topic:9f9e9629).
    await provider.abort("sess-x", undefined, "user");
    expect(pp.aborting).toBe(true);
    expect((pp as any).abortReason).toBe("user");
    expect(signals).toEqual(["SIGINT"]);
  });

  test("watchdog abort carries the reason so the exit is never logged as a user stop", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const pp = fakePP({
      alive: true,
      streamHandler: spyHandler(),
      pendingInputs: new Map(),
      io: { signal: () => {} },
    });
    (provider as any).processes.set("sess-w", pp);
    await provider.abort("sess-w", undefined, "watchdog");
    expect(pp.aborting).toBe(true);
    expect((pp as any).abortReason).toBe("watchdog");
  });
});

describe("reattach scan pass — tail classification of a multi-turn broker store", () => {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const emit = (pp: unknown, event: unknown) => (provider as any).handleStreamEvent(pp, event);
  const scanPP = (): any => fakePP({
    replayMute: true, replayTailOpen: false, replayLastResult: undefined,
    replayAfterLastResultOffset: 0, consumedOffset: 0, lastEventAt: 0,
  });

  test("events after the last result → tail OPEN (turn in flight), handler untouched", () => {
    const h = spyHandler();
    const pp = scanPP(); pp.streamHandler = h;
    emit(pp, { type: "assistant", message: { content: [{ type: "text", text: "turn 1" }] } });
    pp.consumedOffset = 100;
    emit(pp, { type: "result", result: "turn 1 done" });
    emit(pp, { type: "assistant", message: { content: [{ type: "text", text: "turn 2 in flight" }] } });
    expect(pp.replayTailOpen).toBe(true);
    expect(pp.replayAfterLastResultOffset).toBe(100);
    expect(h.calls).toEqual([]); // muted: an OLD result must NOT fire onDone/null the handler
    expect(pp.streamHandler).toBe(h);
  });

  test("store ending on a result → tail CLOSED with the final payload captured", () => {
    const pp = scanPP();
    emit(pp, { type: "assistant", message: { content: [{ type: "text", text: "work" }] } });
    expect(pp.replayTailOpen).toBe(true);
    emit(pp, { type: "result", result: "final answer" });
    expect(pp.replayTailOpen).toBe(false);
    expect((pp.replayLastResult as any).result).toBe("final answer");
  });

  test("'waiting for message' results are noise and do not close the tail", () => {
    const pp = scanPP();
    emit(pp, { type: "assistant", message: { content: [{ type: "text", text: "work" }] } });
    emit(pp, { type: "result", result: "waiting for message" });
    expect(pp.replayTailOpen).toBe(true);
  });
});

describe("isTurnProcessAlive — the stream watchdog's liveness probe", () => {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });

  test("true for a live pooled process (e.g. mute during auto-compact)", () => {
    (provider as any).processes.set("sess-alive", fakePP({ alive: true }));
    expect(provider.isTurnProcessAlive("sess-alive")).toBe(true);
  });

  test("false for a dead process and for an unknown session", () => {
    (provider as any).processes.set("sess-dead", fakePP({ alive: false }));
    expect(provider.isTurnProcessAlive("sess-dead")).toBe(false);
    expect(provider.isTurnProcessAlive("sess-unknown")).toBe(false);
  });
});

/**
 * Missing-session recovery must trigger from the STDOUT `result` frame, not just
 * stderr: `claude --resume <gone>` reports "No conversation found with session
 * ID" as an `error_during_execution` result on stdout. Without this the dead id
 * is never forgotten and every turn re-resumes it → infinite "code 1" loop.
 */
describe("missing-session recovery is detected on the stdout result frame", () => {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const emit = (pp: unknown, event: unknown) => (provider as any).handleStreamEvent(pp, event);

  const resumedPP = (over: Record<string, unknown> = {}): any =>
    fakePP({
      sessionKey: "topic:test",
      spawnMeta: { claudeSessionId: "dead-id", isNewSession: false },
      lastEventAt: 0,
      ...over,
    });

  test("error result + 'No conversation found' → pp.recovering (dead id forgotten)", () => {
    const pp = resumedPP();
    emit(pp, {
      type: "result",
      is_error: true,
      subtype: "error_during_execution",
      errors: ["No conversation found with session ID: dead-id"],
    });
    expect(pp.recovering).toBe(true);
  });

  test("a fresh --session-id spawn never enters recovery (can't lose a new session)", () => {
    const pp = resumedPP({ spawnMeta: { claudeSessionId: "new-id", isNewSession: true } });
    emit(pp, {
      type: "result",
      is_error: true,
      subtype: "error_during_execution",
      errors: ["No conversation found with session ID: new-id"],
    });
    expect(pp.recovering).toBeFalsy();
  });

  test("an unrelated error result does NOT trigger recovery", () => {
    const pp = resumedPP();
    emit(pp, { type: "result", is_error: true, subtype: "error_during_execution", errors: ["disk full"] });
    expect(pp.recovering).toBeFalsy();
  });
});

/**
 * End-to-end of the invisible recovery: a lost session makes the FIRST turn
 * reject SESSION_RESET; sendChat drops the dead child and resends the same prompt
 * ONCE on a fresh session. The cap prevents any loop, and the caller only ever
 * sees the successful turn (or, if the fresh spawn somehow reset too, one note).
 */
describe("sendChat resends transparently once on a lost session (capped)", () => {
  test("SESSION_RESET → exactly one fresh resend, then a single note (no loop, no raw crash)", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const noop = () => {};
    let spawns = 0;
    const makeFake = () => {
      const pp: any = fakePP({
        alive: true,
        sessionKey: "topic:x",
        spawnMeta: { claudeSessionId: "dead", isNewSession: false },
        recovering: true,
        ready: Promise.resolve(),
        needsHistoryReplay: false,
        fullText: "",
        sidechain: { clear: noop },
        activeToolCalls: { clear: noop },
        settledToolCalls: { clear: noop },
        pendingInputs: new Map(),
      });
      // The first stdin write drives the session straight into a lost-session
      // close, exactly like `claude --resume <gone>` exiting after its error frame.
      pp.io = { writeStdin: () => (provider as any).onSessionClosed(pp, 1), signal: noop, kill: noop };
      return pp;
    };
    (provider as any).getOrCreateProcess = () => { spawns++; return makeFake(); };
    (provider as any).startHeartbeat = noop;
    (provider as any).stopHeartbeat = noop;
    (provider as any).resetInactivityTimer = noop;

    const h = spyHandler();
    await (provider as any).sendChatInternal("topic:x", "hi", h);

    expect(spawns).toBe(2); // original attempt + exactly one resend, then capped
    expect(h.calls.filter((c) => c.includes("ripristinata")).length).toBe(1);
    expect(h.calls.some((c) => c.includes("code 1"))).toBe(false);
    expect(h.calls.some((c) => c.includes("died"))).toBe(false);
  });
});

/**
 * SPEGNIMENTO SENZA BROKER: anche qui il turno deve dire che sta morendo.
 *
 * Il guasto del 20/08 (topic:9f9e9629) e' stato diagnosticato sul runtime
 * NATIVO, ma la sua forma non e' propria di quel provider: e' «il processo
 * muore e nessuno avvisa lo stream handler». Con `TOPICS_AI_BRIDGE=1` il
 * figlio di claude-code SOPRAVVIVE allo spegnimento (si stacca dal broker e
 * viene riadottato), quindi non c'e' niente da annunciare — ed e' il ramo che
 * gira sulla macchina dove il difetto e' stato trovato.
 *
 * Su un'installazione SENZA broker, pero', `stop()` chiama `killProcess`, che
 * non notifica nessuno: niente onDone/onError/onAborted, e la route finalizza
 * solo da quei tre. Stessa morte silenziosa, altro provider, su un ramo che
 * qui nessuno percorreva. Questa prova lo copre prima che qualcuno lo scopra
 * con una chat persa.
 *
 * `USE_AI_BRIDGE` si fissa all'import del modulo, quindi la env va messa PRIMA
 * e il modulo va importato fresco: e' l'unico modo di esercitare davvero il
 * ramo che su questa macchina non gira mai.
 */
test("stop() senza broker: il turno vivo riceve onAborted con server-shutdown", async () => {
  const prima = process.env.TOPICS_AI_BRIDGE;
  process.env.TOPICS_AI_BRIDGE = "0";
  try {
    // Import fresco: la costante di modulo legge la env in questo istante.
    const mod = await import(`./claude-code.ts?no-broker=${Date.now()}`);
    const provider: any = new mod.ClaudeCodeProvider({ type: "claude-code" } as any);
    const fini: any[] = [];
    const pp: any = {
      alive: true,
      io: { kill: () => {}, signal: () => {} },
      readline: { close: () => {} },
      pendingInputs: new Map(),
      subAgentEmit: new Map(),
      streamHandler: {
        onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {},
        onDone: () => fini.push({ ev: "done" }),
        onError: () => fini.push({ ev: "error" }),
        onAborted: (m: any) => fini.push({ ev: "aborted", turnEnd: m?.turnEnd }),
      },
    };
    provider.processes.set("topic:senza-broker", pp);

    provider.stop();

    // 1. QUALCUNO E' STATO AVVISATO. Senza questo la route non finalizza mai e
    //    la chat resta a meta' frase, per sempre.
    expect(fini.length).toBe(1);
    expect(fini[0].ev).toBe("aborted");
    // 2. E CON LA CAUSA GIUSTA: e' quella che fa scrivere il cartello a
    //    `cancelledNotice`. Un `user` qui farebbe tacere la spiegazione.
    expect(fini[0].turnEnd).toEqual({ end: "cancelled", cause: "server-shutdown" });
  } finally {
    if (prima === undefined) delete process.env.TOPICS_AI_BRIDGE;
    else process.env.TOPICS_AI_BRIDGE = prima;
  }
});
