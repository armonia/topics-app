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

export interface HealthError {
  message: string;
  at: string;
}

export interface HealthSubsystem {
  id: HealthSubsystemId;
  name: string;
  state: HealthState;
  observed: string;
  action: string;
  lastError?: HealthError;
}

export type HealthReading = Omit<HealthSubsystem, "id" | "name">;
export type HealthProbe = () => HealthReading | Promise<HealthReading>;

export const HEALTH_SUBSYSTEMS: ReadonlyArray<{ id: HealthSubsystemId; name: string }> = [
  { id: "server", name: "Server" },
  { id: "pty-bridge", name: "Bridge PTY" },
  { id: "ai-bridge", name: "AI bridge" },
  { id: "browser-engines", name: "Motori browser" },
  { id: "relay", name: "Relay" },
  { id: "watcher", name: "Watcher" },
  { id: "claude-cli", name: "CLI Claude e login" },
  { id: "database", name: "Database" },
];

export async function inspectHealth(
  probes: Record<HealthSubsystemId, HealthProbe>,
  timeoutMs = 250,
  now: () => number = Date.now,
): Promise<HealthSubsystem[]> {
  return Promise.all(HEALTH_SUBSYSTEMS.map(async ({ id, name }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reading = await Promise.race([
        Promise.resolve().then(probes[id]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("non risponde")), timeoutMs);
        }),
      ]);
      return { id, name, ...reading };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = message === "non risponde";
      return {
        id,
        name,
        state: timedOut ? "warn" as const : "error" as const,
        observed: timedOut ? `La sonda non risponde entro ${timeoutMs} ms.` : `Sonda fallita: ${message}`,
        action: timedOut ? "Riprova tra poco; se persiste, riavvia il sottosistema." : "Controlla il log del server e riavvia il sottosistema.",
        lastError: { message, at: new Date(now()).toISOString() },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
}
