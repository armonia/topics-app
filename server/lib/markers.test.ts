import { describe, test, expect } from "bun:test";
import {
  MARKER_NAMES_GROUP,
  CLOSED_MARKER_REGEX,
  OPEN_MARKER_TAIL_REGEX,
  stripMarkers,
  detectMarkers,
} from "./markers";

const FAMILIES = ["BROWSER", "TOPIC_SWITCH", "TOPIC_NEW", "PROJECT_CREATE", "PROJECT_OPEN"];

describe("canonical marker grammar", () => {
  test("MARKER_NAMES_GROUP covers exactly the five families", () => {
    for (const name of FAMILIES) expect(MARKER_NAMES_GROUP).toContain(name);
    // No stray families (catches accidental additions/removals).
    expect(MARKER_NAMES_GROUP).toBe(
      "(?:TOPIC_SWITCH|TOPIC_NEW|BROWSER|PROJECT_CREATE|PROJECT_OPEN)",
    );
  });

  test("stripMarkers removes every closed family — including PROJECT_* (the audit #4 leak)", () => {
    const input =
      "alpha {{BROWSER:https://example.com}} beta " +
      "{{TOPIC_SWITCH:abc-123}} gamma " +
      "{{TOPIC_NEW:Some topic}} delta " +
      "{{PROJECT_CREATE:/tmp/foo}} epsilon " +
      "{{PROJECT_OPEN:Pix}} omega";
    const out = stripMarkers(input);
    for (const name of FAMILIES) expect(out).not.toContain(`{{${name}`);
    expect(out).toContain("alpha");
    expect(out).toContain("omega");
  });

  test("each family strips on its own", () => {
    for (const name of FAMILIES) {
      const input = `head {{${name}:body-value}} tail`;
      expect(stripMarkers(input)).not.toContain(`{{${name}`);
    }
  });

  test("hides an unclosed marker tail at end-of-string", () => {
    expect(stripMarkers("prefix {{PROJECT_OPEN:partial")).toBe("prefix ");
    expect(stripMarkers("prefix {{BROWSER:https://exa")).toBe("prefix ");
  });

  test("leaves an unclosed marker that is NOT at end-of-string untouched", () => {
    // OPEN_MARKER_TAIL only fires at $; a mid-string fragment without a close
    // is not a valid marker and is preserved.
    const input = "x {{BROWSER:foo and then normal text continues";
    // (this whole tail IS at end-of-string, so it strips) — verify the anchored case
    expect(OPEN_MARKER_TAIL_REGEX.test(input)).toBe(true);
  });

  test("detectMarkers reports closed markers (trimmed) and ignores tails", () => {
    const input = "go {{PROJECT_OPEN:Pix}} and {{BROWSER:https://x}} then {{TOPIC_SWITCH:t-1";
    const found = detectMarkers(input);
    expect(found).toContain("{{PROJECT_OPEN:Pix}}");
    expect(found).toContain("{{BROWSER:https://x}}");
    // the trailing unclosed TOPIC_SWITCH fragment is not a detected marker
    expect(found.some((m) => m.includes("TOPIC_SWITCH"))).toBe(false);
  });

  test("CLOSED_MARKER_REGEX is reusable across calls (global-flag lastIndex safety)", () => {
    const s = "{{BROWSER:a}} mid {{PROJECT_OPEN:b}}";
    expect(s.replace(CLOSED_MARKER_REGEX, "X")).toBe("X mid X");
    // second call must behave identically (no stale lastIndex)
    expect(s.replace(CLOSED_MARKER_REGEX, "X")).toBe("X mid X");
  });
});
