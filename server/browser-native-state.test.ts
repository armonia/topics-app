/**
 * @covers NATSTATE-01
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeStateOp, isNativeStateOp } from "./browser-native-state";
import { createNativeDelegateRegistry } from "./browser-native-delegate";
import type { StorageState } from "./browser-login-state";

/** Real registry wired to a scripted client: each delegated op is answered from
 *  `script` (by tool name) via the REAL resolveOp path — no socket needed. */
function scriptedRegistry(script: Record<string, { result?: unknown; error?: string }>) {
  const registry = createNativeDelegateRegistry();
  const seen: Array<{ tool: string; args: unknown }> = [];
  registry.register("ctx", (msg) => {
    seen.push({ tool: msg.tool, args: msg.args });
    const reply = script[msg.tool] ?? { error: `no script for ${msg.tool}` };
    queueMicrotask(() => registry.resolveOp({ opId: msg.opId, ...reply }));
  });
  return { registry, seen };
}

let dir: string;
let prevDataDir: string | undefined;
let prevExternalDir: string | undefined;
let prevJarvisDir: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "native-state-"));
  prevDataDir = process.env.DATA_DIR;
  prevExternalDir = process.env.TOPICS_EXTERNAL_STATES_DIR;
  prevJarvisDir = process.env.JARVIS_STATES_DIR;
  process.env.DATA_DIR = join(dir, "data");
  process.env.TOPICS_EXTERNAL_STATES_DIR = join(dir, "external");
  delete process.env.JARVIS_STATES_DIR;
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  if (prevExternalDir === undefined) delete process.env.TOPICS_EXTERNAL_STATES_DIR;
  else process.env.TOPICS_EXTERNAL_STATES_DIR = prevExternalDir;
  if (prevJarvisDir === undefined) delete process.env.JARVIS_STATES_DIR;
  else process.env.JARVIS_STATES_DIR = prevJarvisDir;
  rmSync(dir, { recursive: true, force: true });
});

const STATE: StorageState = {
  cookies: [{ name: "sid", value: "s", domain: "example.com", path: "/", expires: -1 }],
  origins: [{ origin: "https://example.com", localStorage: [{ name: "t", value: "1" }] }],
};

test("isNativeStateOp covers exactly the three login-state ops", () => {
  expect(isNativeStateOp("browser_save_state")).toBe(true);
  expect(isNativeStateOp("browser_load_state")).toBe(true);
  expect(isNativeStateOp("browser_import_chrome")).toBe(true);
  expect(isNativeStateOp("browser_observe")).toBe(false);
});

test("save_state delegates the export leg and persists to BOTH stores (handler-shaped result)", async () => {
  const { registry, seen } = scriptedRegistry({ browser_save_state: { result: STATE } });
  const out = await nativeStateOp("browser_save_state", { handle: "example" }, "ctx", { registry });
  expect(out).toEqual({ ok: true, handle: "example", cookies: 1, origins: 1, localStorageCaptured: true });
  expect(seen).toEqual([{ tool: "browser_save_state", args: {} }]);
  // Dual-write: Topics store + external store, same storageState JSON.
  const topics = JSON.parse(readFileSync(join(dir, "data", "browser-state", "_handles", "example.json"), "utf8"));
  const external = JSON.parse(readFileSync(join(dir, "external", "example.json"), "utf8"));
  expect(topics).toEqual(STATE as never);
  expect(external).toEqual(STATE as never);
});

test("save_state without localStorage carries the save-while-on-the-site warning", async () => {
  const { registry } = scriptedRegistry({
    browser_save_state: { result: { cookies: STATE.cookies, origins: [] } },
  });
  const out = (await nativeStateOp("browser_save_state", { handle: "bare" }, "ctx", { registry })) as {
    localStorageCaptured: boolean;
    warning?: string;
  };
  expect(out.localStorageCaptured).toBe(false);
  expect(out.warning).toContain("No localStorage captured");
});

test("save_state validates the handle by throwing (dispatcher contract)", async () => {
  const { registry } = scriptedRegistry({});
  await expect(nativeStateOp("browser_save_state", {}, "ctx", { registry })).rejects.toThrow("'handle' (string) is required");
});

test("load_state resolves the handle server-side and delegates only the apply leg", async () => {
  const saved = scriptedRegistry({ browser_save_state: { result: STATE } });
  await nativeStateOp("browser_save_state", { handle: "example" }, "ctx", { registry: saved.registry });

  const { registry, seen } = scriptedRegistry({ browser_load_state: { result: { ok: true, cookies: 1, origins: 1 } } });
  const out = await nativeStateOp("browser_load_state", { handle: "example" }, "ctx", { registry });
  expect(out).toEqual({ ok: true, handle: "example", source: "topics", cookies: 1, origins: 1 });
  expect(seen).toEqual([{ tool: "browser_load_state", args: { state: STATE } }]);
});

test("load_state for a missing handle is a structured error (nothing delegated)", async () => {
  const { registry, seen } = scriptedRegistry({});
  const out = await nativeStateOp("browser_load_state", { handle: "nope" }, "ctx", { registry });
  expect((out as { error: string }).error).toContain('no saved state for handle "nope"');
  expect(seen).toHaveLength(0);
});

test("import_chrome dry_run lists hosts server-side without delegating or decrypting", async () => {
  const { registry, seen } = scriptedRegistry({});
  const hosts = { dryRun: true as const, browser: "chrome" as const, profile: "Default", totalCookies: 2, hostCount: 1, hosts: [{ domain: ".youtube.com", cookies: 2 }] };
  const out = await nativeStateOp(
    "browser_import_chrome",
    { dry_run: true, domains: ["youtube.com"] },
    "ctx",
    { registry, listChromeHosts: async () => hosts, decryptChrome: async () => { throw new Error("must not decrypt"); } },
  );
  expect(out).toEqual(hosts);
  expect(seen).toHaveLength(0);
});

test("import_chrome decrypts server-side and delegates only the inject leg", async () => {
  const { registry, seen } = scriptedRegistry({ browser_import_chrome: { result: { ok: true, imported: 2 } } });
  const cookies = [
    { name: "sid", value: "v", secure: true, httpOnly: true, url: "https://youtube.com/" },
    { name: "dom", value: "w", secure: false, httpOnly: false, domain: ".youtube.com", path: "/" },
  ];
  const out = await nativeStateOp(
    "browser_import_chrome",
    { domains: ["youtube.com"] },
    "ctx",
    {
      registry,
      decryptChrome: async () => ({ browser: "chrome" as const, profile: "Default", domains: ["youtube.com"], cookies: cookies as never, decrypted: 2, decryptFailed: 1, skippedEmpty: 0, appBoundEncrypted: 3 }),
    },
  );
  expect(out).toEqual({ ok: true, browser: "chrome", profile: "Default", imported: 2, decryptFailed: 1, skippedEmpty: 0, appBoundEncrypted: 3 });
  expect(seen).toEqual([{ tool: "browser_import_chrome", args: { cookies } }]);
});

test("import_chrome forwards the chosen browser to both the dry-run and decrypt legs", async () => {
  const { registry } = scriptedRegistry({ browser_import_chrome: { result: { ok: true, imported: 1 } } });

  let dryArgs: unknown = null;
  await nativeStateOp(
    "browser_import_chrome",
    { dry_run: true, browser: "dia" },
    "ctx",
    { registry, listChromeHosts: async (a: unknown) => { dryArgs = a; return { hosts: [] }; } } as never,
  );
  expect((dryArgs as { browser?: string }).browser).toBe("dia");

  let decArgs: unknown = null;
  const out = await nativeStateOp(
    "browser_import_chrome",
    { domains: ["dash.cloudflare.com"], browser: "dia" },
    "ctx",
    {
      registry,
      decryptChrome: async (a: unknown) => {
        decArgs = a;
        return { browser: "dia", profile: "Profile 1", domains: ["dash.cloudflare.com"], cookies: [{ name: "s", value: "v", secure: true, httpOnly: true, url: "https://dash.cloudflare.com/" }] as never, decrypted: 1, decryptFailed: 0, skippedEmpty: 0, appBoundEncrypted: 0 };
      },
    } as never,
  );
  expect((decArgs as { browser?: string }).browser).toBe("dia");
  // The reply names the browser the cookies actually came from, so a caller can
  // tell a chrome fallback from the browser it asked for.
  expect(out).toMatchObject({ ok: true, browser: "dia", profile: "Profile 1", imported: 1 });
});

test("import_chrome without a browser stays on the chrome default", async () => {
  const { registry } = scriptedRegistry({});
  let dryArgs: unknown = null;
  await nativeStateOp(
    "browser_import_chrome",
    { dry_run: true },
    "ctx",
    { registry, listChromeHosts: async (a: unknown) => { dryArgs = a; return { hosts: [] }; } } as never,
  );
  expect((dryArgs as { browser?: string }).browser).toBeUndefined();
});

test("import_chrome without domains (and not dry_run) throws (dispatcher contract)", async () => {
  const { registry } = scriptedRegistry({});
  await expect(nativeStateOp("browser_import_chrome", {}, "ctx", { registry })).rejects.toThrow('"domains" (non-empty array) is required');
});

test("a delegated error passes through failsoft (agent sees the pane's structured error)", async () => {
  const { registry } = scriptedRegistry({ browser_load_state: { error: "native browser pane disconnected" } });
  const saved = scriptedRegistry({ browser_save_state: { result: STATE } });
  await nativeStateOp("browser_save_state", { handle: "h" }, "ctx", { registry: saved.registry });
  const out = await nativeStateOp("browser_load_state", { handle: "h" }, "ctx", { registry });
  expect(out).toEqual({ error: "native browser pane disconnected" });
});
