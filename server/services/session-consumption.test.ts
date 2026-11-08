/** @covers USAGE-26 */
import { describe, expect, test } from "bun:test";
import { createSessionConsumption, type ConsumptionDeps, type ConsumptionTask, type UsageReading } from "./session-consumption";
import { topicSessionKey } from "./agent-census";

/**
 * Two cards and an idle chat on a small Mac:
 *
 *   100 server ── 101 bash tool of card A (native command) ── 102 tsc
 *   200 pty-bridge ── 210 claude of card B (a PTY sub-agent of card B's coordinator topic)
 *   300 ai-bridge ── 310 claude of a chat left open, nothing running
 */
const TOPIC_A = "aaaaaaaa-0000-0000-0000-000000000000";
const TOPIC_B = "bbbbbbbb-0000-0000-0000-000000000000";
const TOPIC_C = "cccccccc-0000-0000-0000-000000000000";

const task = (id: string, topic: string, over: Partial<ConsumptionTask> = {}): ConsumptionTask => ({
  id, text: `Card ${id}`, projectId: "acme-web-abc123", model: "claude-opus-5", machineId: null, assignedTopicId: topic,
  inProgressAt: new Date(1_000_000).toISOString(), updatedAt: null, agentTokens: 0, awaitingAnswer: false, from: null, ...over,
});

const usage = (output: number, over: Partial<UsageReading> = {}): UsageReading => ({
  inputTokens: 100, outputTokens: output, cacheReadTokens: 5_000, cacheWriteTokens: 200, billableTokens: 300 + output, source: "native", ...over,
});

function deps(over: Partial<ConsumptionDeps> = {}, clock = { t: 2_000_000 }): ConsumptionDeps & { clock: { t: number } } {
  const rows = [
    { pid: 100, ppid: 1, memKB: 400_000, cpu: 8, command: "bun server.ts" },
    { pid: 101, ppid: 100, memKB: 300_000, cpu: 120, command: "bun test" },
    { pid: 102, ppid: 101, memKB: 100_000, cpu: 60, command: "node tsc" },
    { pid: 200, ppid: 1, memKB: 40_000, cpu: 0, command: "pty-bridge" },
    { pid: 210, ppid: 200, memKB: 500_000, cpu: 30, command: "claude" },
    { pid: 300, ppid: 1, memKB: 80_000, cpu: 0, command: "ai-bridge" },
    { pid: 310, ppid: 300, memKB: 600_000, cpu: 0, command: "claude" },
  ];
  return {
    clock,
    now: () => clock.t,
    table: async () => ({ rows, roots: [{ id: "server", pid: 100 }, { id: "pty-bridge", pid: 200 }, { id: "ai-bridge", pid: 300 }], cores: 10 }),
    tasks: () => [task("A", TOPIC_A), task("B", TOPIC_B)],
    terminals: () => [{ id: "pty-1", name: "worker", topicId: null, parentSessionKey: topicSessionKey(TOPIC_B), createdAt: "2026-01-01T00:00:00Z", busy: true, pid: 210 }],
    cliPids: () => [{ sessionKey: topicSessionKey(TOPIC_C), pid: 310 }],
    nativeCommands: () => [{ sessionKey: topicSessionKey(TOPIC_A), pid: 101 }],
    scriptOwners: () => [],
    unownedScripts: () => [],
    usageOf: (key) => (key === topicSessionKey(TOPIC_A) ? usage(1000) : null),
    topicsBySessionKey: () => new Map(),
    projectName: ({ boardId }) => (boardId ? "acme-web" : null),
    remoteMachineName: () => null,
    ...over,
  };
}

describe("session consumption", () => {
  test("a card is billed its tools and its sub-agent's tree, plus a slice of what it shares", async () => {
    const svc = createSessionConsumption(deps());
    const a = await svc.read();
    const cardA = a.sessions.find((s) => s.key === "card:A")!;
    const cardB = a.sessions.find((s) => s.key === "card:B")!;
    // A: bash tool 300_000 + tsc 100_000 = ~391 MB own; the server (400_000) is shared by the 2 live cards (idle chat is not a user).
    expect(cardA.ownMB).toBe(391);
    expect(cardA.shares).toEqual([{ id: "server", totalMB: 391, of: 2, mb: 195, cpuPct: 0.4 }]);
    // B: the PTY sub-agent folds into the card; the pty-bridge has one live user.
    expect(cardB.ownMB).toBe(488);
    expect(cardB.shares.map((s) => [s.id, s.of])).toEqual([["server", 2], ["pty-bridge", 1]]);
    expect(cardA.procs.map((p) => p.name)).toEqual(["bun", "node"]);
    expect(cardA.title).toBe("Card A");
    expect(cardA.model).toBe("claude-opus-5");
    expect(cardA.project).toBe("acme-web");
  });

  test("no double count: the live sessions, the idle chat and the remainder add up to the table", async () => {
    const answer = await createSessionConsumption(deps()).read();
    const billedKB = answer.sessions.reduce((s, x) => s + (x.memMB ?? 0), 0) * 1024;
    const idleKB = answer.idle.memMB * 1024;
    const restKB = answer.unattributed.memMB * 1024;
    const tableKB = 400_000 + 300_000 + 100_000 + 40_000 + 500_000 + 80_000 + 600_000;
    // Rounded to MB per line: tolerate the rounding of seven lines.
    expect(Math.abs(billedKB + idleKB + restKB - tableKB)).toBeLessThan(8 * 1024);
    // The chat left open is idle: listed apart, never shared out; its bridge has no live user and stays unattributed.
    expect(answer.sessions.map((s) => s.key)).toEqual(["card:A", "card:B"]);
    expect(answer.idle).toEqual({ sessions: 1, memMB: 586 });
    expect(answer.unattributed.memMB).toBe(78);
  });

  test("tokens come from the registry, the card counter only where nothing else reads", async () => {
    const answer = await createSessionConsumption(deps({ tasks: () => [task("A", TOPIC_A, { agentTokens: 99 }), task("B", TOPIC_B, { agentTokens: 4200 })] })).read();
    const a = answer.sessions.find((s) => s.key === "card:A")!;
    const b = answer.sessions.find((s) => s.key === "card:B")!;
    expect(a.tokens).toEqual({ input: 100, output: 1000, cacheRead: 5000, cacheWrite: 200, total: 1300, source: "native" });
    // The registry wins over the card's own counter for A: never summed with it.
    expect(a.tokens!.total).toBe(1300);
    expect(b.tokens).toEqual({ input: null, output: null, cacheRead: null, cacheWrite: null, total: 4200, source: "card" });
    expect(b.tps).toBeNull();
  });

  test("tokens per second grow from the output counter over the window; a quiet read says 0", async () => {
    let out = 1000;
    const clock = { t: 2_000_000 };
    const svc = createSessionConsumption(deps({ usageOf: (k) => (k === topicSessionKey(TOPIC_A) ? usage(out) : null) }, clock));
    const first = await svc.read();
    expect(first.sessions[0]!.tps).toBeNull(); // one sample: nothing to difference
    clock.t += 10_000; out += 400;
    const second = await svc.read();
    expect(second.sessions[0]!.tps).toBe(40);
    expect(second.windowS).toBe(30);
    clock.t += 10_000;
    const third = await svc.read();
    expect(third.sessions[0]!.tps).toBe(20);
  });

  test("a chat shows up once it produces output, and sub-agents never appear as sessions of their own", async () => {
    let out = 0;
    const clock = { t: 2_000_000 };
    const svc = createSessionConsumption(deps({ usageOf: (k) => (k === topicSessionKey(TOPIC_C) ? usage(out) : null), topicsBySessionKey: () => new Map([[topicSessionKey(TOPIC_C), { id: TOPIC_C, name: "Una chat", projectPath: "/p/studio", model: "claude-sonnet-5" }]]), projectName: ({ path }) => (path ? "studio" : "acme-web") }, clock));
    await svc.read();
    clock.t += 5_000; out = 800;
    const answer = await svc.read();
    const chat = answer.sessions.find((s) => s.kind === "chat")!;
    expect(chat.title).toBe("Una chat");
    expect(chat.model).toBe("claude-sonnet-5");
    expect(chat.project).toBe("studio");
    expect(answer.sessions.filter((s) => s.key.startsWith("terminal:"))).toHaveLength(0);
    // The chat is now a user of the AI bridge, which it holds whole.
    expect(chat.shares.find((s) => s.id === "ai-bridge")).toMatchObject({ of: 1 });
    expect(answer.idle.sessions).toBe(0);
  });

  test("a card running on another machine is listed, with nothing measured here", async () => {
    const answer = await createSessionConsumption(deps({ tasks: () => [task("R", TOPIC_A, { machineId: "pc-1" })], remoteMachineName: (id) => (id ? "PC" : null) })).read();
    const r = answer.sessions[0]!;
    expect(r.machine).toBe("PC");
    expect(r.memMB).toBeNull();
    expect(r.cpuPct).toBeNull();
    expect(r.procs).toEqual([]);
    expect(r.shares).toEqual([]);
    // What this machine still holds for that card is nobody's here, but it is counted: nothing falls out of the sum.
    const tableKB = 400_000 + 300_000 + 100_000 + 40_000 + 500_000 + 80_000 + 600_000;
    const billedMB = answer.sessions.reduce((n, x) => n + (x.memMB ?? 0), 0);
    const accountedKB = (billedMB + answer.idle.memMB + answer.unattributed.memMB) * 1024;
    expect(Math.abs(accountedKB - tableKB)).toBeLessThan(8 * 1024);
  });

  test("work sent to the PC is billed to the sessions of its project and divided, and the rule is stated", async () => {
    const answer = await createSessionConsumption(deps()).read({
      remote: { machine: "Studio PC", jobs: [{ what: "i test nel browser", project: "acme-web", who: "Mac", since: 5 }], load: { memMB: 3000, cpuPct: 400 } },
    });
    // Both cards belong to acme-web: each takes half of the job's part.
    for (const s of answer.sessions) expect(s.remote).toEqual([{ what: "i test nel browser", where: "Studio PC", who: "Mac", since: 5, of: 2, memMB: 1500, cpuPct: 200 }]);
    expect(answer.rule).toBe("equal");
  });

  test("a table that cannot be read leaves the sessions listed with no machine figures", async () => {
    const answer = await createSessionConsumption(deps({ table: async () => null })).read();
    expect(answer.sessions).toHaveLength(2);
    expect(answer.sessions[0]!.memMB).toBeNull();
    expect(answer.sessions[0]!.tokens).not.toBeNull();
  });
});
