import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { branchStatusFromRepo, filterUniqueSourceFiles } from "./branch-status";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(r.stdout).trim();
}

describe("filterUniqueSourceFiles", () => {
  test("drops lockfiles, package.json, version manifests and build output", () => {
    expect(
      filterUniqueSourceFiles([
        "client/src/App.tsx",
        "bun.lock",
        "client/bun.lock",
        "package.json",
        "desktop-tauri/src-tauri/tauri.conf.json",
        "public/index-abc.js",
        "dist/x.js",
        "Cargo.toml",
        "server/foo.ts",
        "   ",
      ]),
    ).toEqual(["client/src/App.tsx", "server/foo.ts"]);
  });
});

describe("branchStatusFromRepo", () => {
  let repo: string;

  // Timeout esplicito: questo hook fa una ventina di `git` SINCRONI per montare
  // il repo di prova, e i 5s di default di bun li copre solo a macchina scarica.
  // Quando la suite gira insieme a un build o a un E2E, ogni spawn scivola a
  // qualche centinaio di ms e l'hook sfora — un rosso che non dice niente sul
  // codice sotto test. Il vero limite di questo test è la durata degli spawn,
  // non la logica, quindi il tetto sta largo.
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "bstat-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");

    // main advances: adds shared.txt=hello and sets ev.txt=NEW
    writeFileSync(join(repo, "shared.txt"), "hello\n");
    writeFileSync(join(repo, "ev.txt"), "NEW\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "main advance");

    // squash-landed: from base, add shared.txt=hello (identical content, own commit)
    git(repo, "checkout", "-q", "-b", "squash", base);
    writeFileSync(join(repo, "shared.txt"), "hello\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "add shared");

    // superseded: from base, ev.txt=OLD while main has NEW
    git(repo, "checkout", "-q", "-b", "superseded", base);
    writeFileSync(join(repo, "ev.txt"), "OLD\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "ev old");

    // genuine unlanded: uniq.txt only on the branch
    git(repo, "checkout", "-q", "-b", "unlanded", base);
    writeFileSync(join(repo, "uniq.txt"), "unique\n");
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "uniq");

    // noise-only: change package.json (version) only, no source
    git(repo, "checkout", "-q", "-b", "noiseonly", base);
    writeFileSync(join(repo, "package.json"), '{"version":"9.9.9"}\n');
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "bump");

    // ancestor: points at main's tip
    git(repo, "checkout", "-q", "-b", "ancestor", "main");

    git(repo, "checkout", "-q", "main");
  }, 60_000);

  afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

  test("ancestor of main → merged", async () => {
    expect(await branchStatusFromRepo(repo, "ancestor")).toBe("merged");
  });
  test("squash-landed (content already on main) → merged", async () => {
    expect(await branchStatusFromRepo(repo, "squash")).toBe("merged");
  });
  test("superseded (main evolved the same file) → unmerged (kept, not reaped)", async () => {
    expect(await branchStatusFromRepo(repo, "superseded")).toBe("unmerged");
  });
  test("genuine unlanded work → unmerged (kept, not reaped)", async () => {
    expect(await branchStatusFromRepo(repo, "unlanded")).toBe("unmerged");
  });
  test("noise-only diff (version bump) → merged", async () => {
    expect(await branchStatusFromRepo(repo, "noiseonly")).toBe("merged");
  });
  test("missing branch → gone", async () => {
    expect(await branchStatusFromRepo(repo, "does-not-exist")).toBe("gone");
  });
  test("null branch → gone", async () => {
    expect(await branchStatusFromRepo(repo, null)).toBe("gone");
  });
});
