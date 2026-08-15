/**
 * relay/ is DEPLOYED code. This test is the proof that the gates can see it.
 *
 * WHAT WENT WRONG. `relay/wrangler.jsonc` ships `src/worker.ts` to Cloudflare,
 * and until 2026-08-15 the folder — 1,768 lines of Worker source (four files
 * under `src/` plus `workers-runtime.d.ts`) and 2,476 lines of tests — sat
 * outside the gates. Measured, not remembered, with
 * `tsc -p <config> --listFiles | grep relay`:
 *
 *   tsconfig.server.json -> 0 relay files
 *   tsconfig.e2e.json    -> 1: relay/src/ponte.ts
 *
 * So "zero files under relay/ in any program" was wrong, and wrong about the
 * biggest file: `ponte.ts` (821 lines) was already pulled into the e2e program
 * by `tests/e2e/helpers/relay-e2e.ts:34` and `tests/e2e/relay-reachability.spec.ts:8`.
 * It was checked there under `strict: false`, not under the Worker's own
 * `strict: true`, and the other nine files were in no program at all. eslint
 * only ever ran from `client/`, and knip's project globs stopped at
 * server/shared/cli/scripts. A type error, a dead export or a lint error there
 * reached production and nothing went red. The suite ran the relay tests, which
 * is why this looked covered: `test:unit` lists `./relay`, and a green test
 * says nothing about the three gates that were not looking.
 *
 * WHY A TEST AND NOT JUST THE CONFIG. Wiring is the kind of thing that gets
 * dropped in a merge and leaves no symptom. Each assertion below fails on the
 * pre-fix tree, and each one keeps failing if the wiring is unpicked later.
 *
 * WHY IT SPAWNS tsc AND eslint. The first version of this file asserted that
 * `relay/tsconfig.json` had an `include` glob and that `package.json` held the
 * eslint command as a substring. Both are green over a program that resolves to
 * nothing: an `include` that matches no file, or a script whose eslint config
 * ignores the folder, is exactly the state this file exists to detect. So the
 * two gates are RUN and their reported file lists are compared against the
 * files on disk. It costs about 3 s.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  readKnipWorkspaces,
  stripJsonComments,
} from "../scripts/check-deadcode-blindspots";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const readJsonc = <T>(rel: string): T =>
  JSON.parse(stripJsonComments(read(rel))) as T;

/** Every TypeScript file under relay/, repo-relative, `.d.ts` included: an
 *  ambient declaration outside the program is a silent hole too. */
function relayTsFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts")) out.push(relative(ROOT, full));
    }
  };
  walk(join(ROOT, "relay"));
  return out;
}

const RELAY_TS = relayTsFiles();
const SCRIPTS = (
  JSON.parse(read("package.json")) as { scripts: Record<string, string> }
).scripts;

/**
 * The tsc the repo pins. `typecheck:relay` uses this exact binary and not
 * `bunx tsc`, because a fetched newer major would change what the gate means.
 */
const TSC = join(ROOT, "client", "node_modules", ".bin", "tsc");
const ESLINT = join(ROOT, "client", "node_modules", ".bin", "eslint");

async function capture(cmd: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

/** Repo-relative relay files that `tsc -p <config>` reports in its program. */
async function tscListFiles(config: string): Promise<string[]> {
  const { code, out } = await capture([TSC, "-p", config, "--listFiles", "--noEmit"]);
  // A non-zero exit here is a type error, not a missing program: the file list
  // is still printed, and swallowing it would turn a broken build into "the
  // gate does not see relay", which is a different and much worse diagnosis.
  expect(out.length, `tsc printed nothing for ${config} (exit ${code})`).toBeGreaterThan(0);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(ROOT))
    .map((l) => relative(ROOT, l))
    .filter((f) => f.startsWith(`relay${sep}`));
}

const measuredProgramFiles = (): Promise<string[]> => tscListFiles(join("relay", "tsconfig.json"));

/** Repo-relative relay files eslint reports having linted. */
async function measuredLintedFiles(): Promise<string[]> {
  const { code, out } = await capture([
    ESLINT,
    "--config",
    join("client", "eslint.config.js"),
    "--format",
    "json",
    "relay",
  ]);
  // 0 = clean, 1 = lint errors. Anything else is eslint failing to run, and a
  // crash must not read as "relay is covered" or as "relay is uncovered".
  expect([0, 1], `eslint exited ${code}:\n${out.slice(0, 2000)}`).toContain(code);
  const start = out.indexOf("[");
  expect(start, `eslint printed no JSON report:\n${out.slice(0, 2000)}`).toBeGreaterThan(-1);
  const report = JSON.parse(out.slice(start)) as { filePath: string }[];
  return report
    .map((r) => relative(ROOT, r.filePath))
    .filter((f) => f.startsWith(`relay${sep}`));
}

describe("relay/ is inside the gates", () => {
  it("has files to protect at all", () => {
    // A guard that measures an empty set is the failure mode this whole file
    // exists to catch, so it is checked before anything is asserted about it.
    expect(RELAY_TS.length).toBeGreaterThan(5);
  });

  it("knip's project globs cover every relay source file", () => {
    const root = readKnipWorkspaces(read("knip.jsonc")).find((w) => w.dir === "");
    expect(root).toBeDefined();
    const uncovered = RELAY_TS.filter(
      (f) => !root!.project.some((p) => new Bun.Glob(p).match(f)),
    );
    expect(uncovered).toEqual([]);
  });

  it("knip is told about the Worker entry wrangler actually deploys", () => {
    // Read the entry from wrangler.jsonc rather than hard-coding it: renaming
    // the Worker must move the knip entry with it, not quietly orphan the file.
    const main = readJsonc<{ main: string }>("relay/wrangler.jsonc").main;
    const root = readKnipWorkspaces(read("knip.jsonc")).find((w) => w.dir === "");
    expect(root!.entry).toContain(join("relay", main));
  });

  it("typecheck runs the relay program", () => {
    expect(SCRIPTS.typecheck).toContain("typecheck:relay");
    expect(SCRIPTS["typecheck:relay"]).toContain("relay/tsconfig.json");
  });

  it("tsc actually compiles every relay file, measured from its own file list", async () => {
    // `--listFiles` is the program tsc built, not the globs someone wrote. An
    // `include` that matches nothing passes a glob check and fails this one.
    const listed = await measuredProgramFiles();
    expect(listed.length, "tsc reported no relay file: the program is empty").toBeGreaterThan(5);
    expect(RELAY_TS.filter((f) => !listed.includes(f)), "relay files outside the tsc program").toEqual([]);
  }, 60_000);

  it("relay stays OUT of the server program, measured the same way", async () => {
    // `workers-runtime.d.ts` declares `WebSocketPair` and friends as ambient
    // globals. Folding relay into tsconfig.server.json would hand those names
    // to every server file, where they do not exist at runtime — which is the
    // whole reason relay got a program of its own instead of an `include` line.
    const include = readJsonc<{ include: string[] }>("tsconfig.server.json").include;
    expect(include.filter((p) => p.startsWith("relay"))).toEqual([]);
    expect(await tscListFiles("tsconfig.server.json")).toEqual([]);
  }, 60_000);

  it("eslint actually lints every relay file, measured from its own report", async () => {
    // Same trap on the other gate: `SCRIPTS.lint` used to be checked as a
    // substring, which stays green if the config's `ignores` swallow relay/ or
    // if the flat config resolves no rules for these files. Ask eslint what it
    // linted instead.
    const linted = await measuredLintedFiles();
    expect(linted.length, "eslint reported no relay file: the folder is being ignored").toBeGreaterThan(5);
    expect(RELAY_TS.filter((f) => !linted.includes(f)), "relay files eslint never opened").toEqual([]);
  }, 120_000);

  it("the lint script the gates run is the one that was measured", () => {
    // The measurement above runs eslint directly. This is what ties it to the
    // command a human or CI types: if `lint` stops covering relay, the measured
    // green upstairs would be describing a gate nobody invokes.
    expect(SCRIPTS.lint).toContain("eslint --config client/eslint.config.js relay");
    expect(SCRIPTS["lint:relay"]).toContain("eslint --config client/eslint.config.js relay");
  });
});

/**
 * The Worker and its tests share ONE tsc program, so the tests can keep using
 * `bun:test` while `src/` gets typechecked. The price is that `types: ["bun"]`
 * is in scope for `src/` too: `Bun.file(…)` in the Worker would compile and
 * then throw on workerd, where no such global exists. This is the guard that
 * makes that price payable.
 */
const REACHES_FOR_BUN = /\bBun\.|(?:from|import)\s*\(?\s*["']bun(?::|["'])/;

describe("the Worker never reaches for a Bun global", () => {
  it("detects the shape it is looking for", () => {
    // Without this the suite could stay green because the regex stopped
    // matching anything, not because the sources stayed clean.
    expect(REACHES_FOR_BUN.test('const f = Bun.file("x")')).toBe(true);
    expect(REACHES_FOR_BUN.test('import { test } from "bun:test"')).toBe(true);
    expect(REACHES_FOR_BUN.test('const b = new WebSocketPair()')).toBe(false);
  });

  it("finds none of it under relay/src", () => {
    const offenders = RELAY_TS.filter(
      (f) => f.startsWith(join("relay", "src")) && REACHES_FOR_BUN.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });
});
