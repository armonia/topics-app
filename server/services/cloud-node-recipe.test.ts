/**
 * The cloud node recipe: sshd drop-ins and the commit identity (card 12f7522f).
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findAttributionViolations } from "./land-attribution-gate";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const recipe = readFileSync(join(import.meta.dir, "../../deploy/cloud-node/user-data.sh.tmpl"), "utf8");

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return { code: r.exitCode, stdout: new TextDecoder().decode(r.stdout).trim(), stderr: "" };
}

describe("cloud node recipe", () => {
  test("installs both sshd drop-ins and reloads sshd after validating", () => {
    expect(recipe).toContain("/etc/ssh/sshd_config.d/10-keys-only.conf");
    expect(recipe).toContain("PasswordAuthentication no");
    expect(recipe).toContain("/etc/ssh/sshd_config.d/20-client-alive.conf");
    expect(recipe).toContain("ClientAliveInterval 15");
    expect(recipe).toContain("ClientAliveCountMax 3");
    expect(recipe).toContain("sshd -t && systemctl reload ssh");
    expect(recipe.indexOf("DEBIAN_FRONTEND")).toBeLessThan(recipe.indexOf("10-keys-only.conf"));
  });

  test("does not hardcode a placeholder commit identity", () => {
    expect(recipe).not.toContain("node@topics.invalid");
    expect(recipe).toContain("user.email @GIT_EMAIL@");
    expect(recipe).toContain("user.name @GIT_NAME@");
  });

  test("a commit made on the node with the origin identity passes the attribution gate", async () => {
    const repo = mkdtempSync(join(tmpdir(), "node-identity-"));
    try {
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "owner@example.test");
      git(repo, "config", "user.name", "owner");
      writeFileSync(join(repo, "a.txt"), "a");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "base");
      git(repo, "checkout", "-q", "-b", "topics/x");
      // The node clone carries the origin identity, as the recipe writes it.
      writeFileSync(join(repo, "b.txt"), "b");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "on node");
      const ok = await findAttributionViolations(repo, "topics/x", ["main"], async (cwd, args) => git(cwd, ...args));
      expect(ok).toEqual([]);
      writeFileSync(join(repo, "c.txt"), "c");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "--author", "Topics node <node@topics.invalid>", "-m", "old recipe");
      const bad = await findAttributionViolations(repo, "topics/x", ["main"], async (cwd, args) => git(cwd, ...args));
      expect(bad?.length).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
