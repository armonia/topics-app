/**
 * `agent-engine.json`: a missing or broken file is the empty profile, and a
 * ceiling is kept only when it is a positive number of tokens.
 *
 * @covers CHAT-COMPACT-06
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compactAtTokensFor, parseAgentEngineSettings, readAgentEngineSettings } from "./agent-engine-settings";

const dir = mkdtempSync(join(tmpdir(), "agent-engine-settings-"));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("agent-engine.json", () => {
  test("no file and a broken file both read as no profile", () => {
    expect(readAgentEngineSettings(join(dir, "missing.json"))).toEqual({ agents: {} });
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    expect(readAgentEngineSettings(broken)).toEqual({ agents: {} });
  });

  test("a well-formed ceiling is read, whole tokens", () => {
    const file = join(dir, "ok.json");
    writeFileSync(file, JSON.stringify({ agents: { main: { compactAtTokens: 200_000.7 }, gtm: { compactAtTokens: 150_000 } } }));
    const s = readAgentEngineSettings(file);
    expect(compactAtTokensFor("main", s)).toBe(200_000);
    expect(compactAtTokensFor("gtm", s)).toBe(150_000);
  });

  test("anything that is not a positive number is dropped, and an ordinary chat has no ceiling", () => {
    const s = parseAgentEngineSettings({ agents: { a: { compactAtTokens: 0 }, b: { compactAtTokens: -1 }, c: { compactAtTokens: "200000" }, d: null, e: {} } });
    expect(s).toEqual({ agents: {} });
    expect(parseAgentEngineSettings(null)).toEqual({ agents: {} });
    expect(compactAtTokensFor(null, { agents: { main: { compactAtTokens: 1 } } })).toBeNull();
    expect(compactAtTokensFor("unknown", { agents: { main: { compactAtTokens: 1 } } })).toBeNull();
  });
});
