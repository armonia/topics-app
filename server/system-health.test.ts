/** @covers SYSTEM-03 */
import { describe, expect, test } from "bun:test";
import { HEALTH_SUBSYSTEMS, inspectHealth, ProbeTimeoutError, type HealthProbe, type HealthSubsystemId } from "../shared/system-health";

const healthy = (): { state: "ok"; reason: "ready" } => ({ state: "ok", reason: "ready" });

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
      reason: "probe-failed",
      params: { message: "socket assente" },
      lastError: { message: "socket assente", at: "1970-01-01T00:00:00.000Z" },
    });
  });

  test("every subsystem keeps its failing probe visible and actionable", async () => {
    for (const { id } of HEALTH_SUBSYSTEMS) {
      const probes = probesFor(healthy);
      probes[id] = () => { throw new Error(`${id} guasto`); };
      const row = (await inspectHealth(probes, 20)).find((item) => item.id === id);
      expect(row, id).toMatchObject({ state: "error", reason: "probe-failed", params: { message: `${id} guasto` } });
    }
  });

  test("a silent probe warns within its cap while the other probes finish", async () => {
    const probes = probesFor(healthy);
    probes["pty-bridge"] = () => new Promise(() => {});
    const started = Date.now();
    const rows = await inspectHealth(probes, 25);
    expect(Date.now() - started).toBeLessThan(250);
    expect(rows.find(({ id }) => id === "pty-bridge")).toMatchObject({ state: "warn", reason: "timeout", params: { timeoutMs: 25 }, lastError: { message: "Probe exceeded 25 ms" } });
    expect(rows.find(({ id }) => id === "server")?.state).toBe("ok");
  });

  test("does not infer a timeout from an error message", async () => {
    const probes = probesFor(healthy);
    probes["pty-bridge"] = () => { throw new Error("non risponde"); };
    const row = (await inspectHealth(probes, 25)).find(({ id }) => id === "pty-bridge");
    expect(row).toMatchObject({ state: "error", reason: "probe-failed", params: { message: "non risponde" } });
  });

  test("the timeout is identified by its error type", () => {
    expect(new ProbeTimeoutError(200)).toBeInstanceOf(ProbeTimeoutError);
    expect(new Error("non risponde")).not.toBeInstanceOf(ProbeTimeoutError);
  });

  test("always returns the full subsystem roster", async () => {
    const rows = await inspectHealth(probesFor(healthy));
    expect(rows.map(({ id }) => id)).toEqual(HEALTH_SUBSYSTEMS.map(({ id }) => id));
  });
});
