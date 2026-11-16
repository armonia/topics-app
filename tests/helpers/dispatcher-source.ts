/**
 * The text of the whole task dispatcher, for the tests that read it as source.
 *
 * `task-dispatcher.ts` used to hold everything. It is now the composition root
 * plus sibling modules (`task-dispatcher-core.ts`, `-admission`, `-kickoff`...).
 * A test that asks "does the dispatcher still say X?" is asking about the
 * dispatcher as a whole, so it reads every part joined: `task-dispatcher.ts`
 * first, then the `task-dispatcher-*.ts` modules in alphabetical order. Test
 * files and test-only support modules are left out.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const SERVICES = "server/services";

/** Repo-relative paths of every production file of the dispatcher, entry first. */
export function dispatcherSourceFiles(): string[] {
  const parts = readdirSync(join(ROOT, SERVICES))
    .filter((f) => /^task-dispatcher-.+\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !/-test-support\.ts$/.test(f))
    .sort();
  return [`${SERVICES}/task-dispatcher.ts`, ...parts.map((f) => `${SERVICES}/${f}`)];
}

/** The dispatcher's code, every file joined (entry first, then alphabetical). */
export function readDispatcherSource(): string {
  return dispatcherSourceFiles().map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
}
