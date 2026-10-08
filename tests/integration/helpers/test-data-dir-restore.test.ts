/**
 * `DATA_DIR` set by `setupTestDataDir` does not outlive the file that set it.
 *
 * THE DEFECT IT PINS (measured on 08/10/2026). `cleanupTestDataDir` closed the
 * database and removed the folder but left `process.env.DATA_DIR` pointing at
 * it. `server/db.ts` resolves the data folder as `DATA_DIR || <root>/data`, so
 * every later file of the same `bun test` process that opened "its own"
 * database with `initDatabase(ownTmpRoot)` landed in that one leftover folder.
 * `server/attention/system-notices.test.ts` then read the `topic:front` row
 * `born-seen.test.ts` had written there: red in 10 runs out of 10 after
 * `server/browser-state-store.test.ts`, green alone, and red in the bars of
 * five tracks.
 *
 * WHY CHILD PROCESSES. The leak crosses a file boundary, which a test cannot
 * watch from inside its own run (see `test-tmp-dir-cleanup.test.ts`). The
 * fixtures are numbered because bun runs the files of a run in path order.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, testTmpDir } from "./index";

const HELPER_MODULE = path.join(PROJECT_ROOT, "tests/integration/helpers/index.ts");
const DATA_DIR_MODULE = path.join(PROJECT_ROOT, "server/lib/data-dir.ts");

const PRELUDE = `
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, setupTestDataDir, testTmpDir } from ${JSON.stringify(HELPER_MODULE)};
import { resolveDataDir } from ${JSON.stringify(DATA_DIR_MODULE)};
`;

/** A later file that opens its own database: it must get its own folder. */
const NEXT_FILE = `
const OWN = testTmpDir("data-dir-restore-next");
test("finds no DATA_DIR, so its database goes in its own root", () => {
  expect(process.env.DATA_DIR).toBeUndefined();
  expect(resolveDataDir(OWN)).toBe(join(OWN, "data"));
});
`;

/** Runs the fixture files, in the order of their names, in ONE child `bun test` with no DATA_DIR. */
function runFixtures(files: Record<string, string>): { code: number; output: string } {
  const scratch = testTmpDir("data-dir-restore-fixtures");
  const paths = Object.entries(files).map(([name, body]) => {
    const file = path.join(scratch, name);
    writeFileSync(file, PRELUDE + body);
    return file;
  });
  // The child starts from a clean world: a DATA_DIR this process inherited
  // from an earlier file must not decide the verdict.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.DATA_DIR;
  const child = Bun.spawnSync(["bun", "test", ...paths], { cwd: PROJECT_ROOT, env, stdout: "pipe", stderr: "pipe" });
  const output = (new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr)).slice(-4000);
  return { code: child.exitCode ?? -1, output };
}

describe("setupTestDataDir and cleanupTestDataDir", () => {
  test("the cleanup puts DATA_DIR back, so the next file opens its own database", () => {
    const run = runFixtures({
      "1-sets-and-cleans.test.ts": `
        const ROOT = testTmpDir("data-dir-restore-first");
        beforeAll(() => setupTestDataDir(join(ROOT, "data")));
        afterAll(() => cleanupTestDataDir(ROOT));
        test("works in its data folder", () => expect(process.env.DATA_DIR).toBe(join(ROOT, "data")));
      `,
      "2-next.test.ts": NEXT_FILE,
    });
    expect(run.code, run.output).toBe(0);
  }, 60_000);

  test("a cleanup after a file that never cleaned up puts back what was there before both", () => {
    const run = runFixtures({
      "1-never-cleans.test.ts": `
        const ROOT = testTmpDir("data-dir-restore-leaky");
        beforeAll(() => setupTestDataDir(join(ROOT, "data")));
        test("works in its data folder", () => expect(process.env.DATA_DIR).toBe(join(ROOT, "data")));
      `,
      "2-sets-and-cleans.test.ts": `
        const ROOT = testTmpDir("data-dir-restore-second");
        beforeAll(() => setupTestDataDir(join(ROOT, "data")));
        afterAll(() => cleanupTestDataDir(ROOT));
        test("works in its data folder", () => expect(process.env.DATA_DIR).toBe(join(ROOT, "data")));
      `,
      "3-next.test.ts": NEXT_FILE,
    });
    expect(run.code, run.output).toBe(0);
  }, 60_000);
});

/**
 * The files that call `setupTestDataDir` and never `cleanupTestDataDir`
 * (08/10/2026). Each one leaves DATA_DIR set for the files after it, until a
 * later file's cleanup puts it back. A new file joins this shape only by
 * forgetting the cleanup, and that is how `browser-state-store.test.ts` would
 * come back: the list may shrink, never grow. Some restore DATA_DIR by hand;
 * pairing them with the cleanup is the way off the list.
 */
const KNOWN_WITHOUT_CLEANUP = [
  "server/routes/processes.session-run.test.ts",
  "server/routes/processes.shell-file.test.ts",
  "server/routes/processes.shell.test.ts",
  "tests/integration/ask-user-poll-loop.test.ts",
  "tests/integration/catchup-payload-weight.test.ts",
  "tests/integration/chat-dead-child-route.test.ts",
  "tests/integration/chat-failed-turn-flush.test.ts",
  "tests/integration/chat-finalized-turn-late-events.test.ts",
  "tests/integration/chat-sse-fallback-own-row.test.ts",
  "tests/integration/chat-stream-abort.test.ts",
  "tests/integration/chat-tool-response-live-turn.test.ts",
  "tests/integration/chat-watchdog-finalize.test.ts",
  "tests/integration/chat-woken-turn.test.ts",
  "tests/integration/command-service.test.ts",
  "tests/integration/compact-post-tokens.test.ts",
  "tests/integration/empty-turn-discard.test.ts",
  "tests/integration/goal-check-in-tick-lock.test.ts",
  "tests/integration/goal-continuation.test.ts",
  "tests/integration/helpers/test-tmp-dir-cleanup.test.ts",
  "tests/integration/history-before-cursor.test.ts",
  "tests/integration/history-body-reads.test.ts",
  "tests/integration/history-decode-cost.test.ts",
  "tests/integration/history-limit-cost.test.ts",
  "tests/integration/history-page-bytes.test.ts",
  "tests/integration/history-payload-weight.test.ts",
  "tests/integration/history-prompt-number.test.ts",
  "tests/integration/initial-message.test.ts",
  "tests/integration/live-phase-gate.test.ts",
  "tests/integration/machine-stop-parity.test.ts",
  "tests/integration/machine-stop-real-provider.integration.test.ts",
  "tests/integration/machine-stop-reboot.test.ts",
  "tests/integration/machines.test.ts",
  "tests/integration/master-sessions.test.ts",
  "tests/integration/message-author-roundtrip.test.ts",
  "tests/integration/message-blob-codec.test.ts",
  "tests/integration/message-blocks-compressed-on-write.test.ts",
  "tests/integration/message-branch-ops.test.ts",
  "tests/integration/message-write-lean.test.ts",
  "tests/integration/migration-071-empty-turns.test.ts",
  "tests/integration/migration-20260813135636-disjoint-cache.test.ts",
  "tests/integration/migration-20260904190854-dispatched-envelopes.test.ts",
  "tests/integration/migration-20260923230000-old-goal-nudges.test.ts",
  "tests/integration/native-shutdown-notice.test.ts",
  "tests/integration/plan-approval-holds-queue.test.ts",
  "tests/integration/process-run-command.test.ts",
  "tests/integration/process-stdout-file.test.ts",
  "tests/integration/project-broadcast-visibility.test.ts",
  "tests/integration/reattach-final-reply.integration.test.ts",
  "tests/integration/relocate-pane.test.ts",
  "tests/integration/search-messages.test.ts",
  "tests/integration/shutdown-wiring.test.ts",
  "tests/integration/task-tab-durability.test.ts",
  "tests/integration/task-tab-teardown.test.ts",
  "tests/integration/terminal-claude-hooks-settings.test.ts",
  "tests/integration/terminal-input-dropped.test.ts",
  "tests/integration/terminal-revive-race.test.ts",
  "tests/integration/terminal-roster-boot-bridge-late.test.ts",
  "tests/integration/terminal-roster-reconciled-header.test.ts",
  "tests/integration/terminal-roster-warming-503.test.ts",
  "tests/integration/terminal-sessions-write-failure.test.ts",
  "tests/integration/thread-load-lean.test.ts",
  "tests/integration/turn-end-topic-write.test.ts",
  "tests/integration/turn-stop-said-with-close.test.ts",
];

/** The test sources that mention `setupTestDataDir(` and never `cleanupTestDataDir(`, sorted. */
function filesWithoutCleanup(): string[] {
  const out: string[] = [];
  for (const root of ["client/src", "server", "shared", "relay", "tests", "scripts", "cli"]) {
    for (const rel of new Bun.Glob(`${root}/**/*.{ts,tsx}`).scanSync({ cwd: PROJECT_ROOT, onlyFiles: true })) {
      if (rel.includes("node_modules") || rel === "tests/integration/helpers/index.ts") continue;
      if (rel === "tests/integration/helpers/test-data-dir-restore.test.ts") continue;
      const src = readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
      if (src.includes("setupTestDataDir(") && !src.includes("cleanupTestDataDir(")) out.push(rel);
    }
  }
  return out.sort();
}

describe("the files that set DATA_DIR and never put it back", () => {
  test("no new file joins them", () => {
    const fresh = filesWithoutCleanup().filter((f) => !KNOWN_WITHOUT_CLEANUP.includes(f));
    expect(fresh, "call cleanupTestDataDir(ROOT) from afterAll in these files").toEqual([]);
  });

  test("a file that now cleans up leaves the list", () => {
    const current = new Set(filesWithoutCleanup());
    const fixed = KNOWN_WITHOUT_CLEANUP.filter((f) => !current.has(f));
    expect(fixed, "remove these from KNOWN_WITHOUT_CLEANUP").toEqual([]);
  });
});

