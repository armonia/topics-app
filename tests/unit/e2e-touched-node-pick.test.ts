/**
 * The e2e-touched gate builds the client bundle, and Vite refuses to start on
 * a Node older than 20.19. Under launchd the Node first in PATH was 18.14.0,
 * so the gate answered NOT MEASURED and a delivery was refused for a red that
 * belonged to the machine. These tests pin the choice of interpreter: PATH
 * when it is good enough, a named build only when it is not.
 * @covers KANBAN-78
 */
import { describe, it, expect } from "bun:test";
import { parseNodeVersion, nodeIsRecentEnough, pickNodeBin } from "../../scripts/check-e2e-touched";

describe("parseNodeVersion", () => {
  it("reads the major and minor of a normal --version line", () => {
    expect(parseNodeVersion("v20.19.0\n")).toEqual({ major: 20, minor: 19 });
    expect(parseNodeVersion("v18.14.0")).toEqual({ major: 18, minor: 14 });
  });

  it("returns null on anything it cannot read", () => {
    expect(parseNodeVersion("")).toBeNull();
    expect(parseNodeVersion("command not found")).toBeNull();
  });
});

describe("nodeIsRecentEnough", () => {
  it("accepts the floor and everything above it", () => {
    expect(nodeIsRecentEnough({ major: 20, minor: 19 })).toBe(true);
    expect(nodeIsRecentEnough({ major: 22, minor: 0 })).toBe(true);
    expect(nodeIsRecentEnough({ major: 25, minor: 9 })).toBe(true);
  });

  it("rejects what Vite rejects, and an unknown version", () => {
    expect(nodeIsRecentEnough({ major: 20, minor: 18 })).toBe(false);
    expect(nodeIsRecentEnough({ major: 18, minor: 14 })).toBe(false);
    expect(nodeIsRecentEnough(null)).toBe(false);
  });
});

describe("pickNodeBin", () => {
  it("stays out of the way when the inherited Node is good enough", () => {
    const pick = pickNodeBin((bin) => (bin === "node" ? "v22.12.0" : "v25.9.0"), ["/opt/homebrew/bin/node"]);
    expect(pick).toBeNull();
  });

  it("names the first good fallback when PATH gives an old Node", () => {
    const versions: Record<string, string> = {
      node: "v18.14.0",
      "/usr/local/bin/node": "v18.14.0",
      "/opt/homebrew/bin/node": "v25.9.0",
    };
    const pick = pickNodeBin((bin) => versions[bin] ?? null, ["/usr/local/bin/node", "/opt/homebrew/bin/node"]);
    expect(pick).toBe("/opt/homebrew/bin/node");
  });

  it("gives up rather than guess when no candidate qualifies", () => {
    const pick = pickNodeBin(() => "v18.14.0", ["/usr/local/bin/node"]);
    expect(pick).toBeNull();
  });
});
