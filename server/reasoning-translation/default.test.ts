/**
 * Which language the reasoning is translated into: the output language of the
 * settings, else the interface language, else the app default.
 *
 * @covers REASONING-TRANSLATE-01
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { updateAppSettings } from "../services/app-settings";
import { resolveReasoningTarget } from "./default";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "reasoning-target-"));
  const migrations = join(root, "server", "db", "migrations");
  mkdirSync(migrations, { recursive: true });
  const real = join(import.meta.dir, "../db/migrations");
  for (const f of readdirSync(real)) writeFileSync(join(migrations, f), readFileSync(join(real, f)));
  initDatabase(root);
});
afterAll(() => {
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

const saveInterface = (language: unknown) =>
  getDatabase()
    .prepare("INSERT OR REPLACE INTO ui_state (key, value, updated_at) VALUES ('settings', ?, ?)")
    .run(JSON.stringify({ language }), new Date().toISOString());

beforeEach(() => {
  updateAppSettings({ outputLanguage: null });
  getDatabase().prepare("DELETE FROM ui_state WHERE key = 'settings'").run();
});

describe("the language of the chat", () => {
  test("a chosen output language wins", () => {
    saveInterface("en");
    updateAppSettings({ outputLanguage: "it" });
    expect(resolveReasoningTarget()).toBe("it");
    updateAppSettings({ outputLanguage: "en" });
    expect(resolveReasoningTarget()).toBe("en");
  });

  test("on «auto» the interface language decides", () => {
    updateAppSettings({ outputLanguage: "auto" });
    saveInterface("en");
    expect(resolveReasoningTarget()).toBe("en");
  });

  test("with nothing chosen the app default (Italian) applies, and a junk value is ignored", () => {
    expect(resolveReasoningTarget()).toBe("it");
    saveInterface("klingon");
    expect(resolveReasoningTarget()).toBe("it");
  });
});
