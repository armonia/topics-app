/**
 * A WORKTREE THAT CANNOT COMPILE THE DESKTOP CRATE.
 *
 * `desktop-tauri/src-tauri/binaries/` is a build artifact, git does not track
 * it, and `git worktree add` only materialises tracked files: every dispatch
 * worktree was born without it, so `cargo check` stopped on
 * «resource path `binaries/topics-server-...` doesn't exist» before compiling a
 * line. Rust work was delivered with no proof of build, and the first place a
 * mistake showed up was Windows CI. Measured 2026-08-28, card 175735ba.
 *
 * The two halves this file nails down, because the second one is the one that
 * gets forgotten:
 *
 *   1. the sidecars arrive, once, without touching the source;
 *   2. the ignore rule matches a SYMLINK and not just a directory - with the
 *      trailing-slash form a provisioned link shows as untracked, and one
 *      `git add -A` commits an absolute home path into a public repo.
 *
 * @covers WORKTREE-13
 */
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  provisionTauriSidecars,
  SIDECAR_DIR_REL,
} from "../../server/services/worktree-sidecars";

const REPO_ROOT = join(import.meta.dir, "../..");
const CRATE_REL = join("desktop-tauri", "src-tauri");
const temps: string[] = [];

function tempTree(withCrate: boolean, withSidecars: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "sidecars-"));
  temps.push(dir);
  if (withCrate) mkdirSync(join(dir, CRATE_REL), { recursive: true });
  if (withSidecars) {
    mkdirSync(join(dir, SIDECAR_DIR_REL), { recursive: true });
    writeFileSync(join(dir, SIDECAR_DIR_REL, "topics-server-test-triple"), "binary");
  }
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("i sidecar arrivano nel worktree", () => {
  it("li porta dal checkout principale, e il contenuto e' quello", async () => {
    const source = tempTree(true, true);
    const worktree = tempTree(true, false);

    const res = await provisionTauriSidecars(source, worktree);

    expect(["cloned", "linked"]).toContain(res.status);
    const landed = join(worktree, SIDECAR_DIR_REL, "topics-server-test-triple");
    expect(existsSync(landed)).toBe(true);
    expect(readFileSync(landed, "utf-8")).toBe("binary");
  });

  it("alla seconda passata non tocca niente", async () => {
    const source = tempTree(true, true);
    const worktree = tempTree(true, false);

    await provisionTauriSidecars(source, worktree);
    writeFileSync(join(worktree, SIDECAR_DIR_REL, "mine"), "local");
    const again = await provisionTauriSidecars(source, worktree);

    expect(again.status).toBe("present");
    expect(existsSync(join(worktree, SIDECAR_DIR_REL, "mine"))).toBe(true);
  });

  it("senza sorgente il worktree nasce lo stesso, e lo dice", async () => {
    const source = tempTree(true, false);
    const worktree = tempTree(true, false);

    const res = await provisionTauriSidecars(source, worktree);

    expect(res.status).toBe("no-source");
    expect(existsSync(join(worktree, SIDECAR_DIR_REL))).toBe(false);
  });

  it("su un ramo senza il crate non inventa la cartella", async () => {
    const source = tempTree(true, true);
    const worktree = tempTree(false, false);

    const res = await provisionTauriSidecars(source, worktree);

    expect(res.status).toBe("no-crate");
    expect(existsSync(join(worktree, "desktop-tauri"))).toBe(false);
  });
});

describe("la meta' che si dimentica: l'ignore copre anche un link", () => {
  const ignoreFile = join(REPO_ROOT, CRATE_REL, ".gitignore");

  it("la riga di `binaries` non ha la barra finale", () => {
    const lines = readFileSync(ignoreFile, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    // `/binaries/` matches a DIRECTORY only: a symlink of the same name slips
    // through and `git status` shows it as `??`.
    expect(lines).toContain("/binaries");
    expect(lines).not.toContain("/binaries/");
  });
});
