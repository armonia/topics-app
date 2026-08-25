/**
 * @covers CHAT-DEF-03
 *
 * The model list in the picker is current.
 */
import { describe, expect, test } from "bun:test";
import { contextWindowFor } from "../../shared/context-window";
import {
  defaultChatModel,
  FALLBACK_MODELS,
  familyOf,
  longVariantOf,
  newestOfFamily,
  scanCliForModelIds,
  selectCurrentModels,
} from "./claude-models";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Ids as they really occur in CLI 2.1.220, noise included. */
const REAL_SCAN = [
  "claude-opus-5",
  "claude-opus-5[1m]",
  "claude-opus-4-8",
  "claude-opus-4-8[1m]",
  "claude-opus-4-7",
  "claude-opus-4-7[1m]",
  "claude-opus-4-6",
  "claude-opus-4-6[1m]",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-opus-4",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6[1m]",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-haiku-4-5",
  "claude-haiku-4",
  "claude-fable-5",
];

describe("selectCurrentModels", () => {
  test("the 1M variant is offered — the whole point of scanning the CLI", () => {
    const models = selectCurrentModels(REAL_SCAN);
    expect(models).toContain("claude-opus-5[1m]");
    // Base id leads its long-window twin.
    expect(models.indexOf("claude-opus-5")).toBeLessThan(models.indexOf("claude-opus-5[1m]"));
  });

  test("bare-major aliases drop when a minor of the same major exists", () => {
    const models = selectCurrentModels(REAL_SCAN);
    expect(models).not.toContain("claude-opus-4");
    expect(models).not.toContain("claude-haiku-4");
    // …but a major with no minor at all is a real model, not an alias.
    expect(models).toContain("claude-opus-5");
    expect(models).toContain("claude-sonnet-5");
  });

  test("keeps two generations per family, newest first", () => {
    const models = selectCurrentModels(REAL_SCAN);
    expect(models).toEqual([
      "claude-opus-5",
      "claude-opus-5[1m]",
      "claude-opus-4-8",
      "claude-opus-4-8[1m]",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-6[1m]",
      "claude-haiku-4-5",
      "claude-fable-5",
    ]);
  });

  test("families come out strongest-first regardless of input order", () => {
    const shuffled = [...REAL_SCAN].reverse();
    expect(selectCurrentModels(shuffled)).toEqual(selectCurrentModels(REAL_SCAN));
  });

  test("non-model strings and dated aliases are ignored", () => {
    expect(selectCurrentModels([
      "claude-opus-4-20250514",
      "claude-fable-5.md",
      "claude-fable-5-mythos-5",
      "gpt-5",
      "",
    ])).toEqual([]);
  });

  test("empty input yields empty — the caller decides the fallback", () => {
    expect(selectCurrentModels([])).toEqual([]);
  });
});

describe("scanCliForModelIds", () => {
  test("pulls ids out of a binary-ish blob and rejects the near-misses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "topics-models-"));
    const file = join(dir, "fake-cli");
    // NUL padding + adjacent junk: what the real binary looks like around a
    // string literal.
    writeFileSync(file, [
      "\0\0claude-opus-5\0",
      "x\0claude-opus-5[1m]\0",
      "\0claude-opus-4-20250514\0",
      "\0skills/claude-fable-5.md\0",
      "\0claude-haiku-4-5\0",
    ].join(""));

    const ids = await scanCliForModelIds(file);
    expect(ids.sort()).toEqual(["claude-haiku-4-5", "claude-opus-5", "claude-opus-5[1m]"]);
  });

  test("an id split across the 4MB chunk boundary is not lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "topics-models-"));
    const file = join(dir, "big-cli");
    const chunk = 4 * 1024 * 1024;
    // Land "claude-opus-5[1m]" so it straddles the first chunk boundary.
    const id = "claude-opus-5[1m]";
    const pad = "\0".repeat(chunk - 8);
    writeFileSync(file, pad + id + "\0".repeat(1024));

    expect(await scanCliForModelIds(file)).toContain(id);
  });

  test("a missing binary scans to nothing instead of throwing", async () => {
    expect(await scanCliForModelIds("/nope/not/a/cli")).toEqual([]);
  });
});

describe("FALLBACK_MODELS", () => {
  test("survives its own filter — a fallback the picker would reject is no fallback", () => {
    expect(selectCurrentModels(FALLBACK_MODELS).sort()).toEqual([...FALLBACK_MODELS].sort());
  });

  test("offers the 1M window, which is what the hand-typed list never did", () => {
    expect(FALLBACK_MODELS).toContain("claude-opus-5[1m]");
  });
});

describe("defaultChatModel", () => {
  test("un pin vuoto vale la FINESTRA LUNGA, non un id nudo da 200k", () => {
    // È la risposta a «su cosa gira una chat senza modello scelto», e non la usa
    // solo lo spawn: chiunque debba dimensionare il ring del contesto di una
    // chat senza pin deve arrivare qui. Se questo id perde il suffisso, il
    // denominatore torna a 200k su una sessione da un milione — il 288% del
    // 10 agosto 2026.
    expect(contextWindowFor(defaultChatModel())).toEqual({ tokens: 1_000_000, known: true });
    expect(familyOf(defaultChatModel())).toBe("opus");
  });
});

describe("newestOfFamily", () => {
  const LIVE = [
    "claude-opus-5", "claude-opus-5[1m]", "claude-opus-4-8", "claude-opus-4-8[1m]",
    "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5",
  ];

  test("la generazione più recente, non l'ordine della lista", () => {
    expect(newestOfFamily("opus", LIVE)).toBe("claude-opus-5");
    expect(newestOfFamily("sonnet", LIVE)).toBe("claude-sonnet-5");
    expect(newestOfFamily("opus", [...LIVE].reverse())).toBe("claude-opus-5");
    // 4.10 viene DOPO 4.8: confrontare da stringhe direbbe il contrario.
    expect(newestOfFamily("opus", ["claude-opus-4-10", "claude-opus-4-8"])).toBe("claude-opus-4-10");
  });

  test("l'id nudo batte la sua variante [1m], che è una modalità", () => {
    expect(newestOfFamily("opus", ["claude-opus-5[1m]", "claude-opus-5"])).toBe("claude-opus-5");
    expect(newestOfFamily("opus", ["claude-opus-5[1m]"])).toBe("claude-opus-5[1m]");
  });

  test("preferLong: la finestra da 1M dove l'host la serve, l'id nudo dove no", () => {
    expect(newestOfFamily("opus", LIVE, { preferLong: true })).toBe("claude-opus-5[1m]");
    // Sonnet 5 non ha un gemello `[1m]` nella tabella del binario, ma la FAMIGLIA
    // sì (`claude-sonnet-4-6[1m]`) — e `claude-sonnet-5[1m]` risponde davvero.
    expect(newestOfFamily("sonnet", [...LIVE, "claude-sonnet-4-6[1m]"], { preferLong: true }))
      .toBe("claude-sonnet-5[1m]");
    // Haiku: il beta non lo copre (400 «long context beta is not yet available»).
    expect(newestOfFamily("haiku", LIVE, { preferLong: true })).toBe("claude-haiku-4-5");
    // Fable il milione ce l'ha già nudo: niente suffisso da inventare.
    expect(newestOfFamily("fable", LIVE, { preferLong: true })).toBe("claude-fable-5");
  });

  test("famiglia assente o lista di altri provider → null, mai un id inventato", () => {
    expect(newestOfFamily("mythos", LIVE)).toBeNull();
    expect(newestOfFamily("opus", ["gpt-5-codex", "gemini-2.5-pro"])).toBeNull();
    expect(newestOfFamily("opus", [])).toBeNull();
  });

  test("familyOf riconosce la famiglia e tace sul resto", () => {
    expect(familyOf("claude-opus-5[1m]")).toBe("opus");
    expect(familyOf("claude-haiku-4-5")).toBe("haiku");
    expect(familyOf("gpt-4o")).toBeNull();
  });
});

describe("longVariantOf", () => {
  const LIVE = [
    "claude-opus-5", "claude-opus-5[1m]", "claude-sonnet-5", "claude-sonnet-4-6",
    "claude-sonnet-4-6[1m]", "claude-haiku-4-5", "claude-fable-5",
  ];

  test("la famiglia che annuncia un [1m] lo prende anche sulla versione più nuova", () => {
    expect(longVariantOf("claude-opus-5", LIVE)).toBe("claude-opus-5[1m]");
    expect(longVariantOf("claude-sonnet-5", LIVE)).toBe("claude-sonnet-5[1m]");
  });

  test("la famiglia che non lo annuncia resta nuda: il suffisso sarebbe un 400", () => {
    expect(longVariantOf("claude-haiku-4-5", LIVE)).toBe("claude-haiku-4-5");
    expect(longVariantOf("claude-fable-5", LIVE)).toBe("claude-fable-5");
  });

  test("id già lungo, id di altri provider e stringhe non-modello passano intatti", () => {
    expect(longVariantOf("claude-opus-5[1m]", LIVE)).toBe("claude-opus-5[1m]");
    expect(longVariantOf("gpt-5-codex", LIVE)).toBe("gpt-5-codex");
    expect(longVariantOf("", LIVE)).toBe("");
  });

  test("lista vuota: nessuna prova che l'host regga il milione → id nudo", () => {
    expect(longVariantOf("claude-opus-5", [])).toBe("claude-opus-5");
  });
});
