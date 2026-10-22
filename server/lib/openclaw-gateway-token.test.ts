/**
 * The gateway token as `openclaw.json` holds it: a plain string, or an exec
 * SecretRef that OpenClaw resolves through a provider command. Every resolver
 * here is a fake shell script in a temp dir: no test touches the real config
 * or the Keychain, and no real token value appears anywhere.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOpenClawGatewayToken, withoutGatewayToken } from "./openclaw-gateway-token";

const DIR = mkdtempSync(join(tmpdir(), "openclaw-gateway-token-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const REF = { source: "exec", provider: "keychain", id: "openclaw/gateway-token" };
const ENV_KEYS = ["GATEWAY_TOKEN", "FAKE_RESOLVER_VAR"] as const;
const envBefore = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
});

let n = 0;
/** A fake resolver: a shell script with the given body, made executable. */
function script(body: string): string {
  const path = join(DIR, `resolver-${++n}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** An openclaw.json with the given token and providers. */
function config(token: unknown, providers?: Record<string, unknown>): string {
  const path = join(DIR, `openclaw-${++n}.json`);
  writeFileSync(path, JSON.stringify({ gateway: { auth: { mode: "token", token } }, ...(providers ? { secrets: { providers } } : {}) }));
  return path;
}

const answering = (stdout: string) => script(`cat >/dev/null\nprintf '%s' '${stdout}'`);

describe("readOpenClawGatewayToken", () => {
  it("returns a plain string token, trimmed", () => {
    expect(readOpenClawGatewayToken(config("  plain-fixture  "))).toBe("plain-fixture");
  });

  it("an empty or blank string is no token", () => {
    expect(readOpenClawGatewayToken(config(""))).toBeNull();
    expect(readOpenClawGatewayToken(config("   "))).toBeNull();
  });

  it("resolves an exec SecretRef through the provider's command", () => {
    const command = answering(`{"protocolVersion":1,"values":{"openclaw/gateway-token":"abc"},"errors":{}}`);
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command } }))).toBe("abc");
  });

  it("speaks the exec protocol on stdin and passes the provider's args", () => {
    const seen = join(DIR, "request.json");
    const command = script(`cat > '${seen}'\nprintf '{"values":{"openclaw/gateway-token":"%s"}}' "$1"`);
    const token = readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command, args: ["from-arg"] } }));
    expect(token).toBe("from-arg");
    expect(JSON.parse(readFileSync(seen, "utf-8"))).toEqual({
      protocolVersion: 1,
      provider: "keychain",
      ids: ["openclaw/gateway-token"],
    });
  });

  it("a SecretRef whose provider is missing is null", () => {
    expect(readOpenClawGatewayToken(config(REF))).toBeNull();
    expect(readOpenClawGatewayToken(config(REF, { other: { source: "exec", command: answering("{}") } }))).toBeNull();
  });

  it("a provider that is not exec, or has no command, is null", () => {
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "file", path: "/nope" } }))).toBeNull();
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec" } }))).toBeNull();
  });

  it("a resolver that returns an object instead of a string is null", () => {
    const command = answering(`{"values":{"openclaw/gateway-token":{"nested":"abc"}}}`);
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command } }))).toBeNull();
  });

  it("a resolver that exits non-zero is null, even with a value on stdout", () => {
    const command = script(`cat >/dev/null\nprintf '{"values":{"openclaw/gateway-token":"abc"}}'\nexit 3`);
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command } }))).toBeNull();
  });

  it("a resolver that reports an error, prints garbage or does not exist is null", () => {
    const errors = answering(`{"values":{},"errors":{"openclaw/gateway-token":{"message":"not found"}}}`);
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: errors } }))).toBeNull();
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: answering("not json") } }))).toBeNull();
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: join(DIR, "missing") } }))).toBeNull();
  });

  it("the resolver gets only passEnv, and never the server's GATEWAY_TOKEN", () => {
    process.env.FAKE_RESOLVER_VAR = "from-env";
    process.env.GATEWAY_TOKEN = "server-fixture";
    const printing = (name: string) => script(`cat >/dev/null\nprintf '{"values":{"openclaw/gateway-token":"%s"}}' "$${name}"`);
    const printsFake = printing("FAKE_RESOLVER_VAR");
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: printsFake, passEnv: ["FAKE_RESOLVER_VAR"] } }))).toBe("from-env");
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: printsFake, passEnv: ["PATH"] } }))).toBeNull();
    // Without passEnv the resolver inherits the environment, minus the gateway token.
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: printing("GATEWAY_TOKEN") } }))).toBeNull();
  });

  it("a missing or broken file is null", () => {
    expect(readOpenClawGatewayToken(join(DIR, "does-not-exist.json"))).toBeNull();
    const broken = join(DIR, "broken.json");
    writeFileSync(broken, "{ not json");
    expect(readOpenClawGatewayToken(broken)).toBeNull();
    const noToken = join(DIR, "no-token.json");
    writeFileSync(noToken, JSON.stringify({ gateway: { auth: { mode: "token" } } }));
    expect(readOpenClawGatewayToken(noToken)).toBeNull();
  });
});

describe("withoutGatewayToken", () => {
  it("drops both gateway token names and keeps the rest, without touching the input", () => {
    const input = { PATH: "/bin", GATEWAY_TOKEN: "a", TOPICS_GATEWAY_TOKEN: "b", HOME: "/h" };
    expect(withoutGatewayToken(input)).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(input.GATEWAY_TOKEN).toBe("a");
  });
});
