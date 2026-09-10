/**
 * The two things every dev probe does: ask whether it is armed, and say what
 * it saw.
 *
 * There are three probes in this folder (layout, heap, storage) and they share
 * the same contract on purpose: a flag key in ui-state that must say
 * `{"armed": true}`, one shot (the probe disarms itself so a reload does not
 * start a second run), and a result key written back to ui-state where a curl
 * can read it. Each one carried its own private copy of these two functions,
 * which is how three copies of a fetch stay identical until the day one of them
 * grows a header the others do not have.
 *
 * The asking half no longer costs a request at all — see `armingSnapshot`.
 *
 * NEITHER OF THEM EVER THROWS. A probe that breaks the app it is diagnosing is
 * worse than no probe, and the app must not care whether the server answers.
 */
import { subscribeFrames } from './wsFrameBus';

/**
 * HOW LONG THE ARMING QUESTION WAITS FOR AN ANSWER BEFORE GIVING UP.
 *
 * The snapshot arrives with the socket, which is open within a few hundred ms
 * of boot. Ten seconds is not a deadline, it is the point past which "the
 * server never spoke" is the honest reading — and giving up matters, because
 * it is what lets the subscription go and the three promises settle instead of
 * hanging for the life of the page.
 */
const ARMING_SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * THE FLAGS ARE ALREADY ON THE WIRE. NOBODY HAS TO ASK FOR THEM.
 *
 * Each of the three probes used to open its own `GET /api/ui-state/<flag>` the
 * moment App mounted. Three unconditional round trips, per window, on every
 * boot, whose answer is "no" essentially always — and they were spent in the
 * exact instant the chat history wants a connection, out of the six a browser
 * gives per host.
 *
 * They were asking for something the server sends unprompted: `ui-state:init`
 * is pushed on every socket open (`server.ts`, the opening burst) and carries
 * every ui-state key except the per-task browser ones. The arming flag is in
 * there. So the question is answered by READING the frame the app already
 * receives — zero requests instead of three — and the three probes share ONE
 * subscription: `armingSnapshot` is built once, on the first probe to ask.
 *
 * ARMING IS UNCHANGED, and that was the constraint: you still arm a probe by
 * writing its key into ui-state with a `curl` and reloading. What changed is
 * only who tells the page about it. A guest socket never receives the frame
 * (`ui-state:init` has no restricted variant — it is the OWNER's workspace),
 * so a guest window can no longer be armed at all: that is a fix, not a loss.
 */
let armingSnapshot: Promise<Record<string, unknown>> | null = null;

function loadArmingSnapshot(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (data: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopListening();
      resolve(data);
    };
    const timer = setTimeout(() => done({}), ARMING_SNAPSHOT_TIMEOUT_MS);
    const stopListening = subscribeFrames(
      (raw) => {
        const data = (raw as { data?: unknown } | null)?.data;
        done(data && typeof data === 'object' ? (data as Record<string, unknown>) : {});
      },
      { types: ['ui-state:init'] },
    );
  });
}

/** True only if the ui-state flag exists and says `{"armed": true}`. */
export async function readProbeFlag(flagKey: string): Promise<boolean> {
  try {
    armingSnapshot ??= loadArmingSnapshot();
    const value = (await armingSnapshot)[flagKey] as { armed?: boolean } | undefined;
    return value?.armed === true;
  } catch {
    return false;
  }
}

/**
 * Test-only — drops the shared snapshot so the next `readProbeFlag` subscribes
 * again. The promise is module-level by design (one subscription for three
 * probes), which in a test file means one frame would arm every case after it.
 */
export function __resetArmingSnapshotForTests(): void {
  armingSnapshot = null;
}

/** Writes a probe key back to ui-state. Silent when the server does not answer. */
export async function writeProbeState(key: string, value: unknown): Promise<void> {
  try {
    await fetch(`/api/ui-state/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch {
    /* a probe must never make noise when the server does not answer */
  }
}
