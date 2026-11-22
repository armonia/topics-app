/**
 * A native nav error reported from the Mac must leave one grep-able line in
 * the server log: pane, host, code, WebKit's description, time.
 *
 * @covers BROWSER-01
 */
import { describe, expect, test } from "bun:test";
import { formatNavErrorLogLine, logNavError } from "./browser-nav-error-log";

describe("browser-nav-error-log", () => {
  test("the line names pane, host, code and WebKit's own words", () => {
    const line = formatNavErrorLogLine({
      paneId: "task-590a3979-ngithub-support",
      host: "support.github.com",
      code: -1202,
      description: "This connection is not private.",
      at: new Date(2026, 10, 22, 14, 22).getTime(),
    });
    expect(line).toContain("task-590a3979-ngithub-support");
    expect(line).toContain("support.github.com");
    expect(line).toContain("-1202");
    expect(line).toContain("This connection is not private.");
    expect(line).toContain("14:22");
  });

  test("logNavError sends exactly that line to its sink", () => {
    const heard: string[] = [];
    logNavError(
      { paneId: "p1", host: "example.com", code: -1004, description: "Could not connect.", at: 1_700_000_000_000 },
      (line) => heard.push(line),
    );
    expect(heard).toEqual([formatNavErrorLogLine({ paneId: "p1", host: "example.com", code: -1004, description: "Could not connect.", at: 1_700_000_000_000 })]);
  });

  test("defaults to console.warn when no sink is given", () => {
    const original = console.warn;
    const heard: string[] = [];
    console.warn = (line: string) => heard.push(line);
    try {
      logNavError({ paneId: "p1", host: "example.com", code: -1004, description: "Could not connect.", at: 1_700_000_000_000 });
    } finally {
      console.warn = original;
    }
    expect(heard).toHaveLength(1);
  });
});
