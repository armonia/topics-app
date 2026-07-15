import { describe, test, expect } from "bun:test";
import { parseTier, parseFuzzy, tierToAvailableModel, pickTaskModel, pickTaskModelDetailed } from "./task-model-picker";

const ALL = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8", "claude-fable-5"];

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
});

describe("tierToAvailableModel", () => {
  test("exact match", () => {
    expect(tierToAvailableModel("opus", ALL)).toBe("claude-opus-4-8");
  });
  test("degrades DOWN to the nearest available (cheaper) tier first", () => {
    // fable missing → opus (nearest lower)
    expect(tierToAvailableModel("fable", ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"]))
      .toBe("claude-opus-4-8");
  });
  test("falls UP when no lower tier is available", () => {
    // haiku missing, only sonnet+ → sonnet (nearest higher)
    expect(tierToAvailableModel("haiku", ["claude-sonnet-5", "claude-opus-4-8"]))
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
    expect(m).toBe("claude-opus-4-8");
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
      { ...base, complete: async (p) => { seen = p; return "sonnet ok"; } },
    );
    expect(seen).toContain("Titolone");
    expect(seen).toContain("Descrizione dettagliata");
  });
});

describe("parseFuzzy", () => {
  test("detects the fuzzy token in the two-word answer", () => {
    expect(parseFuzzy("sonnet fuzzy")).toBe(true);
    expect(parseFuzzy("FUZZY")).toBe(true);
    expect(parseFuzzy("opus, fuzzy.")).toBe(true);
  });
  test("ok / absent → not fuzzy", () => {
    expect(parseFuzzy("sonnet ok")).toBe(false);
    expect(parseFuzzy("haiku")).toBe(false);
    expect(parseFuzzy("")).toBe(false);
  });
});

describe("pickTaskModelDetailed", () => {
  const ALL = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8", "claude-fable-5"];
  const base = { availableModels: ALL, fallback: "claude-sonnet-5" };

  test("returns both the model and the fuzzy flag", async () => {
    const r = await pickTaskModelDetailed({ text: "sistema la roba" }, { ...base, complete: async () => "opus fuzzy" });
    expect(r).toEqual({ model: "claude-opus-4-8", fuzzy: true });
  });

  test("ok answer → fuzzy false", async () => {
    const r = await pickTaskModelDetailed({ text: "add endpoint" }, { ...base, complete: async () => "sonnet ok" });
    expect(r).toEqual({ model: "claude-sonnet-5", fuzzy: false });
  });

  test("classifier throwing → fallback, never fuzzy (must not force plan-first on a hiccup)", async () => {
    const r = await pickTaskModelDetailed({ text: "x" }, { ...base, complete: async () => { throw new Error("down"); } });
    expect(r).toEqual({ model: "claude-sonnet-5", fuzzy: false });
  });

  test("unparsable tier still surfaces the fuzzy flag with the fallback model", async () => {
    const r = await pickTaskModelDetailed({ text: "x" }, { ...base, complete: async () => "boh fuzzy" });
    expect(r).toEqual({ model: "claude-sonnet-5", fuzzy: true });
  });
});
