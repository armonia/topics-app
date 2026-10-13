/**
 * THE PRODUCTION SERVER RUNS THE BUN OF .bun-version, NOT THE MAC'S GLOBAL ONE.
 *
 * CI, the release and the tests run the version pinned in `.bun-version`;
 * until 2026-10-08 the Mac serving production ran whatever `bun` was first on
 * PATH (1.3.8), and two defects of the cloud quality pass lived in that gap.
 * The global `bun` belongs to every other project on the machine, so the fix
 * is a binary of Topics' own under `~/.topics/bun/<version>/`.
 *
 * `pinned-bun.sh` and `install-bun.sh` run here for real, from a copy, against
 * a fake HOME and a fake release served over file://. `start-prod.sh` does
 * not: it takes a lock and starts watchers (see `start-prod-env-reload.test.ts`),
 * so for it the proof is on the shape, as for the configuration reload.
 * @covers BOOT-BUN-01
 */
import { describe, it, expect, afterAll } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const VERSION = "9.9.9";
const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** A checkout with the script and `.bun-version`, a HOME, and a global `bun` on PATH. */
function sandbox(script: string) {
  const root = mkdtempSync(join(tmpdir(), "pinned-bun-"));
  scratch.push(root);
  mkdirSync(join(root, "repo", "scripts"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "scripts", script), join(root, "repo", "scripts", script));
  writeFileSync(join(root, "repo", ".bun-version"), `${VERSION}\n`);
  const home = join(root, "home");
  mkdirSync(home);
  const globalBin = join(root, "global-bin");
  fakeBun(join(globalBin, "bun"), "1.0.0");
  return { root, home, globalBin, script: join(root, "repo", "scripts", script) };
}

function fakeBun(path: string, version: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
  chmodSync(path, 0o755);
}

function run(cmd: string[], env: Record<string, string>) {
  const r = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
}

const pathWith = (dir: string) => `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`;

describe("pinned-bun.sh", () => {
  it("is executable: start-prod.sh runs it directly", () => {
    expect(statSync(join(REPO_ROOT, "scripts", "pinned-bun.sh")).mode & 0o111).not.toBe(0);
  });

  it("prints the pinned binary when that version is installed", () => {
    const s = sandbox("pinned-bun.sh");
    const pinned = join(s.home, ".topics", "bun", VERSION, "bun");
    fakeBun(pinned, VERSION);
    const r = run([s.script], { HOME: s.home, PATH: pathWith(s.globalBin) });
    expect(r.code).toBe(0);
    expect(r.out).toBe(pinned);
  });

  it("without it prints the global bun, and the log names the command that installs it", () => {
    const s = sandbox("pinned-bun.sh");
    const r = run([s.script], { HOME: s.home, PATH: pathWith(s.globalBin) });
    expect(r.code).toBe(0);
    expect(r.out).toBe(join(s.globalBin, "bun"));
    expect(r.err).toContain(`Bun ${VERSION} is not installed`);
    expect(r.err).toContain("scripts/install-bun.sh");
  });
});

describe("install-bun.sh", () => {
  const asset = `bun-${process.platform}-${process.arch === "arm64" ? "aarch64" : "x64"}`;

  /** A release laid out like GitHub's: `<asset>.zip` holding `<asset>/bun`, next to its SHASUMS256.txt. */
  function release(root: string, sumOf: (realSum: string) => string): string {
    const dir = join(root, "releases", `bun-v${VERSION}`);
    const build = join(root, "build");
    fakeBun(join(build, asset, "bun"), VERSION);
    mkdirSync(dir, { recursive: true });
    const z = Bun.spawnSync(["zip", "-qr", join(dir, `${asset}.zip`), asset], { cwd: build });
    expect(z.exitCode).toBe(0);
    const real = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, `${asset}.zip`))).digest("hex");
    writeFileSync(join(dir, "SHASUMS256.txt"), `${sumOf(real)}  ${asset}.zip\n`);
    return join(root, "releases");
  }

  it("installs a release whose archive matches SHASUMS256.txt, where pinned-bun.sh looks", () => {
    const s = sandbox("install-bun.sh");
    const releases = release(s.root, (real) => real);
    const r = run([s.script], { HOME: s.home, PATH: pathWith(s.globalBin), TOPICS_BUN_RELEASES: `file://${releases}` });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const installed = join(s.home, ".topics", "bun", VERSION, "bun");
    expect(run([installed, "--version"], {}).out).toBe(VERSION);
  });

  it("refuses an archive that does not match, and installs nothing", () => {
    const s = sandbox("install-bun.sh");
    const releases = release(s.root, (real) => real.replace(/^./, (c) => (c === "0" ? "1" : "0")));
    const r = run([s.script], { HOME: s.home, PATH: pathWith(s.globalBin), TOPICS_BUN_RELEASES: `file://${releases}` });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("does not match SHASUMS256.txt");
    expect(existsSync(join(s.home, ".topics", "bun", VERSION))).toBe(false);
  });
});

describe("start-prod.sh", () => {
  const SCRIPT = readFileSync(join(REPO_ROOT, "scripts", "start-prod.sh"), "utf8").split("\n");
  const lineOf = (needle: string, from = 0): number => {
    const i = SCRIPT.findIndex((l, n) => n >= from && l.includes(needle));
    if (i < 0) throw new Error(`line not found in start-prod.sh: ${needle}`);
    return i;
  };

  it("asks for the Bun at every server launch, after the configuration file and before the spawn", () => {
    const loop = lineOf('while [ "$SHUTTING_DOWN" != 1 ]');
    const sourced = lineOf('source "$HOME/.topics-server-env"', loop);
    const asked = lineOf('BUN="$(pinned_bun)"', sourced);
    const spawn = lineOf('"$BUN" run "$APP_DIR/server.ts"', loop);
    expect(asked).toBeLessThan(spawn);
  });

  it("asks pinned-bun.sh, not the PATH, from the top", () => {
    const fn = lineOf("pinned_bun() {");
    expect(SCRIPT[fn]).toContain('"$APP_DIR/scripts/pinned-bun.sh"');
    expect(lineOf('BUN="$(pinned_bun)"')).toBeGreaterThan(fn);
    expect(SCRIPT.some((l) => /^BUN="\$\(command -v bun/.test(l))).toBe(false);
  });
});
