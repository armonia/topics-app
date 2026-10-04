/**
 * A test process does not open the live state (change `contesto-dall-hub`).
 *
 * Twice something got through: the three test-bench project topics on 16/08 and a
 * global memory holding a test string from 25/08 to 02/10. The gate sits in
 * `resolveStateDir`, the door every state-writing module goes through, not
 * only `createAppContext`.
 *
 * @covers CTX-HUB-03
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertNotLiveStateUnderTest, isTestProcess, LIVE_REPO_ROOT } from "./data-dir";
import { createAppContext } from "../utils";
import { closeDatabase } from "../db";
import { browserStateBaseDir } from "../browser-state-store";

const REPO = resolve(import.meta.dir, "..", "..");
const SERVER_MAIN = join(REPO, "server.ts");

/** Removes the variables that isolate the state for the whole of `fn`. */
function withoutIsolation(fn: () => void): void {
  const saved = { DATA_DIR: process.env.DATA_DIR, TOPICS_DATA_DIR: process.env.TOPICS_DATA_DIR };
  delete process.env.DATA_DIR;
  delete process.env.TOPICS_DATA_DIR;
  try { fn(); } finally {
    if (saved.DATA_DIR !== undefined) process.env.DATA_DIR = saved.DATA_DIR;
    if (saved.TOPICS_DATA_DIR !== undefined) process.env.TOPICS_DATA_DIR = saved.TOPICS_DATA_DIR;
  }
}

describe("assertNotLiveStateUnderTest", () => {
  it("la radice viva e' il repo da cui gira il server", () => {
    expect(LIVE_REPO_ROOT).toBe(REPO);
  });

  it("sotto test, lo stato nel repo e' rifiutato", () => {
    expect(() => assertNotLiveStateUnderTest(REPO, REPO, { NODE_ENV: "test" }, SERVER_MAIN)).toThrow(/live state dir/);
  });

  it("sotto test, anche una cartella DENTRO il repo e' stato vivo", () => {
    expect(() => assertNotLiveStateUnderTest(join(REPO, "server"), REPO, { NODE_ENV: "test" }, SERVER_MAIN)).toThrow(/live state dir/);
  });

  it("sotto test, uno stato isolato passa", () => {
    expect(() => assertNotLiveStateUnderTest(join(tmpdir(), "x"), REPO, { NODE_ENV: "test" }, SERVER_MAIN)).not.toThrow();
  });

  it("fuori dai test lo stato nel repo e' il layout normale", () => {
    expect(() => assertNotLiveStateUnderTest(REPO, REPO, { NODE_ENV: "production" }, SERVER_MAIN)).not.toThrow();
  });
});

describe("isTestProcess", () => {
  it("riconosce bun test anche con NODE_ENV=development: bun non lo sovrascrive", () => {
    expect(isTestProcess({ NODE_ENV: "development" })).toBe(true);
  });

  it("il server vero non e' un test", () => {
    expect(isTestProcess({ NODE_ENV: "development" }, SERVER_MAIN)).toBe(false);
  });
});

describe("i moduli che scrivono stato, sotto bun test", () => {
  it("browser-state senza DATA_DIR rifiuta il repo invece di scriverci", () => {
    withoutIsolation(() => {
      const cwd = process.cwd();
      process.chdir(REPO);
      try {
        expect(() => browserStateBaseDir()).toThrow(/live state dir/);
      } finally { process.chdir(cwd); }
    });
  });

  it("createAppContext senza DATA_DIR rifiuta di aprire il repo", () => {
    withoutIsolation(() => {
      expect(() => createAppContext(REPO)).toThrow(/live state dir/);
    });
  });

  it("con DATA_DIR isolato il contesto si apre", () => {
    const tmp = mkdtempSync(join(tmpdir(), "live-guard-"));
    const saved = process.env.DATA_DIR;
    process.env.DATA_DIR = tmp;
    try {
      expect(() => createAppContext(REPO)).not.toThrow();
    } finally {
      closeDatabase();
      if (saved === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
