import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startClaudeEventsWatcher } from "../../server/services/claude-events-watcher";

describe("claude-events-watcher (NOTIF-01)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "topics-events-"));
    path = join(dir, "events.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("broadcasts P0 and P1 events; ignores P2 (NOTIF-05)", async () => {
    const got: any[] = [];
    const handle = startClaudeEventsWatcher({
      eventsPath: path,
      pollMs: 50,
      broadcast: (msg) => got.push(msg),
    });

    writeFileSync(path, "");
    appendFileSync(path, JSON.stringify({ ts: 1, kind: "stop", severity: "P0", payload: { error: "boom" } }) + "\n");
    appendFileSync(path, JSON.stringify({ ts: 2, kind: "stop", severity: "P1", payload: { task_complete: true } }) + "\n");
    appendFileSync(path, JSON.stringify({ ts: 3, kind: "pre_tool_use", severity: "P2", payload: {} }) + "\n");

    // Wait a couple of poll ticks
    await new Promise((r) => setTimeout(r, 150));
    handle.stop();

    expect(got.length).toBe(2);
    expect(got[0].type).toBe("claude-event");
    expect(got[0].event.severity).toBe("P0");
    expect(got[1].event.severity).toBe("P1");
  });

  it("tolerates malformed lines without crashing", async () => {
    const got: any[] = [];
    const handle = startClaudeEventsWatcher({
      eventsPath: path,
      pollMs: 50,
      broadcast: (msg) => got.push(msg),
    });

    writeFileSync(path, "");
    appendFileSync(path, "not json\n");
    appendFileSync(path, JSON.stringify({ ts: 1, kind: "stop", severity: "P1", payload: {} }) + "\n");
    appendFileSync(path, "\n");
    appendFileSync(path, "{broken\n");

    await new Promise((r) => setTimeout(r, 150));
    handle.stop();

    expect(got.length).toBe(1);
    expect(got[0].event.severity).toBe("P1");
  });

  it("handles partial lines without losing data after the next append", async () => {
    const got: any[] = [];
    const handle = startClaudeEventsWatcher({
      eventsPath: path,
      pollMs: 50,
      broadcast: (msg) => got.push(msg),
    });

    writeFileSync(path, "");
    // Write a partial line (no trailing newline yet).
    const fullEvent = JSON.stringify({ ts: 1, kind: "stop", severity: "P1", payload: {} });
    writeFileSync(path, fullEvent.slice(0, 10)); // partial chunk
    await new Promise((r) => setTimeout(r, 100));
    expect(got.length).toBe(0); // partial line was not yet emitted

    // Complete the line.
    writeFileSync(path, fullEvent + "\n");
    await new Promise((r) => setTimeout(r, 150));
    handle.stop();

    expect(got.length).toBe(1);
    expect(got[0].event.payload).toEqual({});
  });

  it("recovers from file truncation (rotation)", async () => {
    const got: any[] = [];
    const handle = startClaudeEventsWatcher({
      eventsPath: path,
      pollMs: 50,
      broadcast: (msg) => got.push(msg),
    });

    writeFileSync(path, "");
    appendFileSync(path, JSON.stringify({ ts: 1, kind: "stop", severity: "P1", payload: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 100));
    expect(got.length).toBe(1);

    // Rotate (truncate + new content).
    writeFileSync(path, JSON.stringify({ ts: 2, kind: "stop", severity: "P0", payload: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 150));
    handle.stop();

    expect(got.length).toBe(2);
    expect(got[1].event.severity).toBe("P0");
  });

  it("flags P1 as suppressed when Focus probe returns true; never suppresses P0 (NOTIF-03)", async () => {
    const got: any[] = [];
    let focusActive = true;
    const handle = startClaudeEventsWatcher({
      eventsPath: path,
      pollMs: 50,
      broadcast: (msg) => got.push(msg),
      focusProbe: () => focusActive,
    });

    writeFileSync(path, "");
    appendFileSync(path, JSON.stringify({ ts: 1, kind: "stop", severity: "P1", payload: { task_complete: true } }) + "\n");
    appendFileSync(path, JSON.stringify({ ts: 2, kind: "stop", severity: "P0", payload: { error: "boom" } }) + "\n");

    await new Promise((r) => setTimeout(r, 150));
    handle.stop();

    expect(got.length).toBe(2);
    // P1 emitted but suppressed flag set
    expect(got[0].event.severity).toBe("P1");
    expect(got[0].suppressed).toBe(true);
    // P0 emitted with suppressed=false (always delivered)
    expect(got[1].event.severity).toBe("P0");
    expect(got[1].suppressed).toBe(false);
  });

  it("works when events.jsonl does not exist initially", async () => {
    const got: any[] = [];
    // Use a path that doesn't exist yet. Parent dir exists.
    const lateDir = join(dir, "subdir");
    mkdirSync(lateDir, { recursive: true });
    const latePath = join(lateDir, "events.jsonl");
    const handle = startClaudeEventsWatcher({
      eventsPath: latePath,
      pollMs: 50,
      broadcast: (msg) => got.push(msg),
    });

    await new Promise((r) => setTimeout(r, 100));
    appendFileSync(latePath, JSON.stringify({ ts: 1, kind: "stop", severity: "P1", payload: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();

    expect(got.length).toBe(1);
  });
});
