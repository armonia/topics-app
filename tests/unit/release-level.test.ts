/**
 * WHICH NUMBER THE NEXT RELEASE RAISES.
 *
 * Until 2026-10-16 the auto-bump only knew the patch: 517 of them since 2.2.0,
 * and a release that changed what people see read the same as a one-line fix.
 * Now a commit asks for more with a trailer (`Release: minor`, `Release:
 * major`), and a batch takes the highest level among the commits since the
 * last version commit.
 *
 * The range is the dangerous part: a trailer counted from before the last
 * release would raise every release after it, forever. So it is tested on a
 * real repository, not on a list of strings.
 *
 * @covers RELEASE-07
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { decideLevel, levelOf, messagesSinceLastRelease } from "../../scripts/release-level";
import { gitEnv } from "../setup/bun-test-preload";

const ROOT = resolve(import.meta.dir, "../..");

describe("levelOf: what one commit asks for", () => {
  it("no trailer is a patch", () => {
    expect(levelOf("Fix the tab title\n\nA longer body.")).toBe("patch");
  });

  it("a trailer on its own line asks for its level", () => {
    expect(levelOf("New panel\n\nBody.\n\nRelease: minor")).toBe("minor");
    expect(levelOf("Drop macOS 12\n\nRelease: major\n")).toBe("major");
  });

  it("the same words inside a sentence are not a trailer", () => {
    expect(levelOf("Explain how Release: minor works in CONTRIBUTING")).toBe("patch");
  });

  it("case does not matter, the line does", () => {
    expect(levelOf("x\n\nrelease: Minor")).toBe("minor");
  });

  it("an unknown value asks for nothing", () => {
    expect(levelOf("x\n\nRelease: huge")).toBe("patch");
  });
});

describe("decideLevel: a batch takes the highest level", () => {
  it("fixes only: patch", () => {
    expect(decideLevel(["a", "b"])).toBe("patch");
  });

  it("a minor among fixes: minor", () => {
    expect(decideLevel(["a", "b\n\nRelease: minor", "c"])).toBe("minor");
  });

  it("a major wins over a minor", () => {
    expect(decideLevel(["a\n\nRelease: minor", "b\n\nRelease: major"])).toBe("major");
  });

  it("an empty batch is a patch", () => {
    expect(decideLevel([])).toBe("patch");
  });
});

describe("messagesSinceLastRelease: only what the last release did not ship", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  function repo(messages: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "release-level-"));
    dirs.push(dir);
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { env: gitEnv(), cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    git("init", "-q");
    for (const m of messages) git("commit", "-q", "--allow-empty", "-m", m);
    return dir;
  }

  it("a trailer from before the last version commit does not count again", () => {
    const dir = repo([
      "Old feature\n\nRelease: major",
      "chore(release): bump v2.2.517",
      "Fix a thing",
      "New panel\n\nRelease: minor",
    ]);
    const messages = messagesSinceLastRelease(dir);
    expect(messages).toHaveLength(2);
    expect(decideLevel(messages)).toBe("minor");
  });

  it("right after a release there is nothing to raise but the patch", () => {
    const dir = repo(["Old feature\n\nRelease: minor", "chore(release): bump v2.3.0"]);
    expect(messagesSinceLastRelease(dir)).toEqual([]);
    expect(decideLevel(messagesSinceLastRelease(dir))).toBe("patch");
  });

  it("a subject that only mentions the release prefix is not a version commit", () => {
    const dir = repo([
      "chore(release): bump v2.2.1",
      "New panel\n\nRelease: minor",
      "Document chore(release): bump vX in CONTRIBUTING",
    ]);
    expect(decideLevel(messagesSinceLastRelease(dir))).toBe("minor");
  });
});

describe("the workflows use it", () => {
  const AUTO = readFileSync(resolve(ROOT, ".github/workflows/auto-bump.yml"), "utf8");
  const SMOKE = readFileSync(resolve(ROOT, ".github/workflows/install-smoke.yml"), "utf8");

  it("the bump step asks release-level.ts and passes its answer to bump-version.sh", () => {
    expect(AUTO).toContain('LEVEL="$(bun run scripts/release-level.ts)"');
    expect(AUTO).toContain('bash scripts/bump-version.sh "$LEVEL"');
    expect(AUTO).not.toContain("bump-version.sh patch");
  });

  it("install-smoke still listens to the auto-bump by its current name", () => {
    // `workflow_run` matches workflows by NAME: rename one side only and the
    // smoke test after every release stops starting, without a single red run.
    const name = AUTO.match(/^name:\s*(.+)$/m)?.[1].trim();
    expect(name).toBeTruthy();
    expect(SMOKE).toContain(`workflows: [${name}]`);
  });
});
