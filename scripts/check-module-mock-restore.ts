/**
 * A MODULE MOCK THAT IS NEVER TAKEN BACK IS HANDED TO EVERY FILE AFTER IT.
 *
 * `bun test` runs all the files of one round in ONE process, and `mock.module`
 * replaces a module in the registry for that whole process. A file that swaps a
 * module and leaves it swapped is not making a mess of its own house: every
 * later file in the shard imports the fake.
 *
 * WHAT IT COST, on 2026-09-12. `browserClaimHeartbeat.test.ts` replaced
 * `./shell/tauri` and signed off with `afterAll(() => mock.restore())`. That
 * call takes back SPIES, not a `mock.module` - a difference the file's own
 * comment did not know about. The next file was still handed the fake
 * `tauriInvoke`, so a call that had to be REJECTED came back resolved, and the
 * red pointed at the code under test instead of at the file that had left the
 * mock behind. Three CI rounds went into looking in the wrong place.
 *
 * The worst outcome is not that red. It is the file after a leak that stays
 * GREEN FOR THE WRONG REASON, believing it is talking to the real module. And
 * since the victim is whoever the shard happens to schedule next, it behaves
 * like a ghost: green here, red there.
 *
 * WHAT THIS GATE ASKS, and it is the smallest thing that works: every module
 * specifier a file hands to `mock.module` must ALSO appear in a call that gives
 * it back whole - `mock.module('./x', () => realX)`, a factory whose body is a
 * plain identifier holding the real module captured before the swap. That is
 * the shape `updater.tauri.test.ts` already used and the one four files were
 * fixed into.
 *
 * WHAT IT DOES NOT ASK. It does not check WHERE the restore runs: a restore in
 * `afterAll` and one at the end of a `describe` are both fine, and deciding
 * that statically would mean reading control flow for no gain. It also cannot
 * tell whether the captured object holds every export - `check:deadcode-blindspots`
 * pushes you to name them one by one, which is where that gets caught.
 *
 * IT IS A RATCHET. Files that already leak are recorded in the baseline with
 * the reason; the gate only fails on a specifier that is NOT in it. The baseline
 * moves down, never up.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const BASELINE = join(ROOT, "scripts", "module-mock-restore-baseline.json");

/** Where test files live. Same roots `test:unit` runs. */
const ROOTS = ["client/src", "server", "shared", "tests", "scripts", "relay", "cli"];

interface BaselineFile {
  readonly $schema?: string;
  readonly files: Record<string, readonly string[]>;
}

/** Comments are not code: a `mock.module(...)` quoted in prose is not a mock. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const CALL = /mock\.module\(\s*(['"])(.+?)\1\s*,\s*\(\)\s*=>\s*([^\n]{0,40})/g;
/** A factory whose body is a bare identifier: `() => realShell)`. */
const GIVES_BACK = /^[A-Za-z_$][\w$]*\s*\)/;

/** Specifiers this file mocks, and the subset it gives back. */
function scan(source: string): { mocked: Set<string>; restored: Set<string> } {
  const mocked = new Set<string>();
  const restored = new Set<string>();
  for (const match of withoutComments(source).matchAll(CALL)) {
    const specifier = match[2]!;
    mocked.add(specifier);
    if (GIVES_BACK.test(match[3]!.trimStart())) restored.add(specifier);
  }
  return { mocked, restored };
}

function baseline(): BaselineFile["files"] {
  if (!existsSync(BASELINE)) return {};
  return (JSON.parse(readFileSync(BASELINE, "utf8")) as BaselineFile).files ?? {};
}

const allowed = baseline();
const offenders: Array<{ file: string; specifiers: string[] }> = [];
const cured: string[] = [];
let seen = 0;

for (const root of ROOTS) {
  const glob = new Glob("**/*.{test,spec}.{ts,tsx}");
  for (const found of glob.scanSync({ cwd: join(ROOT, root), absolute: true })) {
    if (found.includes("node_modules")) continue;
    const source = readFileSync(found, "utf8");
    if (!source.includes("mock.module")) continue;
    seen += 1;
    const file = relative(ROOT, found);
    const { mocked, restored } = scan(source);
    const known = new Set(allowed[file] ?? []);
    const leaking = [...mocked].filter((s) => !restored.has(s));
    const unexpected = leaking.filter((s) => !known.has(s));
    if (unexpected.length > 0) offenders.push({ file, specifiers: unexpected.sort() });
    if (known.size > 0 && leaking.length < known.size) cured.push(file);
  }
}

if (offenders.length > 0) {
  const lines = offenders.map(
    (o) => `  ${o.file}\n${o.specifiers.map((s) => `      ${s}`).join("\n")}`,
  );
  console.error(
    `[check-module-mock-restore] a module is swapped and never given back:\n\n${lines.join("\n")}\n\n` +
      "`mock.module` replaces the module for the WHOLE `bun test` process, so every\n" +
      "file after this one imports the fake. `mock.restore()` does not undo it: it\n" +
      "takes back spies.\n\n" +
      "Capture the real module BEFORE swapping it, naming its exports one by one\n" +
      "(a namespace spread makes the module opaque to `check:deadcode-blindspots`),\n" +
      "and give it back:\n\n" +
      "    const { a, b } = await import('./x');\n" +
      "    const realX = { a, b };\n" +
      "    mock.module('./x', () => ({ ...realX, a: fake }));\n" +
      "    afterAll(() => { mock.module('./x', () => realX); });\n",
  );
  process.exit(1);
}

const debt = Object.values(allowed).reduce((sum, list) => sum + list.length, 0);
console.log(
  `[check-module-mock-restore] OK - ${seen} file(s) use mock.module, ${debt} specifier(s) in the baseline.`,
);
if (cured.length > 0) {
  console.log(
    `[check-module-mock-restore] ${cured.length} file(s) improved - take them out of the baseline:\n` +
      cured.map((f) => `  ${f}`).join("\n"),
  );
}
