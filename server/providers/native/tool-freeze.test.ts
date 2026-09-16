/**
 * F17 - A FROZEN COMMAND MUST NOT BE KILLED BY ITS OWN DEADLINE.
 *
 * The native runtime owns the timeout of its `bash` tool. The swap freezer can
 * SIGSTOP that command's whole tree for minutes, and a wall clock ticking
 * through the pause kills it for a wait Topics itself imposed: a red invented by
 * the brake that exists to protect the machine. So the deadline banks what is
 * left when the freeze starts and re-arms it on the thaw - and the resumed
 * command carries a line saying it was frozen, because an operation whose own
 * timeout expired INSIDE the pause (a Playwright action, measured in the T0
 * probe) fails on resume and must not read as a defect of the code.
 *
 * @covers KANBAN-85
 */
import { afterEach, describe, expect, test } from "bun:test";
import { executeTool } from "./tools";
import { _resetNativeCommands, listNativeCommands } from "../../lib/native-command-registry";

afterEach(() => { _resetNativeCommands(); });

async function waitForRegistration(timeoutMs = 5_000) {
  const from = Date.now();
  for (;;) {
    const [entry] = listNativeCommands();
    if (entry) return entry;
    if (Date.now() - from > timeoutMs) throw new Error("the native command never registered");
    await Bun.sleep(20);
  }
}

describe("the native bash deadline stops while the command is frozen", () => {
  test("a command frozen for a second outlives its own 700 ms timeout, and says so", async () => {
    const startedAt = Date.now();
    const running = executeTool(
      "bash",
      { command: "sleep 5" },
      { workspace: process.cwd(), bashTimeoutMs: 700, sessionKey: "topic:freeze" },
    );
    const entry = await waitForRegistration();
    expect(entry.sessionKey).toBe("topic:freeze");
    expect(entry.command).toBe("sleep 5");

    // Frozen at ~200 ms, with 500 ms of its budget left.
    await Bun.sleep(200);
    entry.onFreeze();
    await Bun.sleep(1_200);
    // Still alive: without the pause it would have been killed at 700 ms.
    expect(listNativeCommands()).toHaveLength(1);
    entry.onThaw(1_200);

    const out = await running;
    const elapsed = Date.now() - startedAt;
    expect(out.content).toContain("[fermo 1 s");
    expect(out.content).toContain("ucciso dopo 700ms");
    expect(elapsed, "the 500 ms left were re-armed after the thaw, not spent during it").toBeGreaterThan(1_600);
    expect(listNativeCommands(), "the registration ends with the command").toHaveLength(0);
  }, 30_000);

  test("without a session nothing is registered: a command with no owner is not a candidate", async () => {
    const running = executeTool("bash", { command: "echo ciao" }, { workspace: process.cwd() });
    expect(listNativeCommands()).toHaveLength(0);
    const out = await running;
    expect(out.content).toContain("ciao");
  }, 30_000);
});
