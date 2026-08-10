import { describe, test, expect } from "bun:test";
import { parseTier, tierToAvailableModel, pickTaskPlan, floorTier, parseEffort, floorEffort } from "./task-model-picker";

// La lista come la annuncia davvero la CLI: due generazioni per famiglia, e
// accanto a ognuna la sua variante a finestra lunga. Il tier deve scegliere la
// generazione PIÙ RECENTE, e — dove l'host serve il milione — nella sua forma
// lunga: un agente dispatchato legge file veri, e 200k se li mangia a metà task.
const ALL = [
  "claude-opus-5", "claude-opus-5[1m]", "claude-opus-4-8", "claude-opus-4-8[1m]",
  "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]",
  "claude-haiku-4-5", "claude-fable-5",
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
    expect(tierToAvailableModel("opus", ALL)).toBe("claude-opus-5[1m]");
    expect(tierToAvailableModel("sonnet", ALL)).toBe("claude-sonnet-5[1m]");
  });

  test("la finestra da 1M dove l'host la annuncia, l'id nudo dove no", () => {
    expect(tierToAvailableModel("opus", ["claude-opus-5[1m]", "claude-opus-5"])).toBe("claude-opus-5[1m]");
    // Nessun `[1m]` in lista per quella famiglia = nessuna prova che l'host lo
    // regga: appenderlo alla cieca è il 400 di `claude-haiku-4-5[1m]`.
    expect(tierToAvailableModel("opus", ["claude-opus-5"])).toBe("claude-opus-5");
    // Fable il milione ce l'ha già nudo.
    expect(tierToAvailableModel("fable", ALL)).toBe("claude-fable-5");
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

describe("pickTaskPlan", () => {
  const base = { availableModels: ALL, fallback: "claude-sonnet-5" };
  const model = async (answer: string, over: Record<string, unknown> = {}) =>
    (await pickTaskPlan({ text: "x" }, { ...base, complete: async () => answer, ...over })).model;

  test("maps the classifier's tier to a concrete model", async () => {
    const p = await pickTaskPlan(
      { text: "refactor del layout engine" },
      { ...base, complete: async () => "opus high" },
    );
    expect(p.model).toBe("claude-opus-5[1m]");
    expect(p.effort).toBe("high");
  });

  test("unparsable answer → fallback", async () => {
    expect(await model("boh non so")).toBe("claude-sonnet-5");
  });

  test("classifier throwing → fallback (never blocks dispatch)", async () => {
    expect(await model("", { complete: async () => { throw new Error("provider down"); } })).toBe("claude-sonnet-5");
  });

  test("tier valid but not available on host → fallback", async () => {
    expect(await model("fable", { availableModels: ["gpt-4o"] })).toBe("claude-sonnet-5");
  });

  test("feeds title + description into the prompt", async () => {
    let seen = "";
    await pickTaskPlan(
      { text: "Titolone", description: "Descrizione dettagliata" },
      { ...base, complete: async (p) => { seen = p; return "sonnet medium"; } },
    );
    expect(seen).toContain("Titolone");
    expect(seen).toContain("Descrizione dettagliata");
  });

  test("execution floor: a haiku pick is clamped UP to sonnet (haiku is judge-only)", async () => {
    expect(await model("haiku medium")).toBe("claude-sonnet-5[1m]");
  });

  test("execution floor: haiku pick on a host without sonnet resolves to opus, NEVER haiku", async () => {
    const p = await pickTaskPlan(
      { text: "typo" },
      { availableModels: ["claude-haiku-4-5", "claude-opus-5"], fallback: "claude-opus-5", complete: async () => "haiku medium" },
    );
    expect(p.model).toBe("claude-opus-5");
  });

  // ── L'effort ──────────────────────────────────────────────────────────────

  test("un effort sotto il pavimento sale a medium, non scende", async () => {
    // `low` non e' un target: il pavimento e' cio' che la board fa oggi, cosi'
    // accendere l'auto non puo' peggiorare nessun task in silenzio.
    const p = await pickTaskPlan({ text: "typo" }, { ...base, complete: async () => "sonnet low" });
    expect(p.effort).toBe("medium");
  });

  test("effort illeggibile → null, cioè «decide la board» e non un medium inventato", async () => {
    const p = await pickTaskPlan({ text: "x" }, { ...base, complete: async () => "opus" });
    expect(p.model).toBe("claude-opus-5[1m]");
    expect(p.effort).toBeNull();
  });

  test("un fallback di modello non porta con sé un effort", async () => {
    // Se il giudice non si capisce, non si capisce nemmeno il suo sforzo:
    // spacciarne uno sarebbe inventare una decisione che nessuno ha preso.
    const p = await pickTaskPlan({ text: "x" }, { ...base, complete: async () => "boh" });
    expect(p.effort).toBeNull();
  });

  test("xhigh non viene letto come high (il prefisso non deve vincere)", async () => {
    const p = await pickTaskPlan({ text: "x" }, { ...base, complete: async () => "fable xhigh" });
    expect(p.effort).toBe("xhigh");
  });
});

describe("parseEffort / floorEffort", () => {
  test("legge il tier anche in una risposta prolissa, e vince il PRIMO", () => {
    expect(parseEffort("high")).toBe("high");
    expect(parseEffort("direi max, non xhigh")).toBe("max");
    expect(parseEffort("nessuna parola utile")).toBeNull();
  });

  test("il pavimento alza low e lascia stare il resto", () => {
    expect(floorEffort("low")).toBe("medium");
    expect(floorEffort("medium")).toBe("medium");
    expect(floorEffort("max")).toBe("max");
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
