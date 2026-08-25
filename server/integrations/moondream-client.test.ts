/**
 * Unit tests for the vision-text de-loop guard (browser_read_screen). Pure
 * logic, no network — verifies a degenerate moondream decode loop can't flood
 * the agent context.
  * @covers VISION-01
 */
import { describe, it, expect } from "bun:test";
import { clampVisionText } from "./moondream-client";

describe("clampVisionText", () => {
  it("passes short normal text through unchanged", () => {
    const t = "A login form with an email field and a blue Sign in button.";
    expect(clampVisionText(t)).toBe(t);
  });

  it("collapses an infinitely repeated word", () => {
    const out = clampVisionText("error " + "the ".repeat(5000));
    expect(out.length).toBeLessThan(60);
    // collapses to the minimal repeating unit: 3× "the"
    expect(out).toBe("error the the the");
  });

  it("collapses a repeated phrase (n-gram loop)", () => {
    const out = clampVisionText(("page not found ").repeat(2000).trim());
    expect(out.length).toBeLessThan(200);
    expect(out.startsWith("page not found page not found page not found")).toBe(true);
  });

  it("collapses repeated lines", () => {
    const out = clampVisionText(Array(500).fill("Loading...").join("\n"));
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("hard-caps very long non-repeating text", () => {
    // distinct tokens so the de-loop can't shrink it — only the cap applies
    const words = Array.from({ length: 6000 }, (_, i) => `w${i}`).join(" ");
    const out = clampVisionText(words);
    expect(out.length).toBeLessThanOrEqual(2000 + "…[truncated]".length);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("handles empty/whitespace input", () => {
    expect(clampVisionText("")).toBe("");
    expect(clampVisionText("   \n  ")).toBe("");
  });
});
