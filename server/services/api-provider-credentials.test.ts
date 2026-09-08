/** @covers MP-SETUP-01 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readApiProviderKey, saveApiProviderKey } from "./api-provider-credentials";
import { configureApiProvider, parseApiConfig } from "./configure-api-provider";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "topics-api-keys-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("installation API credentials", () => {
  test("discovery uses the configured state root even when the process starts elsewhere", () => {
    const path = root();
    saveApiProviderKey("openai", "test-openai", path);
    saveApiProviderKey("claude", "test-claude", path);
    const modulePath = join(import.meta.dir, "api-provider-credentials.ts");
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { configureApiCredentialRoot, readApiProviderKey } from ${JSON.stringify(modulePath)};
      configureApiCredentialRoot(${JSON.stringify(path)});
      if (readApiProviderKey("openai") !== "test-openai" || readApiProviderKey("claude") !== "test-claude") process.exit(1);
    `], { cwd: root(), stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
  });

  test("saved keys survive a fresh read, override env and preserve the other provider", () => {
    const path = root();
    expect(readApiProviderKey("openai", path, { OPENAI_API_KEY: "env-key" })).toBe("env-key");
    saveApiProviderKey("openai", "test-openai", path);
    saveApiProviderKey("claude", "test-claude", path);
    saveApiProviderKey("openai", "replacement", path);
    expect(readApiProviderKey("openai", path, { OPENAI_API_KEY: "env-key" })).toBe("replacement");
    expect(readApiProviderKey("claude", path, {})).toBe("test-claude");
    const dir = join(path, ".topics-secrets");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "providers.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["providers.json"]);
  });

  test("a damaged credential file is not silently overwritten", () => {
    const path = root();
    saveApiProviderKey("openai", "test-key", path);
    const file = join(path, ".topics-secrets/providers.json");
    writeFileSync(file, "damaged");
    expect(() => saveApiProviderKey("claude", "other-key", path)).toThrow("Cannot read");
    expect(readFileSync(file, "utf8")).toBe("damaged");
  });
});

describe("API setup validates before changing working credentials", () => {
  test("rejects malformed input without including the submitted key in errors", () => {
    for (const body of [null, [], { apiKey: "" }, { apiKey: "secret\nvalue" }, { apiKey: "test-key", maxTokens: -1 }, { apiKey: "test-key", maxTokens: "10junk" }]) {
      expect(() => parseApiConfig("openai", body)).toThrow();
    }
    expect(parseApiConfig("openai", { apiKey: "  test-key  ", model: "gpt-5", maxTokens: 2048 })).toEqual({
      type: "openai", apiKey: "test-key", model: "gpt-5", maxTokens: 2048,
    });
  });

  test("bad credentials do not save or apply, and upstream diagnostics cannot leak", async () => {
    const events: string[] = [];
    await expect(configureApiProvider({ type: "openai", apiKey: "test-key" }, {
      diagnose: async () => ({ name: "openai", status: "error", requirements: [], lastError: "echo secret test-key" }),
      save: () => { events.push("save"); }, apply: () => { events.push("apply"); },
    })).rejects.toThrow("API key rejected");
    expect(events).toEqual([]);
  });

  test("a valid connection persists before applying; failed storage leaves the runtime intact", async () => {
    const events: string[] = [];
    const config = { type: "openai" as const, apiKey: "test-key" };
    const deps = {
      diagnose: async () => { events.push("validate"); return { name: "openai", status: "ready" as const, requirements: [] }; },
      save: () => { events.push("save"); }, apply: () => { events.push("apply"); },
    };
    await configureApiProvider(config, deps);
    expect(events).toEqual(["validate", "save", "apply"]);
    events.length = 0;
    await expect(configureApiProvider(config, { ...deps, save: () => { throw new Error("storage unavailable"); } })).rejects.toThrow("storage unavailable");
    expect(events).toEqual(["validate"]);
  });
});
