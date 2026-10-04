/**
 * THE ONE WRITER, checked with `git grep` (notifications-redesign, task 2.9):
 * only `server/attention/store.ts` writes `subject_attention`, and no file
 * outside `server/attention/` writes history rows of the kinds an epoch
 * writes (`chat-message`, `session`, `chat-error`): a second writer is how the
 * bell and the badges told two stories for months.
 * @covers ATTN-01
 * @covers ATTN-11
 */
import { describe, expect, test } from "bun:test";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const ROOT = join(import.meta.dir, "..", "..");

function trackedLines(pattern: string): string[] {
  const r = Bun.spawnSync(["git", "grep", "--untracked", "-n", "-E", pattern, "--", "server", "server.ts", "shared"], { cwd: ROOT, env: gitEnv() });
  return r.stdout.toString().split("\n").filter(Boolean)
    // Tests read and write the table to set up their cases; migrations create it.
    .filter((l) => !/\.test\.ts:/.test(l) && !l.startsWith("server/db/migrations/"));
}

describe("the attention store is the only writer", () => {
  test("only server/attention/store.ts writes subject_attention", () => {
    const writers = trackedLines("(INSERT|UPDATE|DELETE|REPLACE).*subject_attention|subject_attention.*(SET|VALUES)")
      .map((l) => l.split(":")[0]);
    expect([...new Set(writers)]).toEqual(["server/attention/store.ts"]);
  });

  test("no file outside server/attention/ writes rows of kind chat-message, session or chat-error", () => {
    const writers = trackedLines("kind: *[\"'](chat-message|session|chat-error)[\"']")
      .map((l) => l.split(":")[0])
      .filter((f) => !f.startsWith("server/attention/"));
    // `server/push-triggers.ts` builds the WORDS of the store's announce (it
    // writes nothing): the store hands its record to the registry.
    expect([...new Set(writers)].filter((f) => f !== "server/push-triggers.ts")).toEqual([]);
  });
});
