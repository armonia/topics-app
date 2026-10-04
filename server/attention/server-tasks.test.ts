/**
 * A chat's server is never a task of its attention state (BGVIS-09).
 *
 * A dev server an agent starts with `Bash` and `run_in_background` is a task
 * of the CLI, and three writers put the CLI's tasks in the chat's map: its
 * snapshot (`setBackgroundTasks`), the hooks (`applyTaskChanges`, async and
 * possibly late) and the turn's end (`turnEnded`). Once the registry sees the
 * task's shell listen on a port (`isServerTask`), none of them may keep the
 * chat `working` on it, and its leaving arms no T7 wait: nothing will report.
 * @covers BGVIS-09
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyTaskChanges, configureAttentionStore, getAttention, resetAttentionStore, setBackgroundTasks, turnEnded, turnStarted } from "./store";
import { taskChangesOfHook } from "./background-tasks";

const AT = "2026-10-05T10:00:00.000Z";
const servers = new Set<string>();

beforeEach(() => {
  resetAttentionStore();
  servers.clear();
  configureAttentionStore({
    db: () => null,
    broadcast: () => {},
    recordRow: () => null,
    sendPush: () => {},
    graceMs: 60_000,
    isServerTask: (subject, id) => servers.has(`${subject}|${id}`),
  });
});
afterEach(() => resetAttentionStore());

const bash = (label: string) => ({ kind: "bash", label, startedAt: AT });

describe("a background Bash that listens on a port", () => {
  it("leaves the map at the snapshot that follows its port, and the chat is no longer working", () => {
    const subject = "topic:dev";
    turnStarted(subject);
    turnEnded(subject, { turnId: "m1", outcome: "done", background: { bsrv1: bash("bun run dev") } });
    expect(getAttention(subject).state).toBe("working");

    // The registry sees the port; the CLI's snapshot still lists the task.
    servers.add(`${subject}|bsrv1`);
    setBackgroundTasks(subject, { bsrv1: bash("bun run dev") });
    const a = getAttention(subject);
    expect(a.background).toEqual([]);
    // No T7 wait (grace is a minute here): the turn's reply is read at once.
    expect(a).toMatchObject({ state: "finished", outcome: "done" });
  });

  it("is not brought back by a late PostToolUse that re-keys it", () => {
    const subject = "topic:late";
    servers.add(`${subject}|bsrv2`);
    applyTaskChanges(subject, taskChangesOfHook({
      hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_srv",
      tool_input: { command: "bun run dev", run_in_background: true },
      tool_response: { backgroundTaskId: "bsrv2" },
    }, AT));
    expect(getAttention(subject).background).toEqual([]);
    expect(getAttention(subject).state).not.toBe("working");
  });

  it("is left out of the map a turn's end writes, while a Bash that does not listen stays", () => {
    const subject = "topic:both";
    servers.add(`${subject}|bsrv3`);
    turnStarted(subject);
    turnEnded(subject, { turnId: "m1", outcome: "done", background: { bsrv3: bash("vite"), bjob1: bash("bun test") } });
    const a = getAttention(subject);
    expect(a.background.map((t) => t.id)).toEqual(["bjob1"]);
    expect(a.state).toBe("working");
  });

  it("rejoins the map when it stops listening while its shell runs on", () => {
    const subject = "topic:quiet";
    servers.add(`${subject}|bsrv4`);
    setBackgroundTasks(subject, { bsrv4: bash("node server.js") });
    expect(getAttention(subject).background).toEqual([]);
    servers.delete(`${subject}|bsrv4`);
    setBackgroundTasks(subject, { bsrv4: bash("node server.js") });
    expect(getAttention(subject).background.map((t) => t.id)).toEqual(["bsrv4"]);
    expect(getAttention(subject).state).toBe("working");
  });
});
