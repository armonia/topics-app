/**
 * The hooks file and its runner, driven against real shell commands.
 *
 * The parse is exercised with the shapes a human actually produces (broken
 * JSON, a typo in the event name, a missing command) and the runner with a
 * `sleep` far longer than its ceiling: the assertion that matters is the
 * clock, because a runner that waits for the death it asked for is the bug
 * the ceiling exists to prevent.
 * @covers HOOKS-01, HOOKS-02, HOOKS-03
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOOK_EVENTS,
  createLifecycleHooks,
  parseHooksConfig,
  type LifecycleHookPayload,
} from "./lifecycle-hooks";

function payload(over: Partial<LifecycleHookPayload> = {}): LifecycleHookPayload {
  return { hook_event_name: "pre-tool", session_id: "s1", cwd: process.cwd(), ...over };
}

describe("parseHooksConfig is tolerant and its vocabulary is closed", () => {
  test("the four events are exactly these", () => {
    expect([...HOOK_EVENTS]).toEqual(["pre-tool", "turn-end", "task-deliver", "worktree-create"]);
  });

  test("broken JSON: zero hooks and exactly one warning", () => {
    const { hooks, warnings } = parseHooksConfig("{ this is not json");
    expect(hooks).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not valid JSON");
  });

  test("a wrong top-level shape: zero hooks and one warning", () => {
    const { hooks, warnings } = parseHooksConfig(JSON.stringify({ hooks: "nope" }));
    expect(hooks).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test("an unknown event is dropped AND named; the known ones next to it still load", () => {
    const { hooks, warnings } = parseHooksConfig(JSON.stringify({
      hooks: [
        { event: "post-tool", cmd: "echo x" },
        { event: "pre-tool", cmd: "echo a", tool: "bash", timeoutMs: 500 },
        { event: "task-deliver", cmd: "echo b" },
      ],
    }));
    expect(hooks.map((h) => h.event)).toEqual(["pre-tool", "task-deliver"]);
    expect(hooks[0]).toEqual({ event: "pre-tool", cmd: "echo a", tool: "bash", timeoutMs: 500 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("post-tool");
  });

  test("the ceiling defaults to 10 s and never exceeds 60 s", () => {
    const { hooks } = parseHooksConfig(JSON.stringify({
      hooks: [
        { event: "turn-end", cmd: "true" },
        { event: "turn-end", cmd: "true", timeoutMs: 600_000 },
      ],
    }));
    expect(hooks[0]!.timeoutMs).toBe(10_000);
    expect(hooks[1]!.timeoutMs).toBe(60_000);
  });

  test("an entry without a command is dropped with a warning", () => {
    const { hooks, warnings } = parseHooksConfig(JSON.stringify({ hooks: [{ event: "pre-tool" }] }));
    expect(hooks).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe("the runner: exit code is the verdict, stderr is the reason", () => {
  let dir: string;
  let file: string;
  let log: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lifecycle-hooks-"));
    file = join(dir, "hooks.json");
    log = [];
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const writeHooks = (hooks: unknown[]) => writeFileSync(file, JSON.stringify({ hooks }));
  const runner = () => createLifecycleHooks({ file, log: (m) => log.push(m) });

  test("no file: every event proceeds and nothing is logged", async () => {
    expect(await runner().run("pre-tool", payload({ tool_name: "bash" }))).toEqual({ ok: true });
    expect(log).toEqual([]);
  });

  test("a malformed file: the event proceeds, one warning, not one per event", async () => {
    writeFileSync(file, "nope");
    const r = runner();
    expect(await r.run("pre-tool", payload())).toEqual({ ok: true });
    expect(await r.run("turn-end", payload({ hook_event_name: "turn-end" }))).toEqual({ ok: true });
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("not valid JSON");
  });

  test("non-zero exit blocks, and the reason is what the command wrote on stderr", async () => {
    writeHooks([{ event: "pre-tool", cmd: "echo 'no rm on fridays' >&2; exit 1" }]);
    const out = await runner().run("pre-tool", payload({ tool_name: "bash", tool_input: { command: "rm -rf x" } }));
    expect(out).toEqual({ ok: false, reason: "no rm on fridays" });
  });

  test("exit zero is silent", async () => {
    writeHooks([{ event: "pre-tool", cmd: "echo chatter >&2; exit 0" }]);
    expect(await runner().run("pre-tool", payload({ tool_name: "bash" }))).toEqual({ ok: true });
    expect(log).toEqual([]);
  });

  test("the payload arrives on stdin with the incoming-hook field names", async () => {
    const seen = join(dir, "seen.json");
    writeHooks([{ event: "pre-tool", cmd: `cat > ${JSON.stringify(seen)}` }]);
    await runner().run("pre-tool", payload({ tool_name: "write_file", tool_input: { path: "a.txt" }, cwd: dir }));
    const got = JSON.parse(await Bun.file(seen).text());
    expect(got).toEqual({
      hook_event_name: "pre-tool", session_id: "s1", cwd: dir,
      tool_name: "write_file", tool_input: { path: "a.txt" },
    });
  });

  test("the tool filter narrows a pre-tool hook to one tool name", async () => {
    writeHooks([{ event: "pre-tool", tool: "bash", cmd: "exit 1" }]);
    const r = runner();
    expect(await r.run("pre-tool", payload({ tool_name: "read_file" }))).toEqual({ ok: true });
    expect(await r.run("pre-tool", payload({ tool_name: "bash" }))).toEqual({ ok: false, reason: expect.any(String) });
  });

  test("a hook on one event never fires on another", async () => {
    writeHooks([{ event: "worktree-create", cmd: "exit 1" }]);
    expect(await runner().run("task-deliver", payload({ hook_event_name: "task-deliver" }))).toEqual({ ok: true });
  });

  test("the file is re-read at every event: an edit takes effect without a restart", async () => {
    const r = runner();
    writeHooks([{ event: "turn-end", cmd: "exit 0" }]);
    expect(await r.run("turn-end", payload({ hook_event_name: "turn-end" }))).toEqual({ ok: true });
    writeHooks([{ event: "turn-end", cmd: "echo changed >&2; exit 2" }]);
    expect(await r.run("turn-end", payload({ hook_event_name: "turn-end" }))).toEqual({ ok: false, reason: "changed" });
  });

  test("timeout: `sleep 5` under a 300 ms ceiling answers 'not blocked' well within 1500 ms", async () => {
    writeHooks([{ event: "pre-tool", cmd: "sleep 5", timeoutMs: 300 }]);
    const t0 = Date.now();
    const out = await runner().run("pre-tool", payload({ tool_name: "bash" }));
    const elapsed = Date.now() - t0;
    console.log(`[lifecycle-hooks timeout test] answered in ${elapsed}ms`);
    expect(out).toEqual({ ok: true });
    expect(elapsed).toBeLessThan(1500);
    expect(log.some((l) => l.includes("exceeded 300ms"))).toBe(true);
  }, 10_000);

  test("a command that traps SIGTERM still cannot hold the answer past the grace", async () => {
    writeHooks([{ event: "pre-tool", cmd: "trap '' TERM; sleep 5", timeoutMs: 200 }]);
    const t0 = Date.now();
    const out = await runner().run("pre-tool", payload({ tool_name: "bash" }));
    expect(out).toEqual({ ok: true });
    expect(Date.now() - t0).toBeLessThan(1500);
  }, 10_000);

  test("a command that cannot be spawned is not a refusal", async () => {
    writeHooks([{ event: "task-deliver", cmd: "true" }]);
    const r = createLifecycleHooks({
      file,
      log: (m) => log.push(m),
      spawn: (() => { throw new Error("ENOENT: /bin/sh missing"); }) as never,
    });
    expect(await r.run("task-deliver", payload({ hook_event_name: "task-deliver" }))).toEqual({ ok: true });
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("spawn failed");
  });

  test("a cwd that does not exist is a start failure, not a veto", async () => {
    writeHooks([{ event: "worktree-create", cmd: "exit 1" }]);
    const out = await runner().run("worktree-create", payload({ hook_event_name: "worktree-create", cwd: join(dir, "missing") }));
    expect(out).toEqual({ ok: true });
    expect(log.some((l) => l.includes("could not start"))).toBe(true);
  });
});
