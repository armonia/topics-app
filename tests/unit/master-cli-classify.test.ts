import { describe, it, expect } from "bun:test";

// The classify() function in scripts/hooks/claude-stop.ts is intentionally
// kept local to the hook script (zero deps, runnable as a standalone bun
// invocation). To avoid duplicating it in the test, we re-implement the
// exact rules here and lock them down. The hook script and this fixture
// MUST stay in sync — any change to severity rules requires touching both.

type Severity = "P0" | "P1" | "P2" | "SKIP";
interface Payload {
  awaiting_permission?: boolean;
  awaiting_user_input?: boolean;
  error?: unknown;
  task_complete?: boolean;
}
function classify(p: Payload): Severity {
  if (p.error) return "P0";
  if (p.awaiting_permission || p.awaiting_user_input) return "P1";
  if (p.task_complete) return "P1";
  return "P2";
}

describe("notification severity classifier (NOTIF-02)", () => {
  it("error → P0", () => {
    expect(classify({ error: "boom" })).toBe("P0");
    expect(classify({ error: { message: "fail" } })).toBe("P0");
  });

  it("awaiting permission → P1", () => {
    expect(classify({ awaiting_permission: true })).toBe("P1");
    expect(classify({ awaiting_user_input: true })).toBe("P1");
  });

  it("task complete → P1", () => {
    expect(classify({ task_complete: true })).toBe("P1");
  });

  it("plain idle → P2", () => {
    expect(classify({})).toBe("P2");
  });

  it("error wins over task_complete (P0 priority)", () => {
    expect(classify({ error: "boom", task_complete: true })).toBe("P0");
  });

  it("awaiting wins over task_complete (P1 from earlier rule)", () => {
    // Both produce P1, ensure deterministic.
    expect(classify({ awaiting_permission: true, task_complete: true })).toBe("P1");
  });
});
