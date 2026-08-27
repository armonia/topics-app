/**
 * @covers BROWSER-PORT-01 — the port -> project resolver behind the open-pane
 * warning. (It used to declare the card uuid `f9cf765e`, which reads like a
 * declaration but is invisible to `check-spec-coverage`: that gate only counts
 * ids shaped `PREFIX-<number>`, so this file was traced by one gate and unseen
 * by the other.)
 * All fakes: no real `lsof`, so this is the hermetic half of the feature (the
 * real-deps wiring is exercised end-to-end in browser-bridge.test.ts with
 * injected fakes too, never against the actual machine's listening ports).
 */
import { describe, test, expect } from "bun:test";
import {
  checkPortOwnership,
  formatPortWarning,
  isSameProject,
  parseLoopbackPort,
  type PortOwnerDeps,
} from "./port-project-owner";

function fakeDeps(over: Partial<PortOwnerDeps> = {}): PortOwnerDeps {
  return {
    findListener: async () => null,
    cwdForPid: async () => null,
    ...over,
  };
}

describe("parseLoopbackPort", () => {
  test("localhost with an explicit port", () => {
    expect(parseLoopbackPort("http://localhost:5173/app")).toBe(5173);
  });

  test("127.0.0.1 with an explicit port", () => {
    expect(parseLoopbackPort("http://127.0.0.1:8080/")).toBe(8080);
  });

  test("::1 with an explicit port", () => {
    expect(parseLoopbackPort("http://[::1]:3000/")).toBe(3000);
  });

  test("a real host is not a loopback port, no matter the port", () => {
    expect(parseLoopbackPort("https://example.com:5173/")).toBeNull();
  });

  test("localhost with no explicit port (default 80/443) does not count", () => {
    expect(parseLoopbackPort("http://localhost/")).toBeNull();
  });

  test("not a URL at all", () => {
    expect(parseLoopbackPort("not a url")).toBeNull();
  });
});

describe("isSameProject", () => {
  test("identical paths", () => {
    expect(isSameProject("/Users/x/Projects/foo", "/Users/x/Projects/foo")).toBe(true);
  });

  test("trailing slash does not matter", () => {
    expect(isSameProject("/Users/x/Projects/foo/", "/Users/x/Projects/foo")).toBe(true);
  });

  test("owner cwd nested inside the caller's project", () => {
    expect(isSameProject("/Users/x/Projects/foo/client", "/Users/x/Projects/foo")).toBe(true);
  });

  test("caller's project nested inside the owner cwd", () => {
    expect(isSameProject("/Users/x/Projects/foo", "/Users/x/Projects/foo/client")).toBe(true);
  });

  test("unrelated projects", () => {
    expect(isSameProject("/Users/x/Projects/darkroom", "/Users/x/Projects/topics-app")).toBe(false);
  });

  test("one being a prefix of the other's NAME is not containment", () => {
    // "foo-bar" starts with "foo" as a string, but is not a subdirectory of it.
    expect(isSameProject("/Users/x/Projects/foo-bar", "/Users/x/Projects/foo")).toBe(false);
  });
});

describe("checkPortOwnership", () => {
  test("not a loopback URL -> no warning, no lsof call", async () => {
    let called = false;
    const deps = fakeDeps({ findListener: async () => { called = true; return null; } });
    const result = await checkPortOwnership("https://example.com/", "/proj", deps);
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  test("nobody answers on the port -> no-response", async () => {
    const deps = fakeDeps({ findListener: async () => null });
    const result = await checkPortOwnership("http://localhost:5173/", "/proj", deps);
    expect(result).toEqual({ kind: "no-response", port: 5173 });
  });

  test("port served by the caller's own project -> no warning", async () => {
    const deps = fakeDeps({
      findListener: async () => ({ pid: 111, command: "bun" }),
      cwdForPid: async () => "/Users/x/Projects/topics-app",
    });
    const result = await checkPortOwnership("http://localhost:3333/", "/Users/x/Projects/topics-app", deps);
    expect(result).toBeNull();
  });

  test("port served by a DIFFERENT project -> foreign-project", async () => {
    const deps = fakeDeps({
      findListener: async () => ({ pid: 222, command: "node" }),
      cwdForPid: async () => "/Users/x/Projects/darkroom",
    });
    const result = await checkPortOwnership("http://127.0.0.1:3333/", "/Users/x/Projects/topics-app", deps);
    expect(result).toEqual({
      kind: "foreign-project",
      port: 3333,
      pid: 222,
      command: "node",
      ownerCwd: "/Users/x/Projects/darkroom",
    });
  });

  test("caller has no known project -> never guess, no warning", async () => {
    const deps = fakeDeps({
      findListener: async () => ({ pid: 222, command: "node" }),
      cwdForPid: async () => "/Users/x/Projects/darkroom",
    });
    const result = await checkPortOwnership("http://localhost:3333/", null, deps);
    expect(result).toBeNull();
  });

  test("owner's cwd cannot be read -> never accuse on a guess", async () => {
    const deps = fakeDeps({
      findListener: async () => ({ pid: 222, command: "node" }),
      cwdForPid: async () => null,
    });
    const result = await checkPortOwnership("http://localhost:3333/", "/Users/x/Projects/topics-app", deps);
    expect(result).toBeNull();
  });
});

describe("formatPortWarning", () => {
  test("no-response reads as an actionable line, not a stack trace", () => {
    const line = formatPortWarning({ kind: "no-response", port: 5173 });
    expect(line).toContain("5173");
    expect(line.startsWith("⚠")).toBe(true);
  });

  test("foreign-project names the pid, the command and the real owner", () => {
    const line = formatPortWarning({
      kind: "foreign-project",
      port: 3333,
      pid: 222,
      command: "node",
      ownerCwd: "/Users/x/Projects/darkroom",
    });
    expect(line).toContain("3333");
    expect(line).toContain("222");
    expect(line).toContain("node");
    expect(line).toContain("/Users/x/Projects/darkroom");
  });
});
