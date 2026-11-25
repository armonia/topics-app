/**
 * The reasoning translation service: what it translates, what it leaves alone,
 * and what it remembers.
 *
 * The adapter is a scripted fake at the translator interface. The real one has
 * its own tests (`apple-adapter.test.ts`, with a fake helper process and, on a
 * Mac that can, the real helper).
 *
 * @covers REASONING-TRANSLATE-01
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ReasoningTranslationService,
  hashSentence,
  sqliteTranslationStore,
  type TranslationStore,
} from "./service";
import type { DetectedLanguage, ReasoningTranslator } from "./translator";

/** In-memory store the translation tests inject in place of the database one. */
const memoryTranslationStore = (): TranslationStore => {
  const rows = new Map<string, string>();
  return {
    get: (hash, target) => rows.get(`${hash}|${target}`) ?? null,
    put: (hash, target, _source, text) => void rows.set(`${hash}|${target}`, text),
  };
};

const ENGLISH = "First I need to read the failing test and see what it expects. Then I will check the migration file for the new column.";
const ITALIAN = "Prima devo leggere il test che fallisce e vedere cosa si aspetta. Poi controllerò il file di migrazione per la nuova colonna.";

interface FakeOptions {
  available?: boolean;
  detected?: DetectedLanguage | null;
  pairReady?: boolean;
  failOn?: string;
}

/** A translator that says what it is told and counts what it is asked. */
function fakeTranslator(options: FakeOptions = {}) {
  const calls = { translate: [] as string[], detect: 0, available: 0 };
  const translator: ReasoningTranslator = {
    name: "fake",
    available: async () => {
      calls.available++;
      return options.available ?? true;
    },
    detect: async (text) => {
      calls.detect++;
      if (options.detected !== undefined) return options.detected;
      return { language: /\b(the|and|then)\b/i.test(text) ? "en" : "it", confidence: 0.99 };
    },
    pairReady: async () => options.pairReady ?? true,
    translate: async (text) => {
      calls.translate.push(text);
      if (options.failOn && text.includes(options.failOn)) throw new Error("boom");
      return `«${text}»`;
    },
  };
  return { translator, calls };
}

function serviceWith(options: FakeOptions = {}, target = "it", store: TranslationStore = memoryTranslationStore()) {
  const { translator, calls } = fakeTranslator(options);
  return { service: new ReasoningTranslationService({ translator, store, resolveTarget: () => target }), calls, store };
}

describe("a settled block", () => {
  test("English in an Italian chat is translated sentence by sentence", async () => {
    const { service } = serviceWith();
    const result = await service.translateText(ENGLISH);
    expect(result.available).toBe(true);
    expect(result.target).toBe("it");
    expect(result.sentences.map((s) => s.source)).toEqual([
      "First I need to read the failing test and see what it expects.",
      "Then I will check the migration file for the new column.",
    ]);
    expect(result.sentences[0]!.text).toBe("«First I need to read the failing test and see what it expects.»");
  });

  test("Italian in an Italian chat is left alone, and the translator is never asked", async () => {
    const { service, calls } = serviceWith();
    const result = await service.translateText(ITALIAN);
    expect(result.sentences).toEqual([]);
    expect(calls.translate).toEqual([]);
  });

  test("a very short block is not translated, whatever the detector says", async () => {
    const { service, calls } = serviceWith({ detected: { language: "fr", confidence: 1 } });
    for (const short of ["ok", "Fine.", "Let me check."]) {
      expect((await service.translateText(short)).sentences).toEqual([]);
    }
    expect(calls.detect).toBe(0);
    expect(calls.translate).toEqual([]);
  });

  test("a detector that is not sure leaves the original", async () => {
    const { service, calls } = serviceWith({ detected: { language: "en", confidence: 0.4 } });
    expect((await service.translateText(ENGLISH)).sentences).toEqual([]);
    expect(calls.translate).toEqual([]);
  });

  test("an adapter that is not available gives the original and says so", async () => {
    const { service, calls } = serviceWith({ available: false });
    const result = await service.translateText(ENGLISH);
    expect(result).toEqual({ available: false, target: "it", sentences: [] });
    expect(calls.translate).toEqual([]);
  });

  test("a language pair that is not installed gives the original", async () => {
    const { service, calls } = serviceWith({ pairReady: false });
    expect((await service.translateText(ENGLISH)).sentences).toEqual([]);
    expect(calls.translate).toEqual([]);
  });

  test("a sentence the adapter fails on stays original, the others are translated", async () => {
    const { service } = serviceWith({ failOn: "migration" });
    const result = await service.translateText(ENGLISH);
    expect(result.sentences.map((s) => s.source)).toEqual(["First I need to read the failing test and see what it expects."]);
  });

  test("the target is the chat language: English into an English chat is left alone", async () => {
    const { service } = serviceWith({}, "en");
    expect((await service.translateText(ENGLISH)).sentences).toEqual([]);
  });

  test("a translated sentence is remembered: the second time nothing is translated", async () => {
    const { service, calls } = serviceWith();
    await service.translateText(ENGLISH);
    expect(calls.translate).toHaveLength(2);
    const again = await service.translateText(ENGLISH);
    expect(calls.translate).toHaveLength(2);
    expect(again.sentences).toHaveLength(2);
  });
});

describe("a block while it streams", () => {
  const deltas = (text: string, size: number) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [];

  test("each sentence leaves once it has closed, in order, and the last one at the end", async () => {
    const { service } = serviceWith();
    const seen: Array<{ index: number; source: string }> = [];
    const stream = service.createStream((s) => seen.push({ index: s.index, source: s.source }));
    for (const piece of deltas(ENGLISH, 9)) stream.push(piece);
    await Promise.resolve();
    await stream.end();
    expect(seen.map((s) => s.index)).toEqual([0, 1]);
    expect(seen[1]!.source).toBe("Then I will check the migration file for the new column.");
  });

  test("a sentence still being written is not sent", async () => {
    const { service, calls } = serviceWith();
    const stream = service.createStream(() => {});
    stream.push("First I need to read the failing test and see what it expects. Then I will chec");
    // The first sentence is closed, the second is not: only one translation, and the end has not come.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.translate).toEqual(["First I need to read the failing test and see what it expects."]);
  });

  test("Italian streaming in an Italian chat emits nothing", async () => {
    const { service } = serviceWith();
    const seen: unknown[] = [];
    const stream = service.createStream((s) => seen.push(s));
    for (const piece of deltas(ITALIAN, 11)) stream.push(piece);
    await stream.end();
    expect(seen).toEqual([]);
  });

  test("a block too short to name its language emits nothing", async () => {
    const { service } = serviceWith();
    const seen: unknown[] = [];
    const stream = service.createStream((s) => seen.push(s));
    stream.push("Let me check.");
    await stream.end();
    expect(seen).toEqual([]);
  });

  test("with no adapter the stream emits nothing and never throws", async () => {
    const { service } = serviceWith({ available: false });
    const seen: unknown[] = [];
    const stream = service.createStream((s) => seen.push(s));
    stream.push(ENGLISH);
    await stream.end();
    expect(seen).toEqual([]);
  });
});

describe("the sentence cache table (migration 20261118120000)", () => {
  const migration = readFileSync(join(import.meta.dir, "../db/migrations/20261118120000-reasoning-translations.sql"), "utf8");

  test("the migration creates the table on a bare database and is safe to run twice", () => {
    const db = new Database(":memory:");
    db.exec(migration);
    db.exec(migration);
    const columns = (db.prepare("PRAGMA table_info(reasoning_translations)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(["source_hash", "target_language", "source_language", "translated_text", "created_at"]);
  });

  test("a sentence is stored per target language and read back by its hash", () => {
    const db = new Database(":memory:");
    db.exec(migration);
    const store = sqliteTranslationStore(db);
    const hash = hashSentence("Then I will check the migration file.");
    expect(store.get(hash, "it")).toBeNull();
    store.put(hash, "it", "en", "Poi controllerò il file di migrazione.");
    store.put(hash, "fr", "en", "Puis je vérifierai le fichier.");
    expect(store.get(hash, "it")).toBe("Poi controllerò il file di migrazione.");
    expect(store.get(hash, "fr")).toBe("Puis je vérifierai le fichier.");
    store.put(hash, "it", "en", "Poi guarderò il file di migrazione.");
    expect(store.get(hash, "it")).toBe("Poi guarderò il file di migrazione.");
  });

  test("a translation survives a new service on the same database: a reload does not translate again", async () => {
    const db = new Database(":memory:");
    db.exec(migration);
    const first = serviceWith({}, "it", sqliteTranslationStore(db));
    await first.service.translateText(ENGLISH);
    expect(first.calls.translate).toHaveLength(2);
    const second = serviceWith({}, "it", sqliteTranslationStore(db));
    const result = await second.service.translateText(ENGLISH);
    expect(second.calls.translate).toEqual([]);
    expect(result.sentences).toHaveLength(2);
  });
});
