import { describe, expect, test } from "bun:test";
import { HEALTH_SUBSYSTEMS, inspectHealth, type HealthProbe, type HealthSubsystemId } from "../shared/system-health";

const healthy = (): { state: "ok"; observed: string; action: string } => ({ state: "ok", observed: "visto", action: "nessuna" });

function probesFor(probe: HealthProbe): Record<HealthSubsystemId, HealthProbe> {
  return Object.fromEntries(HEALTH_SUBSYSTEMS.map(({ id }) => [id, probe])) as Record<HealthSubsystemId, HealthProbe>;
}

describe("system health probes", () => {
  test("turns a failed probe into an actionable error with its timestamp", async () => {
    const probes = probesFor(healthy);
    probes["pty-bridge"] = () => { throw new Error("socket assente"); };
    const rows = await inspectHealth(probes, 20, () => 0);
    expect(rows.find(({ id }) => id === "pty-bridge")).toMatchObject({
      state: "error",
      observed: "Sonda fallita: socket assente",
      action: expect.any(String),
      lastError: { message: "socket assente", at: "1970-01-01T00:00:00.000Z" },
    });
  });

  test("every subsystem keeps its failing probe visible and actionable", async () => {
    for (const { id } of HEALTH_SUBSYSTEMS) {
      const probes = probesFor(healthy);
      probes[id] = () => { throw new Error(`${id} guasto`); };
      const row = (await inspectHealth(probes, 20)).find((item) => item.id === id);
      expect(row, id).toMatchObject({ state: "error", observed: `Sonda fallita: ${id} guasto`, action: expect.any(String) });
    }
  });

  test("a silent probe warns within its cap while the other probes finish", async () => {
    const probes = probesFor(healthy);
    probes["pty-bridge"] = () => new Promise(() => {});
    const started = Date.now();
    const rows = await inspectHealth(probes, 25);
    expect(Date.now() - started).toBeLessThan(250);
    expect(rows.find(({ id }) => id === "pty-bridge")).toMatchObject({ state: "warn", observed: "La sonda non risponde entro 25 ms." });
    expect(rows.find(({ id }) => id === "server")?.state).toBe("ok");
  });

  test("always returns the full subsystem roster", async () => {
    const rows = await inspectHealth(probesFor(healthy));
    expect(rows.map(({ id }) => id)).toEqual(HEALTH_SUBSYSTEMS.map(({ id }) => id));
  });
});
