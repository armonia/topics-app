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

  test("recovering (resume hit a missing session) → clear resend note, not a raw exit code", () => {
    const h = spyHandler();
    const pp = fakePP({ streamHandler: h, recovering: true });
    close(pp, 1);
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]).toContain("error:");
    expect(h.calls[0]).toContain("ripristinata");
    expect(h.calls[0]).not.toContain("code 1");
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
    await provider.abort("sess-x");
    expect(pp.aborting).toBe(true);
    expect(signals).toEqual(["SIGINT"]);
  });
});
