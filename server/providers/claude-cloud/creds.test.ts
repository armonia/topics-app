/**
 * Which cloud account a node runs on: one without the sessions scope is skipped, not fatal.
 *
 * @covers KANBAN-76
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCloudAccount } from "./creds";

const FULL = ["user:inference", "user:profile", "user:sessions:claude_code"];

function dirWith(accounts: Record<string, string[]>): string {
  const d = mkdtempSync(join(tmpdir(), "cloud-acct-"));
  for (const [name, scopes] of Object.entries(accounts)) {
    writeFileSync(join(d, `${name}.json`), JSON.stringify({ claudeAiOauth: { accessToken: "x", scopes } }));
  }
  return d;
}

describe("resolveCloudAccount", () => {
  test("keeps an account that can open sessions, silently", () => {
    const d = dirWith({ "auto-1": FULL });
    const logs: string[] = [];
    expect(resolveCloudAccount("auto-1", d, (m) => logs.push(m))).toBe("auto-1");
    expect(logs).toEqual([]);
    rmSync(d, { recursive: true });
  });

  test("inference-only account falls back to one with session scopes and says so", () => {
    const d = dirWith({ "auto-2": ["user:inference"], "auto-3": ["user:inference"], "auto-4": FULL });
    const logs: string[] = [];
    expect(resolveCloudAccount("auto-2", d, (m) => logs.push(m))).toBe("auto-4");
    expect(logs[0]).toContain("auto-2");
    expect(logs[0]).toContain("auto-4");
    rmSync(d, { recursive: true });
  });

  test("no account with scopes: Keychain login, logged", () => {
    const d = dirWith({ "auto-9": ["user:inference"] });
    const logs: string[] = [];
    expect(resolveCloudAccount("auto-9", d, (m) => logs.push(m))).toBeUndefined();
    expect(logs[0]).toContain("Portachiavi");
    rmSync(d, { recursive: true });
  });

  test("no configured account: Keychain login", () => {
    expect(resolveCloudAccount(undefined, "/nonexistent")).toBeUndefined();
  });
});
