export type HealthState = "ok" | "warn" | "error" | "off";

export type HealthSubsystemId =
  | "server"
  | "pty-bridge"
  | "ai-bridge"
  | "browser-engines"
  | "relay"
  | "watcher"
  | "claude-cli"
  | "database";

export type HealthReason =
  | "ready"
  | "socket-ready"
  | "socket-missing"
  | "not-configured"
  | "not-connected"
  | "connected"
  | "watching"
  | "watcher-failed"
  | "not-installed"
  | "login-found-keychain"
  | "login-found-file"
  | "login-missing"
  | "browser-never-started"
  | "browser-running"
  | "browser-launch-failed"
  | "database-readable"
  | "timeout"
  | "probe-failed";

export interface HealthError {
  message: string;
  at: string;
}

export interface HealthSubsystem {
  id: HealthSubsystemId;
  state: HealthState;
  reason: HealthReason;
  params?: Record<string, string | number>;
  lastError?: HealthError;
}

export type HealthReading = Omit<HealthSubsystem, "id">;
export type HealthProbe = () => HealthReading | Promise<HealthReading>;

export const HEALTH_SUBSYSTEMS: ReadonlyArray<{ id: HealthSubsystemId }> = [
  { id: "server" },
  { id: "pty-bridge" },
  { id: "ai-bridge" },
  { id: "browser-engines" },
  { id: "relay" },
  { id: "watcher" },
  { id: "claude-cli" },
  { id: "database" },
];

export class ProbeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Probe exceeded ${timeoutMs} ms`);
    this.name = "ProbeTimeoutError";
  }
}

export async function inspectHealth(
  probes: Record<HealthSubsystemId, HealthProbe>,
  timeoutMs = 250,
  now: () => number = Date.now,
): Promise<HealthSubsystem[]> {
  return Promise.all(HEALTH_SUBSYSTEMS.map(async ({ id }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reading = await Promise.race([
        Promise.resolve().then(probes[id]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProbeTimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
      return { id, ...reading };
    } catch (error) {
      const timedOut = error instanceof ProbeTimeoutError;
      const message = error instanceof Error ? error.message : String(error);
      return {
        id,
        state: timedOut ? "warn" as const : "error" as const,
        reason: timedOut ? "timeout" as const : "probe-failed" as const,
        params: timedOut ? { timeoutMs } : { message },
        lastError: { message, at: new Date(now()).toISOString() },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
}
