/**
 * Stream timer state machine — behavioral tests.
 *
 * The timer logic in topics.ts is intentionally inline (it closes over
 * `fullContent`, `partialMsg`, broadcast helpers, etc.) so we can't import
 * it directly. Instead this file unit-tests a *replica* of the same state
 * machine and exercises the invariants that the spec
 * `stream-timeout-resilience` codifies:
 *
 *   1. While ≥1 tool call is in `running` state, the soft inactivity timer
 *      is suspended (NEVER fires).
 *   2. After all tool calls finalize, the soft timer arms and fires after
 *      STREAM_TIMEOUT_MS of true silence.
 *   3. When the soft timeout fires, a "stream slow" annotation is added but
 *      the stream is NOT finalized yet — a grace period starts.
 *   4. A provider event during the grace period strips the annotation and
 *      transitions back to "streaming".
 *   5. The grace period expiring without events finalizes the stream as
 *      timed out and removes the annotation in favor of the hard marker.
 *   6. The hard cap is symmetric with the grace window: while the provider
 *      process is ALIVE it EXTENDS (a live, working turn is never killed —
 *      CLI parity: the terminal `claude` has no wall-clock session kill); only
 *      a DEAD process is finalized by the cap (the orphan backstop).
 *   7. Grace expiry with the provider process still ALIVE (auto-compact:
 *      the CLI is mute for 3+ min while compacting) EXTENDS the grace
 *      window instead of finalizing — only a dead process (or the hard
 *      cap) finalizes as timeout.
 *   8. Il soft timer è armato allo START, non al primo evento: un turno che
 *      non emette MAI nulla deve finire nella stessa macchina a stati, non
 *      nel silenzio.
 *   9. Un abort deciso da fuori la route (sweeper StaleStream) finalizza e
 *      spegne ogni timer: è il segnale che chiude la risposta SSE.
 *
 * The replica below is kept in one-to-one structural correspondence with
 * the route code; if either drifts, this file should fail and the
 * topics.ts code should be re-aligned, NOT the test.
 */

import { describe, expect, test } from "bun:test";

// ── Replica of the route timer state machine (mirror of topics.ts) ──────
// Constants match the production values exactly. Don't drift them.
const STREAM_TIMEOUT_MS = 60_000;
const STREAM_GRACE_MS = 60_000;
const STREAM_HARD_TIMEOUT_MS = 30 * 60_000;
const STREAM_SLOW_ANNOTATION =
  "\n\n---\n*[⏱ stream lento — il provider è ancora connesso]*";

interface Harness {
  state: "streaming" | "soft-timed-out" | "finalized";
  fullContent: string;
  trackedToolCallIds: string[];
  log: string[];
  /** Callbacks the route would actually run; we just record them. */
  events: string[];
  /** Mirror of `topicProvider.isTurnProcessAlive?.(sessionKey)` — the route
   *  treats a missing method as falsy, so the replica defaults to false. */
  providerAlive: boolean;
}

/** Build a fresh state machine wired to a Harness for inspection. */
function build() {
  const h: Harness = {
    state: "streaming",
    fullContent: "",
    trackedToolCallIds: [],
    log: [],
    events: [],
    providerAlive: false,
  };

  let softTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;

  const stripSlow = (s: string) =>
    s.endsWith(STREAM_SLOW_ANNOTATION)
      ? s.slice(0, -STREAM_SLOW_ANNOTATION.length)
      : s;

  const graceExpiry = () => {
    if (h.state !== "soft-timed-out") return;
    // Mirror of handleGraceExpiry's liveness branch: a live-but-mute child
    // (auto-compact) extends the grace window instead of finalizing.
    if (h.providerAlive) {
      h.events.push("grace-extended");
      graceTimer = setTimeout(graceExpiry, STREAM_GRACE_MS);
      return;
    }
    h.state = "finalized";
    h.fullContent = stripSlow(h.fullContent) + "\n\n---\n*[Response timed out]*";
    h.events.push("grace-expired");
  };

  const armSoft = () => {
    if (h.state !== "streaming") return;
    if (softTimer) clearTimeout(softTimer);
    if (h.trackedToolCallIds.length > 0) { softTimer = null; return; }
    softTimer = setTimeout(() => {
      if (h.state !== "streaming") return;
      h.state = "soft-timed-out";
      h.fullContent = stripSlow(h.fullContent) + STREAM_SLOW_ANNOTATION;
      h.events.push("soft-timeout");
      graceTimer = setTimeout(graceExpiry, STREAM_GRACE_MS);
    }, STREAM_TIMEOUT_MS);
  };

  const recover = () => {
    if (h.state !== "soft-timed-out") return;
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    h.state = "streaming";
    h.fullContent = stripSlow(h.fullContent);
    h.events.push("recovered");
  };

  const onEvent = () => {
    if (h.state === "finalized") return;
    if (h.state === "soft-timed-out") recover();
    armSoft();
  };

  const onToolStart = (id: string) => {
    h.trackedToolCallIds.push(id);
    onEvent();
  };
  const onToolResult = (id: string) => {
    const i = h.trackedToolCallIds.indexOf(id);
    if (i >= 0) h.trackedToolCallIds.splice(i, 1);
    onEvent();
  };

  // Mirror of handleHardTimeout: the hard cap is now symmetric with the grace
  // window — a live child is NEVER killed (CLI parity: no wall-clock session
  // kill of a working turn). Only a DEAD process is finalized by the cap.
  const hardExpiry = () => {
    if (h.state === "finalized") return;
    if (h.providerAlive) {
      h.events.push("hard-extended");
      hardTimer = setTimeout(hardExpiry, STREAM_HARD_TIMEOUT_MS);
      return;
    }
    h.state = "finalized";
    h.fullContent = stripSlow(h.fullContent) + "\n\n---\n*[Hard timeout (30 min) reached]*";
    h.events.push("hard-timeout");
  };
  hardTimer = setTimeout(hardExpiry, STREAM_HARD_TIMEOUT_MS);
  // Il soft timer parte allo start, non al primo evento: il silenzio iniziale
  // (provider che non emette MAI nulla) è il caso che prima passava inosservato.
  armSoft();

  const finalize = (reason: "done" | "aborted" | "error") => {
    if (softTimer) clearTimeout(softTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (hardTimer) clearTimeout(hardTimer);
    if (h.state === "soft-timed-out") {
      h.fullContent = stripSlow(h.fullContent);
      h.events.push("recovered-on-finalize");
    }
    h.state = "finalized";
    h.events.push(`finalize:${reason}`);
  };

  // Mirror del listener su `externalAbort.signal`: lo sweeper StaleStream ha
  // già chiuso il turno in DB e via WS, qui resta da liberare il client SSE.
  const externalAbort = () => {
    if (h.state === "finalized") return;
    if (softTimer) clearTimeout(softTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (hardTimer) clearTimeout(hardTimer);
    h.state = "finalized";
    h.events.push("sse-closed");
  };

  return { h, onEvent, onToolStart, onToolResult, finalize, externalAbort };
}

// We use bun's fake timers via setTimeout monkey-patching: bun:test's
// `setSystemTime` helper isn't suitable for setTimeout, so we drive time
// manually using a simple stub.
function withFakeTimers<T>(fn: (advance: (ms: number) => void) => T): T {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  type Job = { id: number; at: number; cb: () => void; cancelled: boolean };
  const queue: Job[] = [];
  let now = 0;
  let nextId = 1;

  (globalThis as any).setTimeout = (cb: () => void, ms: number) => {
    const job: Job = { id: nextId++, at: now + ms, cb, cancelled: false };
    queue.push(job);
    return job.id as any;
  };
  (globalThis as any).clearTimeout = (id: number) => {
    const job = queue.find(j => j.id === id);
    if (job) job.cancelled = true;
  };

  const advance = (ms: number) => {
    const target = now + ms;
    while (true) {
      const due = queue
        .filter(j => !j.cancelled && j.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.cancelled = true;
      due.cb();
    }
    now = target;
  };

  try {
    return fn(advance);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

describe("stream timer state machine", () => {
  test("Fix A: long-running tool does NOT trigger soft timeout", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart } = build();
      onToolStart("tool-1");
      // 5 minutes of silence with the tool still running.
      advance(5 * 60_000);
      expect(h.state).toBe("streaming");
      expect(h.events).toEqual([]);
    });
  });

  test("Fix A: timer arms after tool finishes and fires after STREAM_TIMEOUT_MS", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart, onToolResult } = build();
      onToolStart("tool-1");
      advance(60_000); // 1 min while tool running — no fire
      onToolResult("tool-1");
      // Now the soft timer has just been (re-)armed. It should NOT fire
      // for the first ~119s after the tool result.
      advance(STREAM_TIMEOUT_MS - 1);
      expect(h.state).toBe("streaming");
      // Tick past the threshold.
      advance(2);
      expect(h.state).toBe("soft-timed-out");
      expect(h.events).toContain("soft-timeout");
    });
  });

  test("Fix D: provider event during grace strips annotation and recovers", () => {
    withFakeTimers((advance) => {
      const { h, onEvent } = build();
      onEvent(); // arm soft timer
      advance(STREAM_TIMEOUT_MS + 1);
      expect(h.state).toBe("soft-timed-out");
      expect(h.fullContent).toContain("⏱ stream lento");
      // Half-grace, provider sneezes back to life.
      advance(30_000);
      onEvent();
      expect(h.state).toBe("streaming");
      expect(h.fullContent).toBe("");
      expect(h.events).toContain("recovered");
    });
  });

  test("grace expires without events → finalized as timed out", () => {
    withFakeTimers((advance) => {
      const { h, onEvent } = build();
      onEvent();
      advance(STREAM_TIMEOUT_MS + STREAM_GRACE_MS + 1);
      expect(h.state).toBe("finalized");
      expect(h.events).toContain("grace-expired");
      expect(h.fullContent).toContain("Response timed out");
      expect(h.fullContent).not.toContain("⏱ stream lento");
    });
  });

  test("Fix D recovery on finalize(done) strips annotation", () => {
    withFakeTimers((advance) => {
      const { h, onEvent, finalize } = build();
      onEvent();
      advance(STREAM_TIMEOUT_MS + 5_000);
      expect(h.state).toBe("soft-timed-out");
      // Provider's onDone arrives during grace — finalize(done) should
      // strip the slow annotation and treat the run as a recovery.
      finalize("done");
      expect(h.state).toBe("finalized");
      expect(h.fullContent).not.toContain("⏱ stream lento");
      expect(h.events).toContain("recovered-on-finalize");
    });
  });

  test("auto-compact: grace extends while the provider process is alive, then recovers", () => {
    withFakeTimers((advance) => {
      const { h, onEvent } = build();
      h.providerAlive = true; // the child is compacting: mute but alive
      onEvent(); // arm soft timer
      // Real-world shape of the 2026-07-20 incident: 188s of total silence.
      advance(STREAM_TIMEOUT_MS + 1); // 60s → soft timeout
      expect(h.state).toBe("soft-timed-out");
      advance(STREAM_GRACE_MS); // 120s → grace expiry #1: alive → extend
      expect(h.state).toBe("soft-timed-out");
      advance(STREAM_GRACE_MS); // 180s → grace expiry #2: alive → extend
      expect(h.state).toBe("soft-timed-out");
      expect(h.events.filter((e) => e === "grace-extended").length).toBe(2);
      // ~195s: compaction done, the provider emits again → full recovery.
      advance(15_000);
      onEvent();
      expect(h.state).toBe("streaming");
      expect(h.fullContent).not.toContain("⏱ stream lento");
      expect(h.events).toContain("recovered");
    });
  });

  test("grace expiry with a DEAD provider process still finalizes as timeout", () => {
    withFakeTimers((advance) => {
      const { h, onEvent } = build();
      h.providerAlive = true;
      onEvent();
      advance(STREAM_TIMEOUT_MS + STREAM_GRACE_MS + 1); // one extension granted
      expect(h.state).toBe("soft-timed-out");
      h.providerAlive = false; // child dies during the extended window
      advance(STREAM_GRACE_MS);
      expect(h.state).toBe("finalized");
      expect(h.events).toContain("grace-expired");
      expect(h.fullContent).toContain("Response timed out");
    });
  });

  test("provider alive forever + total silence → the hard cap EXTENDS, never kills a live turn (CLI parity)", () => {
    withFakeTimers((advance) => {
      const { h, onEvent } = build();
      h.providerAlive = true; // wedged-but-alive child — like the terminal CLI, never SIGKILL it
      onEvent();
      // Three full hard windows (90 min) of total silence with the child alive.
      advance(STREAM_HARD_TIMEOUT_MS * 3 + 1);
      expect(h.state).not.toBe("finalized");
      expect(h.events.filter((e) => e === "hard-extended").length).toBeGreaterThanOrEqual(3);
      expect(h.events).not.toContain("hard-timeout");
    });
  });

  test("hard cap finalizes only a DEAD process (backstop) after 30 min", () => {
    withFakeTimers((advance) => {
      const { h, onToolStart, onToolResult } = build();
      // providerAlive defaults to false: a dead/orphaned child. Tool churn keeps
      // the soft timer suspended so only the hard cap can fire.
      for (let i = 0; i < 30; i++) {
        onToolStart(`t-${i}`);
        advance(60_000);
        onToolResult(`t-${i}`);
      }
      expect(h.state).toBe("finalized");
      expect(h.events).toContain("hard-timeout");
      expect(h.fullContent).toContain("Hard timeout");
    });
  });

  test("a turn making progress re-arms the soft window and the hard cap never trips while alive", () => {
    withFakeTimers((advance) => {
      const { h, onEvent } = build();
      h.providerAlive = true;
      // Emit an event every ~20 min for 2 hours — real (if sparse) progress.
      for (let i = 0; i < 6; i++) {
        onEvent();
        advance(20 * 60_000);
      }
      // Never finalized: the child is alive throughout; the hard cap extended.
      expect(h.state).not.toBe("finalized");
      expect(h.events).not.toContain("hard-timeout");
    });
  });
});

/**
 * Le due falle che lasciavano la chat "appesa a caricare" (2026-07-29).
 */
describe("turno che non parte / finalizzato da fuori", () => {
  test("silenzio TOTALE dallo start: il soft timer scatta lo stesso", () => {
    withFakeTimers((advance) => {
      const { h } = build();
      // Nessun evento: la CLI è viva ma non emette niente (MCP appeso, resume
      // che non parte). Prima il soft timer si armava solo dal primo evento,
      // quindi questo caso non produceva NÉ annotazione NÉ timeout.
      advance(STREAM_TIMEOUT_MS + 1);
      expect(h.events).toContain("soft-timeout");
      expect(h.fullContent).toContain("stream lento");
    });
  });

  test("silenzio totale + processo morto: si finalizza al termine della grace", () => {
    withFakeTimers((advance) => {
      const { h } = build();
      advance(STREAM_TIMEOUT_MS + STREAM_GRACE_MS + 2);
      expect(h.state).toBe("finalized");
      expect(h.events).toContain("grace-expired");
    });
  });

  test("silenzio totale ma processo vivo: si estende, non si uccide", () => {
    withFakeTimers((advance) => {
      const { h } = build();
      h.providerAlive = true;
      advance(STREAM_TIMEOUT_MS + STREAM_GRACE_MS * 5);
      expect(h.state).not.toBe("finalized");
      expect(h.events).toContain("grace-extended");
    });
  });

  test("abort esterno (sweeper StaleStream): chiude l'SSE e spegne i timer", () => {
    withFakeTimers((advance) => {
      const { h, onEvent, externalAbort } = build();
      onEvent();
      externalAbort();
      expect(h.state).toBe("finalized");
      expect(h.events).toContain("sse-closed");
      // Nessun timer sopravvive all'abort: niente soft/grace/hard in ritardo su
      // uno stream già chiuso.
      advance(STREAM_HARD_TIMEOUT_MS * 2);
      expect(h.events.filter((e) => e === "soft-timeout")).toHaveLength(0);
      expect(h.events).not.toContain("hard-timeout");
    });
  });

  test("abort esterno dopo una finalizzazione normale: no-op", () => {
    withFakeTimers(() => {
      const { h, onEvent, finalize, externalAbort } = build();
      onEvent();
      finalize("done");
      externalAbort();
      expect(h.events).not.toContain("sse-closed");
      expect(h.events.filter((e) => e.startsWith("finalize:"))).toEqual(["finalize:done"]);
    });
  });
});
