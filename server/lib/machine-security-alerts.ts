/**
 * Security alerts: turns the machines' security rounds into board cards.
 *
 * Pure on purpose: `securityAlerts` decides which cards to open and which to
 * close; the caller owns the board (`boot/machine-health.ts`). One card per
 * `security:<machineId>:<check>` key, whatever the number of rounds.
 */
import type { CheckKey, MachineSecurity } from "../../shared/machine-health";

/** A check that stays `warn` this long counts as a problem. */
export const WARN_AS_PROBLEM_MS = 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/** A check's own age, in ms, when its msg already carries how many days it has been true (e.g. `updates.macWaitingOld`). */
function selfReportedSinceMs(check: { msgs?: Array<{ params?: Record<string, string | number> }> }, nowMs: number): number | null {
  const days = check.msgs?.find((m) => typeof m.params?.days === "number")?.params?.days as number | undefined;
  return days === undefined ? null : nowMs - days * DAY_MS;
}

export const ALERT_KEY_PREFIX = "security:";

export function alertKey(machineId: string, check: CheckKey): string {
  return `${ALERT_KEY_PREFIX}${machineId}:${check}`;
}

/** What the previous round saw for one check: its status and since when it has been `warn`. */
export interface TrackedCheck {
  status: string;
  warnSinceMs: number | null;
}
export type TrackedChecks = Record<string, TrackedCheck>;

export interface MachineRound {
  name: string;
  security: MachineSecurity;
}

export interface AlertToOpen {
  key: string;
  title: string;
  detail: string;
}
export interface AlertToClose {
  key: string;
  outcome: string;
}
export interface AlertPlan {
  open: AlertToOpen[];
  close: AlertToClose[];
  /** Hand it back as `prev` at the next round. */
  tracked: TrackedChecks;
}

/**
 * `prev` is the tracked state of the previous round, `next` the machines now,
 * `openCards` the keys that already have an open card. `unknown` never opens a
 * card and never closes one (no reading is not a green reading); `info` is
 * ignored like everywhere else in the verdict.
 */
export function securityAlerts(
  prev: TrackedChecks,
  next: Record<string, MachineRound>,
  openCards: ReadonlySet<string>,
  nowMs: number,
): AlertPlan {
  const open: AlertToOpen[] = [];
  const close: AlertToClose[] = [];
  const tracked: TrackedChecks = {};
  for (const [machineId, round] of Object.entries(next)) {
    for (const check of round.security.checks) {
      if (check.status === "info") continue;
      const key = alertKey(machineId, check.key);
      const warnSinceMs = check.status === "warn"
        ? selfReportedSinceMs(check, nowMs) ?? (prev[key]?.status === "warn" ? prev[key]!.warnSinceMs ?? nowMs : nowMs)
        : null;
      tracked[key] = { status: check.status, warnSinceMs };
      const red = check.status === "problem" || (check.status === "warn" && nowMs - (warnSinceMs ?? nowMs) >= WARN_AS_PROBLEM_MS);
      if (red && !openCards.has(key)) open.push({ key, title: `${round.name}: ${check.detail}`, detail: check.detail });
      else if (check.status === "ok" && openCards.has(key)) close.push({ key, outcome: check.detail });
    }
  }
  return { open, close, tracked };
}
