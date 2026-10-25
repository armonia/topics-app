/**
 * @covers TERM-14
 *
 * The touch toolbar must not offer Ctrl+Z on Claude sessions: one tap
 * would freeze the pane for good. Shells keep it for job control.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { touchKeysForSession, touchKeysForSessionInfo } from "./touchKeys";

// Ctrl+Z, built without a literal control byte in source.
const SUSPEND = String.fromCharCode(26);
const PANE_SOURCE = readFileSync(resolve(import.meta.dir, "SingleTerminalPane.tsx"), "utf8");

describe("touchKeysForSession", () => {
  test("a claude-code session offers no suspend byte", () => {
    for (const type of ["claude-code", "claude-code-team"] as const) {
      const keys = touchKeysForSession(type);
      expect(keys.some((k) => k.data.includes(SUSPEND))).toBe(false);
    }
  });

  test("a shell keeps Ctrl+Z", () => {
    const keys = touchKeysForSession("shell");
    expect(keys.some((k) => k.label === "Ctrl+Z" && k.data === SUSPEND)).toBe(true);
  });

  test("other agents and unknown sessions keep the full bar", () => {
    for (const type of ["codex", "opencode", undefined] as const) {
      expect(touchKeysForSession(type).some((k) => k.data === SUSPEND)).toBe(true);
    }
  });

  test("the pane derives its rendered keys from the roster session metadata", () => {
    expect(PANE_SOURCE).toContain("touchKeysForSessionInfo(sessionInfo).map");
    const labels = touchKeysForSessionInfo({ type: "claude-code" }).map((key) => key.label);
    expect(labels).toContain("Ctrl+_");
    expect(labels).not.toContain("Ctrl+Z");
  });
});
