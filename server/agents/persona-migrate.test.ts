// @covers AGENTS-PERSONA-01
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { migratePrincipalSoul } from "./persona-migrate";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "persona-migrate-"));
  dirs.push(d);
  return d;
}

describe("migratePrincipalSoul", () => {
  test("directives go to RULES.md, never USER.md, agent-specific additions stay in SOUL.md, both backed up", () => {
    const home = tmp();
    const ws = tmp();
    writeFileSync(join(ws, "SOUL.md"), "Generic text plus directives plus permissions, 10 lines.");

    const result = migratePrincipalSoul(
      { home, expand: (p) => p },
      ws,
      { directives: "Always answer in Italian.", agentAdditions: "May read Discord DMs from the owner." },
    );

    expect(readFileSync(result.userFile, "utf8").trim()).toBe("Always answer in Italian.");
    expect(readFileSync(result.soulFile, "utf8").trim()).toBe("May read Discord DMs from the owner.");
    expect(result.soulBackup).toBeTruthy();
    expect(existsSync(result.soulBackup!)).toBe(true);
    expect(readFileSync(result.soulBackup!, "utf8")).toContain("10 lines");
  });

  test("a second agent's directives append to an existing RULES.md instead of erasing it", () => {
    const home = tmp();
    writeFileSync(join(home, "RULES.md"), "Always answer in Italian.\n");
    const ws = tmp();
    writeFileSync(join(ws, "SOUL.md"), "second agent's generic text");

    const result = migratePrincipalSoul(
      { home, expand: (p) => p },
      ws,
      { directives: "Lives in Europe/Rome.", agentAdditions: "" },
    );

    const user = readFileSync(result.userFile, "utf8");
    expect(user).toContain("Always answer in Italian.");
    expect(user).toContain("Lives in Europe/Rome.");
  });

  test("no SOUL.md yet — no backup, still writes the new one", () => {
    const home = tmp();
    const ws = tmp();
    const result = migratePrincipalSoul({ home, expand: (p) => p }, ws, { directives: "", agentAdditions: "kept" });
    expect(result.soulBackup).toBeNull();
    expect(readFileSync(result.soulFile, "utf8").trim()).toBe("kept");
  });
});
