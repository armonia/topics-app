/**
 * The gateway token as `openclaw.json` holds it: a plain string, or an exec
 * SecretRef that OpenClaw resolves through a provider command. Every resolver
 * here is a fake shell script in a temp dir: no test touches the real config
 * or the Keychain, and no real token value appears anywhere.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshGatewayToken, gatewayToken, GATEWAY_TOKEN_REREAD_MS, holdGatewayToken, readOpenClawGatewayToken, withoutGatewayToken } from "./openclaw-gateway-token";
import { agentAuthOk } from "./agent-auth";

const DIR = mkdtempSync(join(tmpdir(), "openclaw-gateway-token-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const REF = { source: "exec", provider: "keychain", id: "openclaw/gateway-token" };
const ENV_KEYS = ["GATEWAY_TOKEN", "FAKE_RESOLVER_VAR", "HOME", "OPENCLAW_CONFIG_PATH"] as const;
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
    const command = script(`cat > '${seen}'\nprintf '{"protocolVersion":1,"values":{"openclaw/gateway-token":"%s"}}' "$1"`);
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
    const command = answering(`{"protocolVersion":1,"values":{"openclaw/gateway-token":{"nested":"abc"}}}`);
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command } }))).toBeNull();
  });

  it("a resolver that exits non-zero is null, even with a value on stdout", () => {
    const command = script(`cat >/dev/null\nprintf '{"protocolVersion":1,"values":{"openclaw/gateway-token":"abc"}}'\nexit 3`);
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command } }))).toBeNull();
  });

  it("a resolver that reports an error, prints garbage or does not exist is null", () => {
    const errors = answering(`{"values":{},"errors":{"openclaw/gateway-token":{"message":"not found"}}}`);
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: errors } }))).toBeNull();
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: answering("not json") } }))).toBeNull();
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: join(DIR, "missing") } }))).toBeNull();
  });

  it("a response without protocolVersion 1 is null, as OpenClaw refuses it", () => {
    const command = answering(`{"values":{"openclaw/gateway-token":"abc"}}`);
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command } }))).toBeNull();
  });

  it("the resolver gets an empty environment plus passEnv and env, never the server's GATEWAY_TOKEN", () => {
    process.env.FAKE_RESOLVER_VAR = "from-env";
    process.env.GATEWAY_TOKEN = "server-fixture";
    const printing = (name: string) => script(`cat >/dev/null\nprintf '{"protocolVersion":1,"values":{"openclaw/gateway-token":"%s"}}' "$${name}"`);
    const printsFake = printing("FAKE_RESOLVER_VAR");
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: printsFake, passEnv: ["FAKE_RESOLVER_VAR"] } }))).toBe("from-env");
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: printsFake, env: { FAKE_RESOLVER_VAR: "literal" } } }))).toBe("literal");
    // Without passEnv OpenClaw hands the command nothing: neither the variable nor the token.
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: printsFake } }))).toBeNull();
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: printing("GATEWAY_TOKEN") } }))).toBeNull();
  });

  it("runs in the command's own directory and expands ~ in the command, like OpenClaw", () => {
    const command = script(`cat >/dev/null\nprintf '{"protocolVersion":1,"values":{"openclaw/gateway-token":"%s"}}' "$PWD"`);
    process.env.HOME = DIR;
    const fromHome = `~/${command.slice(DIR.length + 1)}`;
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: fromHome } }))).toBe(realpathSync(DIR));
  });

  it("jsonOnly: false takes the bare output for a single id; the default refuses it", () => {
    const bare = answering("bare-fixture");
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: bare, jsonOnly: false } }))).toBe("bare-fixture");
    expect(readOpenClawGatewayToken(config(REF, { keychain: { source: "exec", command: bare } }))).toBeNull();
  });

  it("reads OPENCLAW_CONFIG_PATH when set, the variable OpenClaw itself honours", () => {
    process.env.OPENCLAW_CONFIG_PATH = config("from-override");
    expect(readOpenClawGatewayToken()).toBe("from-override");
    process.env.OPENCLAW_CONFIG_PATH = join(DIR, "nowhere.json");
    expect(readOpenClawGatewayToken()).toBeNull();
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
  it("drops the gateway token and keeps the rest, without touching the input", () => {
    const input = { PATH: "/bin", GATEWAY_TOKEN: "a", HOME: "/h" };
    expect(withoutGatewayToken(input)).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(input.GATEWAY_TOKEN).toBe("a");
  });
});

describe("gatewayToken / holdGatewayToken", () => {
  it("reads the environment until startup holds the token, then never again", () => {
    process.env.GATEWAY_TOKEN = "env-fixture";
    expect(gatewayToken()).toBe("env-fixture");
    holdGatewayToken("held-fixture");
    try {
      // Out of process.env: no child spawned with `...process.env` inherits it.
      expect(process.env.GATEWAY_TOKEN).toBeUndefined();
      expect(gatewayToken()).toBe("held-fixture");
      process.env.GATEWAY_TOKEN = "late-fixture";
      expect(gatewayToken()).toBe("held-fixture");
    } finally {
      // Module state outlives this file in a `bun test` run: leave it empty.
      holdGatewayToken(undefined);
    }
    expect(gatewayToken()).toBeUndefined();
  });
});

describe("freshGatewayToken: an OpenClaw rotation lands without a restart", () => {
  const point = (token: string) => { process.env.OPENCLAW_CONFIG_PATH = config(token); };

  it("re-reads the config, at most every GATEWAY_TOKEN_REREAD_MS, at once with force", () => {
    point("rotated-1");
    holdGatewayToken("boot-fixture");
    try {
      const t0 = Date.now();
      expect(freshGatewayToken({ now: t0 })).toBe("rotated-1");
      point("rotated-2");
      expect(freshGatewayToken({ now: t0 + 1_000 })).toBe("rotated-1");
      expect(freshGatewayToken({ now: t0 + GATEWAY_TOKEN_REREAD_MS })).toBe("rotated-2");
      point("rotated-3");
      expect(freshGatewayToken({ now: t0 + GATEWAY_TOKEN_REREAD_MS + 1, force: true })).toBe("rotated-3");
    } finally {
      holdGatewayToken(undefined);
    }
  });

  it("a token from the environment is never replaced by the config", () => {
    point("from-config");
    holdGatewayToken("from-env-fixture", { fromEnv: true });
    try {
      expect(freshGatewayToken({ force: true })).toBe("from-env-fixture");
    } finally {
      holdGatewayToken(undefined);
    }
  });

  it("agentAuthOk refuses the pre-rotation token and takes the new one", () => {
    holdGatewayToken("leaked-fixture");
    point("rotated-fixture");
    const asking = (token: string) => new Request("http://x/", { headers: { "x-gateway-token": token } });
    try {
      expect(agentAuthOk(asking("leaked-fixture"))).toBe(false);
      expect(agentAuthOk(asking("rotated-fixture"))).toBe(true);
    } finally {
      holdGatewayToken(undefined);
    }
  });
});
