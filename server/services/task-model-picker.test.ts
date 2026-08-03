import { describe, test, expect } from "bun:test";
import { parseTier, tierToAvailableModel, pickTaskModel, floorTier } from "./task-model-picker";

// La lista come la annuncia davvero la CLI: due generazioni per famiglia, e
// accanto a ognuna la sua variante a finestra lunga. Il tier deve scegliere la
// PIÙ RECENTE, e nella sua forma nuda.
const ALL = [
  "claude-opus-5", "claude-opus-5[1m]", "claude-opus-4-8", "claude-opus-4-8[1m]",
  "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5",
];

describe("parseTier", () => {
  test("clean single-word answers", () => {
    expect(parseTier("haiku")).toBe("haiku");
    expect(parseTier("opus")).toBe("opus");
    expect(parseTier("FABLE")).toBe("fable");
  });
  test("tolerates stray words/punctuation", () => {
    expect(parseTier("Modello: sonnet.")).toBe("sonnet");
    expect(parseTier("direi opus, è complesso")).toBe("opus");
  });
  test("null on no match", () => {
    expect(parseTier("gpt-4")).toBeNull();
    expect(parseTier("")).toBeNull();
    // substring of a bigger word must NOT match (word-boundary).
    expect(parseTier("sonnets")).toBeNull();
  });
  test("the leading tier word wins outright, trailing words ignored", () => {
    expect(parseTier("opus")).toBe("opus");
    expect(parseTier("  fable\n")).toBe("fable");
    // A stray trailing word (an older two-word habit of the judge) still parses.
    expect(parseTier("opus ok")).toBe("opus");
  });
  test("earliest tier wins in verbose answers — never MODEL_TIERS scan order", () => {
    // Old bug: 'haiku' won whenever it appeared ANYWHERE in the text.
    expect(parseTier("opus — non è un task da haiku")).toBe("opus");
    expect(parseTier("sonnet (non serve opus né haiku)")).toBe("sonnet");
    // Error string carrying a model id must not route to haiku silently as a
    // "valid" pick of a REAL task… it parses as haiku only if haiku is first.
    expect(parseTier("opus — fallback da claude-haiku-4-5")).toBe("opus");
  });
});

describe("tierToAvailableModel", () => {
  test("il tier prende la generazione PIÙ RECENTE della famiglia", () => {
    // Qui c'era `claude-opus-4-8` scritto a mano: la CLI offriva già Opus 5 e
    // ogni agente dispatchato è partito una generazione indietro, in silenzio.
    expect(tierToAvailableModel("opus", ALL)).toBe("claude-opus-5");
    expect(tierToAvailableModel("sonnet", ALL)).toBe("claude-sonnet-5");
  });

  test("fra un id e la sua variante [1m] vince quello NUDO", () => {
    // `[1m]` è una modalità di servizio (finestra + spesa), non un gradino di
    // capacità: la finestra lunga si sceglie, non capita per caso.
    expect(tierToAvailableModel("opus", ["claude-opus-5[1m]", "claude-opus-5"])).toBe("claude-opus-5");
    // …ma se di quella versione esiste solo la variante lunga, si prende quella.
    expect(tierToAvailableModel("opus", ["claude-opus-5[1m]"])).toBe("claude-opus-5[1m]");
  });
  test("degrades DOWN to the nearest available (cheaper) tier first", () => {
    // fable missing → opus (nearest lower)
    expect(tierToAvailableModel("fable", ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"]))
      .toBe("claude-opus-5");
  });
  test("falls UP when no lower tier is available", () => {
    // haiku missing, only sonnet+ → sonnet (nearest higher)
    expect(tierToAvailableModel("haiku", ["claude-sonnet-5", "claude-opus-5"]))
      .toBe("claude-sonnet-5");
  });
  test("null when nothing maps", () => {
    expect(tierToAvailableModel("opus", ["gpt-4o"])).toBeNull();
    expect(tierToAvailableModel("opus", [])).toBeNull();
  });
});

describe("pickTaskModel", () => {
  const base = { availableModels: ALL, fallback: "claude-sonnet-5" };

  test("maps the classifier's tier to a concrete model", async () => {
    const m = await pickTaskModel(
      { text: "refactor del layout engine" },
      { ...base, complete: async () => "opus" },
    );
    expect(m).toBe("claude-opus-5");
  });

  test("unparsable answer → fallback", async () => {
    const m = await pickTaskModel({ text: "x" }, { ...base, complete: async () => "boh non so" });
    expect(m).toBe("claude-sonnet-5");
  });

  test("classifier throwing → fallback (never blocks dispatch)", async () => {
    const m = await pickTaskModel({ text: "x" }, {
      ...base,
      complete: async () => { throw new Error("provider down"); },
    });
    expect(m).toBe("claude-sonnet-5");
  });

  test("tier valid but not available on host → fallback", async () => {
    const m = await pickTaskModel({ text: "x" }, {
      complete: async () => "fable",
      availableModels: ["gpt-4o"], // no claude tier at all
      fallback: "claude-sonnet-5",
    });
    expect(m).toBe("claude-sonnet-5");
  });

  test("feeds title + description into the prompt", async () => {
    let seen = "";
    await pickTaskModel(
      { text: "Titolone", description: "Descrizione dettagliata" },
      { ...base, complete: async (p) => { seen = p; return "sonnet"; } },
    );
    expect(seen).toContain("Titolone");
    expect(seen).toContain("Descrizione dettagliata");
  });

  test("execution floor: a haiku pick is clamped UP to sonnet (haiku is judge-only)", async () => {
    const m = await pickTaskModel({ text: "bump versione" }, { ...base, complete: async () => "haiku" });
    expect(m).toBe("claude-sonnet-5");
  });

  test("execution floor: haiku pick on a host without sonnet resolves to opus, NEVER haiku", async () => {
    const m = await pickTaskModel(
      { text: "typo" },
      { availableModels: ["claude-haiku-4-5", "claude-opus-5"], fallback: "claude-opus-5", complete: async () => "haiku" },
    );
    expect(m).toBe("claude-opus-5");
  });
});

describe("floorTier", () => {
  test("haiku clamps to sonnet; sonnet/opus/fable unchanged", () => {
    expect(floorTier("haiku")).toBe("sonnet");
    expect(floorTier("sonnet")).toBe("sonnet");
    expect(floorTier("opus")).toBe("opus");
    expect(floorTier("fable")).toBe("fable");
  });
});
