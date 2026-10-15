import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { gitRelativeDate } from "./git-relative-date";

/** @covers D3D-01 */
test("relative author dates match Git around unit boundaries and the future", () => {
  const root = mkdtempSync(join(tmpdir(), "git-relative-date-"));
  const authorTime = 946684800;
  try {
    mkdirSync(root, { recursive: true });
    const run = (args: string[], env: Record<string, string | undefined> = gitEnv()) => {
      const result = Bun.spawnSync(["git", "-C", root, ...args], { env });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    run(["init", "-q"]);
    run(["config", "user.name", "Date Fixture"]);
    run(["config", "user.email", "date@example.invalid"]);
    writeFileSync(join(root, "file.txt"), "fixed commit\n");
    run(["add", "file.txt"]);
    run(["commit", "-qm", "fixed date"], {
      ...gitEnv(),
      GIT_AUTHOR_DATE: `@${authorTime} +0000`,
      GIT_COMMITTER_DATE: `@${authorTime} +0000`,
    });

    const offsets = [
      -90, -1, 0, 1, 89, 90, 89 * 60 - 1, 89 * 60, 90 * 60 - 1, 90 * 60,
      35 * 3600 - 1, 35 * 3600, 36 * 3600 - 1, 36 * 3600,
      13 * 86400 - 1, 13 * 86400, 14 * 86400 - 1, 14 * 86400,
      69 * 86400 - 1, 69 * 86400, 70 * 86400 - 1, 70 * 86400,
      364 * 86400 - 1, 364 * 86400, 365 * 86400 - 1, 365 * 86400,
      4 * 365 * 86400 + 334 * 86400 - 1, 4 * 365 * 86400 + 334 * 86400,
      4 * 365 * 86400 + 334 * 86400 + 1, 5 * 365 * 86400 - 1, 5 * 365 * 86400,
    ];
    for (const offset of offsets) {
      const now = authorTime + offset;
      const expected = run(["log", "-1", "--format=%ar"], {
        ...gitEnv(),
        GIT_TEST_DATE_NOW: String(now),
      });
      expect(gitRelativeDate(authorTime, now), `offset ${offset}s`).toBe(expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
