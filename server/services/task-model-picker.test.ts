import { describe, test, expect } from "bun:test";
import { parseTier, tierToAvailableModel, pickTaskModel } from "./task-model-picker";

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
      { ...base, complete: async (p) => { seen = p; return "sonnet"; } },
    );
    expect(seen).toContain("Titolone");
    expect(seen).toContain("Descrizione dettagliata");
  });
});
