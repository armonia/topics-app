/**
 * Unit tests for the login-state file store (external-tool interop format).
 * Redirects both stores to a tmp dir so it never touches real data/ or the
 * external store. Setting TOPICS_EXTERNAL_STATES_DIR opts the external store in.
  * @covers LOGINST-01
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let prevData: string | undefined;
let prevExternal: string | undefined;
let prevJarvis: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "topics-loginstate-"));
  prevData = process.env.DATA_DIR;
  prevExternal = process.env.TOPICS_EXTERNAL_STATES_DIR;
  prevJarvis = process.env.JARVIS_STATES_DIR;
  process.env.DATA_DIR = join(dir, "data");
  process.env.TOPICS_EXTERNAL_STATES_DIR = join(dir, "external-states");
  // Ensure the legacy alias never leaks into these assertions.
  delete process.env.JARVIS_STATES_DIR;
});
afterAll(() => {
  if (prevData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevData;
  if (prevExternal === undefined) delete process.env.TOPICS_EXTERNAL_STATES_DIR; else process.env.TOPICS_EXTERNAL_STATES_DIR = prevExternal;
  if (prevJarvis === undefined) delete process.env.JARVIS_STATES_DIR; else process.env.JARVIS_STATES_DIR = prevJarvis;
  rmSync(dir, { recursive: true, force: true });
});

// Imported AFTER env is set (the module reads env at call time, so order is fine,
// but keep the import here for clarity).
import {
  saveStateToStores,
  loadStateFromStores,
  topicsStatePath,
  externalStatePath,
  safeHandle,
  externalSanitizeHandle,
  type StorageState,
} from "./browser-login-state";

const sample: StorageState = {
  cookies: [{ name: "sid", value: "abc", domain: "example.com", path: "/" }],
  origins: [{ origin: "https://example.com", localStorage: [{ name: "tok", value: "xyz" }] }],
};

describe("login-state file store", () => {
  it("safeHandle strips traversal and unsafe chars", () => {
    expect(safeHandle("my/handle..\\x")).not.toContain("/");
    expect(safeHandle("ok-name_1.json")).toBe("ok-name_1.json");
    expect(() => safeHandle("..")).toThrow();
    expect(() => safeHandle("")).toThrow();
  });

  it("saves to BOTH the Topics and external stores when the external store is active", () => {
    const r = saveStateToStores("acme", sample);
    expect(existsSync(topicsStatePath("acme"))).toBe(true);
    expect(existsSync(externalStatePath("acme")!)).toBe(true);
    expect(r.externalPath).not.toBeNull();
    expect(r.localStorageCaptured).toBe(true);
    // Files are valid storageState JSON.
    const onDisk = JSON.parse(readFileSync(topicsStatePath("acme"), "utf8"));
    expect(onDisk.cookies[0].name).toBe("sid");
  });

  it("round-trips a handle saved here (source: topics)", () => {
    saveStateToStores("acme", sample);
    const loaded = loadStateFromStores("acme");
    expect(loaded?.source).toBe("topics");
    expect(loaded?.state.cookies[0].value).toBe("abc");
    expect(loaded?.state.origins[0].localStorage[0].value).toBe("xyz");
  });

  it("loads from the external store when from_external is set", () => {
    saveStateToStores("shared", sample);
    const loaded = loadStateFromStores("shared", { fromExternal: true });
    expect(loaded?.source).toBe("external");
    expect(loaded?.state.cookies[0].name).toBe("sid");
  });

  it("flags missing localStorage", () => {
    const r = saveStateToStores("cookieonly", { cookies: sample.cookies, origins: [] });
    expect(r.localStorageCaptured).toBe(false);
  });

  it("returns null for an unknown handle", () => {
    expect(loadStateFromStores("does-not-exist")).toBeNull();
  });

  // --- External interop parity (dot-bearing handles) -----------------------
  // The whole point of the shared external store is that a companion tool's
  // `load-state <h>` finds a Topics-written state. Common companion daemons
  // sanitize by STRIPPING dots (github.com -> github_com); Topics' safeHandle
  // KEEPS them. The external-copy filename MUST use the companion rule or interop
  // silently breaks for the common case (logins are named after sites).
  it("externalSanitizeHandle mirrors the companion daemon rule (strips dots)", () => {
    const ref = (s: string) =>
      String(s || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default";
    for (const h of ["github.com", "app.example.com", "my.login", "weird name!", "a".repeat(80)]) {
      expect(externalSanitizeHandle(h)).toBe(ref(h));
      expect(externalSanitizeHandle(h)).not.toContain(".");
    }
  });

  it("a dotted handle round-trips to Topics (dots kept) and external (dots stripped)", () => {
    saveStateToStores("github.com", sample);
    // Topics-local keeps the liberal name.
    expect(topicsStatePath("github.com")).toContain("github.com.json");
    expect(existsSync(topicsStatePath("github.com"))).toBe(true);
    // External copy lands under the name a companion load-state will look for.
    expect(externalStatePath("github.com")).toContain("github_com.json");
    expect(externalStatePath("github.com")).not.toContain("github.com.json");
    expect(existsSync(externalStatePath("github.com")!)).toBe(true);
    // from_external (the companion-equivalent path) resolves the same file.
    const loaded = loadStateFromStores("github.com", { fromExternal: true });
    expect(loaded?.source).toBe("external");
    expect(loaded?.state.cookies[0].name).toBe("sid");
  });
});
