/**
 * A node with no origin has a stale main; retries widen the branch bundle only
 * when it refuses missing prerequisites.
 * @covers KANBAN-76
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { CARD, harness, PC } from "./task-dispatcher-overflow.harness";
import type { BundleReach } from "./branch-on-origin";
import { CHILD_BUNDLE_MARGIN_COMMITS } from "../lib/subagent-remote-spawn";

describe("a stale node receives a wider carried branch bundle", () => {
  const git = (cwd: string, ...args: string[]) => {
    // An identity of its own: the CI runner has no global git user (27/11, PR #1763 red on "Please tell me who you are").
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: gitEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }) });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };

  it("retries after a prerequisite refusal and starts from the branch tip", async () => {
    const root = mkdtempSync(join(tmpdir(), "node-bundle-ladder-"));
    const origin = join(root, "origin.git");
    const mac = join(root, "mac");
    const node = join(root, "node");
    try {
      git(root, "init", "--bare", "-q", "-b", "main", origin);
      git(root, "clone", "-q", origin, mac);
      git(mac, "switch", "-q", "-c", "main");
      writeFileSync(join(mac, "base.txt"), "base\n");
      git(mac, "add", "."); git(mac, "commit", "-q", "-m", "base"); git(mac, "push", "-q", "-u", "origin", "main");
      git(root, "clone", "-q", origin, node);
      git(node, "remote", "remove", "origin");
      writeFileSync(join(mac, "main.txt"), "new main\n");
      git(mac, "add", "."); git(mac, "commit", "-q", "-m", "new main"); git(mac, "push", "-q", "origin", "main");
      git(mac, "fetch", "origin"); git(mac, "remote", "set-head", "origin", "main");
      git(mac, "switch", "-q", "-c", "topics/endless-calf");
      for (const name of ["one", "two", "three"]) {
        writeFileSync(join(mac, `${name}.txt`), `${name}\n`);
        git(mac, "add", "."); git(mac, "commit", "-q", "-m", name);
      }
      const tip = git(mac, "rev-parse", "HEAD");
      const attempts: ("refused" | "planted")[] = [];
      const startedFrom: string[] = [];
      const reaches: BundleReach[] = [];
      const h = harness({ floor: false, noOrigin: { mac, node, startedFrom, attempts, reaches } });
      h.sendBack(CARD, "topics/endless-calf", { machineId: PC });
      await h.tick();
      for (let i = 0; i < 100 && startedFrom.length === 0; i++) await new Promise((res) => setTimeout(res, 50));
      expect(attempts).toEqual(["refused", "planted"]);
      // The margin comes before the whole history: 4.8 MB against 148 MB for this repo.
      expect(reaches).toEqual([0, CHILD_BUNDLE_MARGIN_COMMITS]);
      expect(startedFrom).toEqual([tip]);
      expect(h.bodies).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
