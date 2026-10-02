/**
 * Un processo di test non apre lo stato vivo (change `contesto-dall-hub`).
 *
 * Due volte qualcosa e' passato: i tre topic «bench progetto» del 16/08 e una
 * memoria globale con una stringa di test dal 25/08 al 02/10. Il cancello sta in
 * `createAppContext`, l'unica porta da cui passa ogni contesto.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertNotLiveStateUnderTest } from "./data-dir";
import { createAppContext } from "../utils";
import { closeDatabase } from "../db";

const REPO = resolve(import.meta.dir, "..", "..");

describe("assertNotLiveStateUnderTest", () => {
  it("sotto test, lo stato nel repo e' rifiutato", () => {
    expect(() => assertNotLiveStateUnderTest(REPO, REPO, { NODE_ENV: "test" })).toThrow(/live state dir/);
  });

  it("sotto test, uno stato isolato passa", () => {
    expect(() => assertNotLiveStateUnderTest(join(tmpdir(), "x"), REPO, { NODE_ENV: "test" })).not.toThrow();
  });

  it("fuori dai test lo stato nel repo e' il layout normale", () => {
    expect(() => assertNotLiveStateUnderTest(REPO, REPO, { NODE_ENV: "production" })).not.toThrow();
  });
});

describe("createAppContext sotto bun test", () => {
  it("senza DATA_DIR rifiuta di aprire il repo: niente topic ne' memoria scritti nello stato vivo", () => {
    const saved = { DATA_DIR: process.env.DATA_DIR, TOPICS_DATA_DIR: process.env.TOPICS_DATA_DIR };
    delete process.env.DATA_DIR;
    delete process.env.TOPICS_DATA_DIR;
    try {
      expect(() => createAppContext(REPO)).toThrow(/live state dir/);
    } finally {
      if (saved.DATA_DIR !== undefined) process.env.DATA_DIR = saved.DATA_DIR;
      if (saved.TOPICS_DATA_DIR !== undefined) process.env.TOPICS_DATA_DIR = saved.TOPICS_DATA_DIR;
    }
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
