/**
 * What a detached native turn changes in server-wide state travels in its
 * journal and is applied by the server (lossless-restart).
 *
 * @covers CCLI-04
 */
import { describe, test, expect, afterEach } from "bun:test";
import { journalHostEffects, applyTurnEffects, type HostControl } from "./turn-effects";
import type { JournalEvent } from "./turn-journal";
import { clearPlanUsage, clearProviderHold, holdForApiDown, planUsage, providerHold, recordPlanUsage, setProviderHold } from "../../lib/provider-hold";
import { _resetNativeCommands, listNativeCommands, nativeCommandByPid } from "../../lib/native-command-registry";
import { executeTool, watchNativeCommands } from "./tools";

afterEach(() => {
  clearProviderHold();
  clearPlanUsage();
  _resetNativeCommands();
});

describe("host side", () => {
  test("a hold, a plan reading and a command are journaled", () => {
    const out: JournalEvent[] = [];
    const off = journalHostEffects((ev) => out.push(ev));
    const until = Date.now() + 60_000;
    setProviderHold({ untilMs: until, window: "five_hour", reason: "spent" });
    recordPlanUsage({ fiveHour: { utilization: 100, resetsAtMs: until }, sevenDay: null });
    off();
    expect(out.map((e) => e.e)).toEqual(["hold", "plan_usage"]);
    expect((out[0] as Extract<JournalEvent, { e: "hold" }>).hold?.untilMs).toBe(until);
  });

  test("the server's hold seeds the host, and its lift is journaled", () => {
    const out: JournalEvent[] = [];
    const until = Date.now() + 60_000;
    const off = journalHostEffects((ev) => out.push(ev), { untilMs: until, window: "api-down", reason: "down", sinceMs: Date.now() });
    expect(providerHold()?.window).toBe("api-down");
    clearProviderHold();
    off();
    expect(out.at(-1)).toMatchObject({ e: "hold", hold: null });
  });
});

describe("server side", () => {
  const noControl = () => {};

  test("a journaled hold and plan reading reach the server's memo", () => {
    const fx = applyTurnEffects("topic:fx1", noControl);
    const until = Date.now() + 60_000;
    fx.apply({ e: "hold", at: Date.now(), hold: { untilMs: until, window: "five_hour", reason: "spent" } });
    expect(providerHold()?.untilMs).toBe(until);
    fx.apply({ e: "plan_usage", at: Date.now(), u: { fiveHour: { utilization: 100, resetsAtMs: until }, sevenDay: null } });
    expect(planUsage()?.fiveHour?.utilization).toBe(100);
  });

  test("a replayed old lift or reading does not undo a newer one", () => {
    const fx = applyTurnEffects("topic:fx2", noControl);
    const until = Date.now() + 60_000;
    setProviderHold({ untilMs: until, window: "five_hour", reason: "spent" });
    fx.apply({ e: "hold", at: Date.now() - 10_000, hold: null });
    expect(providerHold()?.untilMs).toBe(until);
    recordPlanUsage({ fiveHour: { utilization: 40, resetsAtMs: until }, sevenDay: null });
    fx.apply({ e: "plan_usage", at: Date.now() - 10_000, u: { fiveHour: { utilization: 99, resetsAtMs: until }, sevenDay: null } });
    expect(planUsage()?.fiveHour?.utilization).toBe(40);
  });

  test("an answered round lifts the outage hold, not one set after it", () => {
    const fx = applyTurnEffects("topic:fx3", noControl);
    const before = Date.now() - 5_000;
    holdForApiDown();
    fx.apply({ e: "api_ok", at: before });
    expect(providerHold()?.window).toBe("api-down");
    fx.apply({ e: "api_ok", at: Date.now() + 1 });
    expect(providerHold()).toBeNull();
  });

  test("a host's command is in the server's registry, and freezing it reaches the host", () => {
    const sent: HostControl[] = [];
    const fx = applyTurnEffects("topic:fx4", (m) => sent.push(m));
    fx.apply({ e: "cmd_start", pid: 4242, command: "bun test", at: 1 });
    expect(listNativeCommands().map((c) => [c.sessionKey, c.pid, c.command])).toEqual([["topic:fx4", 4242, "bun test"]]);
    nativeCommandByPid(4242)?.onFreeze();
    nativeCommandByPid(4242)?.onThaw(1500);
    expect(sent).toEqual([{ t: "freeze", pid: 4242 }, { t: "thaw", pid: 4242, frozenMs: 1500 }]);
    fx.apply({ e: "cmd_end", pid: 4242 });
    expect(listNativeCommands()).toEqual([]);
  });

  test("a turn that ends forgets its commands still registered", () => {
    const fx = applyTurnEffects("topic:fx5", noControl);
    fx.apply({ e: "cmd_start", pid: 4343, command: "sleep 100", at: 1 });
    fx.close();
    expect(listNativeCommands()).toEqual([]);
  });
});

test("a native command tells the watcher when it starts and ends", async () => {
  const seen: string[] = [];
  const off = watchNativeCommands({ started: (c) => seen.push(`start:${c.command}`), ended: () => seen.push("end") });
  try {
    await executeTool("bash", { command: "echo ciao" }, { workspace: process.cwd(), sessionKey: "topic:fx6" });
  } finally { off(); }
  expect(seen).toEqual(["start:echo ciao", "end"]);
}, 30_000);
