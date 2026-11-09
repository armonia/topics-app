/** @covers USAGE-26 */
import { describe, expect, test } from "bun:test";
import { projectLabel } from "./project-label";

describe("projectLabel", () => {
  test("the project's own name wins; else the board id loses its hash; never the bare id", () => {
    const names = new Map([["acme-web-abc123", "Acme Web"]]);
    expect(projectLabel("acme-web-abc123", names)).toBe("Acme Web");
    expect(projectLabel("studio-x-gr9brd", names)).toBe("studio-x");
    expect(projectLabel("plain", names)).toBe("plain");
  });
});
