import { describe, expect, test } from "bun:test";
import { classifyStayLocal } from "./stay-local-audit";

describe("classifyStayLocal", () => {
  test("KEEP: text names a mac-only launch agent path", () => {
    expect(classifyStayLocal({ text: "Fix the plist under ~/Library/LaunchAgents", description: null })).toBe("KEEP");
  });

  test("KEEP: description names /Users/ even when text does not", () => {
    expect(classifyStayLocal({ text: "Investigate a crash", description: "Logs live at /Users/me/Library/Logs" })).toBe("KEEP");
  });

  test("DROP: neither text nor description names a mac-only path", () => {
    expect(classifyStayLocal({ text: "Add a retry to the fetch helper", description: "Flaky under load" })).toBe("DROP");
  });
});
