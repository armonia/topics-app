/**
 * @covers NATIVE-UA-01
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pickCliVersion, claudeCliUserAgent, _resetClaudeCliUserAgent, CLAUDE_CLI_VERSION_FLOOR } from "./cli-user-agent";

afterEach(() => _resetClaudeCliUserAgent());

describe("native provider user-agent", () => {
  test("never declares less than the floor: 2.1.0 made claude-opus-5-5 answer 400", () => {
    expect(pickCliVersion([])).toBe(CLAUDE_CLI_VERSION_FLOOR);
    expect(pickCliVersion(["2.1.0", "2.1.200"])).toBe(CLAUDE_CLI_VERSION_FLOOR);
  });

  test("follows the newest installed CLI, numerically, ignoring junk entries", () => {
    expect(pickCliVersion(["2.1.280", "2.1.1000", ".DS_Store", "2.1.99"])).toBe("2.1.1000");
    expect(pickCliVersion(["3.0.0"])).toBe("3.0.0");
  });

  test("reads the versions directory, and a missing one falls back to the floor", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-ua-"));
    mkdirSync(join(dir, "2.1.300"));
    expect(claudeCliUserAgent(dir)).toBe("claude-cli/2.1.300 (external, cli)");
    _resetClaudeCliUserAgent();
    expect(claudeCliUserAgent(join(dir, "missing"))).toBe(`claude-cli/${CLAUDE_CLI_VERSION_FLOOR} (external, cli)`);
  });
});
