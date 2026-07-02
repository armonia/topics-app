import { describe, test, expect } from "bun:test";
import {
  decideTerminalBanner,
  isBannerPhase,
  terminalDedupeKey,
  terminalPanelId,
  type TerminalNotifyInput,
} from "./terminalNotify";

// Minimal builder — a valid transition into awaiting-user, focus off, notify-
// when-focused off. Each test overrides just the fields it exercises.
function input(over: Partial<TerminalNotifyInput> = {}): TerminalNotifyInput {
  return {
    terminalId: "t1",
    phase: "awaiting-user",
    prevPhase: "running",
    rev: 1,
    name: "My Session",
    isFocusedAndVisible: false,
    notifyEvenWhenFocused: false,
    ...over,
  };
}

describe("isBannerPhase — actionable/terminal set only", () => {
  test("fires for the four actionable phases", () => {
    for (const p of ["awaiting-user", "awaiting-approval", "completed", "error"] as const) {
      expect(isBannerPhase(p)).toBe(true);
    }
  });
  test("does NOT fire for working / quiet phases (no every-turn spam)", () => {
    for (const p of ["starting", "running", "tool-running", "paused", "dormant"] as const) {
      expect(isBannerPhase(p)).toBe(false);
    }
  });
});

describe("terminalPanelId / terminalDedupeKey", () => {
  test("panel id matches createPaneId('terminal', id)", () => {
    expect(terminalPanelId("abc")).toBe("terminal:abc");
  });
  test("dedupe key is <terminalId>:<phase>:<rev>", () => {
    expect(terminalDedupeKey("abc", "completed", 7)).toBe("abc:completed:7");
  });
});

describe("decideTerminalBanner — transition gating", () => {
  test("fires on a genuine transition into an actionable phase", () => {
    const d = decideTerminalBanner(input());
    expect(d).not.toBeNull();
    expect(d!.title).toBe("My Session");
    expect(d!.body).toBe("In attesa di te");
    expect(d!.level).toBe("ok");
    expect(d!.dedupeKey).toBe("t1:awaiting-user:1");
  });

  test("suppresses the first frame (no prevPhase) — reconnect baseline", () => {
    expect(decideTerminalBanner(input({ prevPhase: undefined }))).toBeNull();
  });

  test("suppresses a same-phase repeat frame", () => {
    expect(decideTerminalBanner(input({ prevPhase: "awaiting-user", phase: "awaiting-user" }))).toBeNull();
  });

  test("suppresses a transition into a non-actionable phase", () => {
    expect(decideTerminalBanner(input({ prevPhase: "awaiting-user", phase: "running" }))).toBeNull();
    expect(decideTerminalBanner(input({ prevPhase: "running", phase: "tool-running" }))).toBeNull();
  });
});

describe("decideTerminalBanner — focus suppression", () => {
  test("suppresses when the tab is focused+visible and override off", () => {
    expect(decideTerminalBanner(input({ isFocusedAndVisible: true }))).toBeNull();
  });
  test("fires when focused+visible but notifyEvenWhenFocused is on", () => {
    const d = decideTerminalBanner(input({ isFocusedAndVisible: true, notifyEvenWhenFocused: true }));
    expect(d).not.toBeNull();
  });
  test("fires when not focused regardless of the override", () => {
    expect(decideTerminalBanner(input({ isFocusedAndVisible: false }))).not.toBeNull();
  });
});

describe("decideTerminalBanner — title resolution", () => {
  test("prefers the session name", () => {
    expect(decideTerminalBanner(input({ name: "Auto Name" }))!.title).toBe("Auto Name");
  });
  test("falls back to the owning topic name when unnamed", () => {
    expect(decideTerminalBanner(input({ name: undefined, fallbackTitle: "My Topic" }))!.title).toBe("My Topic");
  });
  test("falls back to a generic label with neither", () => {
    expect(decideTerminalBanner(input({ name: undefined, fallbackTitle: undefined }))!.title).toBe("Claude Code");
  });
});

describe("decideTerminalBanner — body + level per phase", () => {
  test("awaiting-user → your-turn body, ok level", () => {
    const d = decideTerminalBanner(input({ phase: "awaiting-user" }))!;
    expect(d.body).toBe("In attesa di te");
    expect(d.level).toBe("ok");
  });

  test("completed → completed body, ok level", () => {
    const d = decideTerminalBanner(input({ prevPhase: "running", phase: "completed" }))!;
    expect(d.body).toBe("Lavoro completato");
    expect(d.level).toBe("ok");
  });

  test("error → error body, warn level", () => {
    const d = decideTerminalBanner(input({ prevPhase: "running", phase: "error" }))!;
    expect(d.body).toBe("Errore — intervieni");
    expect(d.level).toBe("warn");
  });

  test("awaiting-approval with prompt → prompt as body, warn level", () => {
    const d = decideTerminalBanner(
      input({
        prevPhase: "tool-running",
        phase: "awaiting-approval",
        pendingApproval: { kind: "bash", prompt: "Run `rm -rf build`?", requestedAt: 0 },
      }),
    )!;
    expect(d.body).toBe("Run `rm -rf build`?");
    expect(d.level).toBe("warn");
  });

  test("awaiting-approval WITHOUT a prompt → generic status body", () => {
    const d = decideTerminalBanner(input({ prevPhase: "tool-running", phase: "awaiting-approval" }))!;
    expect(d.body).toBe("Serve un'approvazione");
  });

  test("approval prompt whitespace is collapsed (multi-line plan reads on one line)", () => {
    const d = decideTerminalBanner(
      input({
        prevPhase: "tool-running",
        phase: "awaiting-approval",
        pendingApproval: { kind: "plan", prompt: "Step 1\n\n  Step 2\t\tStep 3", requestedAt: 0 },
      }),
    )!;
    expect(d.body).toBe("Step 1 Step 2 Step 3");
  });

  test("a very long approval prompt is truncated with an ellipsis", () => {
    const long = "x".repeat(500);
    const d = decideTerminalBanner(
      input({
        prevPhase: "tool-running",
        phase: "awaiting-approval",
        pendingApproval: { kind: "other", prompt: long, requestedAt: 0 },
      }),
    )!;
    expect(d.body.length).toBe(180);
    expect(d.body.endsWith("…")).toBe(true);
  });
});

describe("decideTerminalBanner — dedupe key carries rev", () => {
  test("same phase, different rev → distinct keys (a genuine re-entry can fire)", () => {
    const a = decideTerminalBanner(input({ prevPhase: "running", phase: "completed", rev: 3 }))!;
    const b = decideTerminalBanner(input({ prevPhase: "running", phase: "completed", rev: 4 }))!;
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });
});
