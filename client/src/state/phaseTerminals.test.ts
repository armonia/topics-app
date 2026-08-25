/**
 * Tests for the phase-authoritative terminal loading derivation. For a
 * claude-code session the PHASE decides: active → spinner; resting → the pty
 * heuristic is SUPPRESSED (so a freshly-opened session's TUI startup paint
 * doesn't flash "loading"). pty still drives shells and sessions whose phase
 * isn't known yet, so real work is never hidden when hooks are silent.
 * @covers MONITOR-04
 */
import { describe, test, expect } from "bun:test";
import { derivePhaseTerminals, terminalLoadingFrom, NOTABLE_CLAUDE_PHASES, ACTIVE_CLAUDE_PHASES, type TerminalPhaseLite, type TerminalRosterTypeEntry } from "./signals";

const roster = (entries: Array<[string, string, string | null]>): TerminalRosterTypeEntry[] =>
  entries.map(([id, type, claudeSessionId]) => ({ id, type, claudeSessionId }));

const phases = (entries: Array<[string, TerminalPhaseLite]>): Map<string, TerminalPhaseLite> =>
  new Map(entries);

describe("derivePhaseTerminals — active / resting partition", () => {
  test("running / tool-running / watching are active (not resting)", () => {
    for (const p of ["running", "tool-running", "watching"] as const) {
      const { active, resting } = derivePhaseTerminals(
        roster([["t1", "claude-code", "c1"]]),
        phases([["c1", { phase: p }]]),
      );
      expect([...active]).toEqual(["t1"]);
      expect([...resting]).toEqual([]);
    }
  });

  test("confidently-idle phases are resting (suppress pty)", () => {
    for (const p of ["awaiting-user", "awaiting-approval", "paused", "completed", "error", "dormant"] as const) {
      const { active, resting } = derivePhaseTerminals(
        roster([["t1", "claude-code", "c1"]]),
        phases([["c1", { phase: p }]]),
      );
      expect([...active]).toEqual([]);
      expect([...resting]).toEqual(["t1"]);
    }
  });

  test("'starting' is NEITHER active nor resting → pty drives it (work-while-starting fix)", () => {
    // A session can sit at 'starting' while genuinely working when its phase
    // hooks never advance it; suppressing pty there hid the loading spinner.
    const { active, resting } = derivePhaseTerminals(
      roster([["t1", "claude-code", "c1"]]),
      phases([["c1", { phase: "starting" }]]),
    );
    expect([...active]).toEqual([]);
    expect([...resting]).toEqual([]);
  });

  test("no phase entry → neither active nor resting (pty alone drives it)", () => {
    const { active, resting } = derivePhaseTerminals(roster([["t1", "claude-code", "c1"]]), phases([]));
    expect([...active]).toEqual([]);
    expect([...resting]).toEqual([]);
  });

  test("plain shell sessions never appear in either set", () => {
    const { active, resting } = derivePhaseTerminals(
      roster([["t1", "shell", "c1"]]),
      phases([["c1", { phase: "running" }]]),
    );
    expect([...active]).toEqual([]);
    expect([...resting]).toEqual([]);
  });

  test("claude-code-team is handled like claude-code", () => {
    const { active } = derivePhaseTerminals(
      roster([["t1", "claude-code-team", "c1"]]),
      phases([["c1", { phase: "running" }]]),
    );
    expect([...active]).toEqual(["t1"]);
  });
});

describe("terminalLoadingFrom — phase-authoritative", () => {
  test("active phase → loading even if pty idle (quiet tool call)", () => {
    expect(terminalLoadingFrom("t1", new Set(["t1"]), new Set(), new Set())).toBe(true);
  });

  test("active phase wins even if also (wrongly) resting", () => {
    expect(terminalLoadingFrom("t1", new Set(["t1"]), new Set(), new Set(["t1"]))).toBe(true);
  });

  test("resting phase SUPPRESSES pty (e.g. awaiting-user with an idle redraw)", () => {
    // A confidently-idle phase (awaiting-user/paused/completed/…) suppresses the
    // pty heuristic so a TUI repaint doesn't show loading. NB: `starting` is NOT
    // resting anymore (see derivePhaseTerminals) — this tests the function
    // contract given a resting id, not the starting phase.
    expect(terminalLoadingFrom("t1", new Set(), new Set(["t1"]), new Set(["t1"]))).toBe(false);
  });

  test("pty busy with NO resting phase → loading (shell / unknown phase fallback)", () => {
    expect(terminalLoadingFrom("t1", new Set(), new Set(["t1"]), new Set())).toBe(true);
    // and back-compat: omitting the resting arg keeps the pty fallback
    expect(terminalLoadingFrom("t1", new Set(), new Set(["t1"]))).toBe(true);
  });

  test("neither active nor pty → not loading", () => {
    expect(terminalLoadingFrom("t1", new Set(), new Set(), new Set())).toBe(false);
  });
});



describe("phase classification sets — loading vs attention buckets", () => {
  test("running / tool-running / watching are the ACTIVE (loading) phases", () => {
    expect([...ACTIVE_CLAUDE_PHASES].sort()).toEqual(["running", "tool-running", "watching"]);
  });

  test("awaiting-* and error are NOTABLE (attention) — and a phase is never both", () => {
    expect(NOTABLE_CLAUDE_PHASES.has("awaiting-approval")).toBe(true);
    expect(NOTABLE_CLAUDE_PHASES.has("awaiting-user")).toBe(true);
    expect(NOTABLE_CLAUDE_PHASES.has("error")).toBe(true);
    // loading phases must not also be attention phases (the badge/spinner split)
    for (const p of ACTIVE_CLAUDE_PHASES) expect(NOTABLE_CLAUDE_PHASES.has(p)).toBe(false);
  });

  test("paused is NOTABLE — a timed-out approval keeps its badge/dot, not vanishes", () => {
    // The reaper demotes awaiting-approval→paused but keeps pendingApproval so
    // the UI can still show the unanswered question. paused must stay notable.
    expect(NOTABLE_CLAUDE_PHASES.has("paused")).toBe(true);
  });
});
