/**
 * SYNTHETIC delay on one route, so the latency gate (`bun run check:rotte`) can
 * be seen going red.
 *
 * WHY it exists. A gate that has never been seen failing is not a gate: it is a
 * line of CI that always says yes. For byte thresholds
 * (`scripts/check-bundle-size.ts`) the red is built with a fixture, a fake file
 * that weighs too much. For a latency, no: the number is not born in a file, it
 * is born in the server while it answers. The only way to prove that the gate
 * can say "this route got worse" is to make a route REALLY worse, and then put
 * it back.
 *
 * Lowering the threshold in the baseline does not prove it: it would show that
 * the comparison can do a subtraction, not that the MEASUREMENT sees the
 * slowdown. They are two different faults, and the one that lets a real
 * regression through is the second (a measurement looking at the wrong place
 * stays green forever).
 *
 * WHY it cannot touch production. Two conditions, not one:
 *   1. `TOPICS_E2E=1`, which exists ONLY in the test server
 *      (`scripts/start-test-server.sh` is the only place that exports it, as it
 *      already does for the destructive routes of `/api/test/*`);
 *   2. `TOPICS_ROTTE_FAULT_MS` with a positive number.
 * The production server has neither of the two, so here {@link ROUTE_FAULT} is
 * `null` and the caller does not even reach the call: it is a truth test on a
 * constant read once at module load, not a `process.env` lookup per request.
 *
 * Usage:
 *   TOPICS_ROTTE_FAULT_MS=40 bun run scripts/check-rotte.ts
 *   TOPICS_ROTTE_FAULT_MS=40 TOPICS_ROTTE_FAULT_PATH=/api/all-boards/tasks …
 */

export interface RouteFault {
  /** Milliseconds of waiting added to the route. */
  delayMs: number;
  /** Prefix of the hit path: everything starting like this gets slower. */
  pathPrefix: string;
}

/** Reads the arming out of the environment. Exported pure for the tests. */
export function readRouteFault(env: Record<string, string | undefined>): RouteFault | null {
  // The first gate is the test environment, not the delay: this way a variable
  // left behind by mistake in a shell cannot slow down anything alive.
  if (env.TOPICS_E2E !== "1") return null;
  const delayMs = Number(env.TOPICS_ROTTE_FAULT_MS);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return null;
  const pathPrefix = env.TOPICS_ROTTE_FAULT_PATH || "/api/topics";
  return { delayMs, pathPrefix };
}

/**
 * The current arming. Read from the environment at module load, and from there on
 * CHANGEABLE at runtime by `setRouteFault`.
 *
 * Why the environment alone is not enough: arming a fault via env forces a server restart, so the
 * "healthy" measurement and the "faulty" one come from TWO different processes. A self-proof built
 * that way does not show that the gate knows how to go red — it shows that two different processes
 * have different numbers, which is true even with no fault at all.
 *
 * The server uses it as a synchronous switch, so that when it is off the per-request cost stays a
 * comparison against `null` and not a promise allocated for nothing.
 */
let armed: RouteFault | null = readRouteFault(process.env);

/** The arming in force right now. */
export function currentRouteFault(): RouteFault | null {
  return armed;
}

/**
 * Arms or disarms hot. Callable ONLY from the test route, which is already behind
 * `TOPICS_E2E=1`: outside of there nobody can reach it, and in production `armed` is born null and
 * nobody touches it.
 */
export function setRouteFault(fault: RouteFault | null): void {
  armed = fault;
}

/** Waits, if this path is the one being hit. */
export async function applyRouteFault(pathname: string, fault: RouteFault | null = armed): Promise<void> {
  if (!fault) return;
  if (!pathname.startsWith(fault.pathPrefix)) return;
  await new Promise((r) => setTimeout(r, fault.delayMs));
}
