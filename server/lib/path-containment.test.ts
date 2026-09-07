/**
 * The two tests that matter here are the two ways a hand-written comparison
 * gets it wrong: the sibling with the right prefix (a bare `startsWith`) and
 * the child that uses the platform separator (a hardcoded `"/"`).
 *
 * @covers PROJECT-11
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { isInsideDir } from "./path-containment";
import { isInsideKnownProject, projectPathTokensIn } from "../services/known-project-dirs";
import { isBroadCwd } from "./broad-cwd";

const ROOT = join(sep, "tmp", "known-project");

describe("isInsideDir", () => {
  it("the directory itself is inside", () => {
    expect(isInsideDir(ROOT, ROOT)).toBe(true);
  });

  it("a child built with the platform separator is inside", () => {
    expect(isInsideDir(ROOT + sep + "src" + sep + "index.ts", ROOT)).toBe(true);
  });

  it("a sibling sharing the name prefix is outside", () => {
    expect(isInsideDir(ROOT + "-secret" + sep + "keys", ROOT)).toBe(false);
  });

  it("an upward jump is normalised before the comparison", () => {
    expect(isInsideDir(join(ROOT, "..", "elsewhere"), ROOT)).toBe(false);
  });

  it("the parent of the root is outside", () => {
    expect(isInsideDir(join(sep, "tmp"), ROOT)).toBe(false);
  });
});

describe("isInsideKnownProject", () => {
  it("takes a descendant of a known project", () => {
    const allowed = new Set([ROOT]);
    expect(isInsideKnownProject(join(ROOT, "docs", "a.md"), allowed)).toBe(true);
  });

  it("rejects the sibling with the right prefix", () => {
    const allowed = new Set([ROOT]);
    expect(isInsideKnownProject(ROOT + "-secret", allowed)).toBe(false);
  });

  it("rejects a path outside every known project", () => {
    const allowed = new Set([ROOT]);
    expect(isInsideKnownProject(join(sep, "etc", "ssh"), allowed)).toBe(false);
  });
});

describe("projectPathTokensIn - the three shapes a stored pane id uses", () => {
  it("takes the raw and the percent-encoded POSIX path", () => {
    const value = '{"panes":["project:/home/me/proj","project:%2Fhome%2Fme%2Fp2"]}';
    expect(projectPathTokensIn(value)).toEqual(["/home/me/proj", "/home/me/p2"]);
  });

  it("takes the Windows drive path, escaped in the value and percent-encoded", () => {
    const value = '{"panes":["project:C:\\\\Users\\\\me\\\\proj","project:C%3A%5CUsers%5Cme%5Cp2"]}';
    expect(projectPathTokensIn(value)).toEqual(["C:\\Users\\me\\proj", "C:\\Users\\me\\p2"]);
  });
});

describe("isBroadCwd", () => {
  it("an ancestor of HOME is broad, whatever the separator", () => {
    expect(isBroadCwd(join(sep, "home"), join(sep, "home", "me"))).toBe(true);
    expect(isBroadCwd(join(sep, "home", "me", "proj"), join(sep, "home", "me"))).toBe(false);
  });
});

/**
 * The bug class does not stay inside the file routes. The same shape --
 * `startsWith(root + "/")`, `startsWith("/")` as the absolute-path test --
 * decided which project owns a port, which external sessions belong to a repo
 * and which directories the project picker offers. On Windows every one of
 * them answered "outside" for a path that was inside.
 *
 * Unit tests do not run on Windows in CI, so behaviour alone cannot measure
 * this here: what CAN be measured on any platform is that these decisions go
 * through the shared predicates instead of being rebuilt by hand. The list is
 * explicit on purpose: it is the set of modules that decide containment on a
 * FILESYSTEM path, not every file that happens to hold a slash.
 */
describe("no module rebuilds path containment by hand", () => {
  const MODULES = [
    "lib/port-project-owner.ts",
    "lib/external-claude-sessions.ts",
    "services/external-sessions.ts",
    "services/project-path-resolver.ts",
  ];
  // `x + "/"` glued onto a root, and `startsWith("/")` used as "is absolute".
  const HAND_BUILT = /startsWith\((?:`|")\//;
  const GLUED_ROOT = /\+\s*"\/"\)/;

  for (const relative of MODULES) {
    it(`${relative} uses isInsideDir / isAbsolute`, () => {
      const source = readFileSync(join(import.meta.dir, "..", relative), "utf8");
      const offenders = source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
        .filter((line) => HAND_BUILT.test(line) || GLUED_ROOT.test(line));
      expect(offenders).toEqual([]);
    });
  }
});
