/**
 * @covers KANBAN-24
 */
import { describe, test, expect } from "bun:test";
import {
  parseTier, tierToAvailableModel, pickTaskPlan, floorTier, parseEffort, floorEffort, medianTier, medianEffort, JUDGE_VOTES, parseWeight, medianWeight,
} from './task-model-picker';

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
      { ...base, complete: async (p) => { seen = p; return "sonnet medium light"; } },
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

describe("il task arriva al giudice come MATERIALE, non come richiesta", () => {
  const promptFor = async (task: { text: string; description?: string }) => {
    let seen = "";
    await pickTaskPlan(task, {
      complete: async (p) => { seen = p; return "opus high light"; },
      availableModels: ALL, fallback: "claude-opus-5",
    });
    return seen;
  };

  test("il testo del task sta fra marcatori", async () => {
    // Senza, una descrizione lunga in markdown si confonde con la richiesta e il
    // giudice risponde «Manca il task. Che devo fare?» invece di classificare.
    const p = await promptFor({ text: "T", description: "## Cosa\nfai questo" });
    expect(p).toContain("<<<TASK");
    expect(p).toContain("TASK>>>");
    expect(p.indexOf("<<<TASK")).toBeLessThan(p.indexOf("Titolo: T"));
    expect(p.indexOf("TASK>>>")).toBeGreaterThan(p.indexOf("Titolo: T"));
  });

  test("una descrizione lunga viene tagliata a riga e il taglio è DICHIARATO", async () => {
    // Misurato: tagliando secco a metà frase, il giudice rispondeva «il messaggio
    // sembra troncato» e non classificava — 2 volte su 3 sulla card più
    // impegnativa della board, che finiva così a effort minimo in silenzio.
    const lunga = Array.from({ length: 200 }, (_, i) => `riga ${i} con un po' di testo`).join("\n");
    const p = await promptFor({ text: "T", description: lunga });
    expect(p).toContain("[… estratto: il task continua]");
    // Taglio su confine di riga: nessuna riga spezzata a metà prima del marcatore.
    const corpo = p.slice(p.indexOf("Descrizione:"), p.indexOf("[… estratto"));
    expect(corpo.trimEnd().endsWith("testo")).toBe(true);
  });

  test("una descrizione corta non viene toccata", async () => {
    const p = await promptFor({ text: "T", description: "breve" });
    expect(p).toContain("Descrizione: breve");
    expect(p).not.toContain("[… estratto");
  });
});

describe("parseEffort / floorEffort", () => {
  const base = { availableModels: ALL, fallback: "claude-sonnet-5" };
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

  // ── Il peso ───────────────────────────────────────────────────────────────

  test("la seconda parola è il peso, e arriva nel piano", async () => {
    const p = await pickTaskPlan({ text: "ricompila tutto" }, { ...base, complete: async () => "opus medium heavy" });
    expect(p.model).toBe("claude-opus-5[1m]");
    expect(p.weight).toBe("heavy");
  });

  test("peso non letto → null, che ogni gate tratta come light", async () => {
    // È il caso di ogni risposta a UNA parola, cioè come rispondeva il giudice
    // prima che il peso esistesse: niente deve cambiare rispetto a prima.
    const p = await pickTaskPlan({ text: "x" }, { ...base, complete: async () => "opus" });
    expect(p.model).toBe("claude-opus-5[1m]");
    expect(p.weight).toBeNull();
  });

  test("un fallback di modello non porta con sé un peso: un giudice caduto non ferma la coda", async () => {
    const p = await pickTaskPlan({ text: "x" }, { ...base, complete: async () => "boh" });
    expect(p.weight).toBeNull();
    const crashed = await pickTaskPlan({ text: "x" }, {
      ...base, complete: async () => { throw new Error("provider down"); },
    });
    expect(crashed.weight).toBeNull();
  });

  test("il peso si legge DOPO il modello, e sopravvive a una risposta prolissa", async () => {
    const p = await pickTaskPlan({ text: "x" }, {
      ...base, complete: async () => "opus — heavy, ricompila tutto il progetto",
    });
    expect(p.weight).toBe("heavy");
  });

  test("il prompt chiede TRE parole e spiega che il peso non è la difficoltà", async () => {
    let seen = "";
    await pickTaskPlan({ text: "T" }, { ...base, complete: async (p) => { seen = p; return "opus medium light"; } });
    expect(seen).toContain("TRE parole");
    expect(seen).toContain("MORDE LA MACCHINA");
    expect(seen).toContain("Nel dubbio light");
  });
});

describe("parseWeight", () => {
  test("legge il peso anche in una risposta prolissa, e vince il PRIMO", () => {
    expect(parseWeight("heavy")).toBe("heavy");
    expect(parseWeight("direi light, non heavy")).toBe("light");
    expect(parseWeight("nessuna parola utile")).toBeNull();
  });

  test("nessuna parola di peso dentro un'altra parola", () => {
    // «lightweight» o «heavyweight» sono parole intere diverse: senza i confini
    // il gate scatterebbe su una risposta che non ha detto quello.
    expect(parseWeight("lightweight")).toBeNull();
    expect(parseWeight("heavyweight")).toBeNull();
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

describe("mediana dei voti", () => {
  test("con una maggioranza, la mediana È la maggioranza", () => {
    expect(medianEffort(["high", "medium", "medium"])).toBe("medium");
    expect(medianEffort(["medium", "high", "high"])).toBe("high");
    expect(medianTier(["sonnet", "opus", "opus"])).toBe("opus");
  });

  test("senza maggioranza vince quello di mezzo, mai un estremo", () => {
    // Il caso in cui un «più frequente» dovrebbe inventarsi uno spareggio.
    expect(medianEffort(["medium", "xhigh", "high"])).toBe("high");
    expect(medianTier(["fable", "sonnet", "opus"])).toBe("opus");
  });

  test("l'ordine di arrivo dei voti non conta", () => {
    expect(medianEffort(["high", "medium", "medium"])).toBe(medianEffort(["medium", "medium", "high"]));
    expect(medianEffort(["medium", "xhigh", "high"])).toBe(medianEffort(["xhigh", "high", "medium"]));
  });

  test("su un numero pari si paga il meno caro dei due centrali", () => {
    expect(medianEffort(["medium", "xhigh"])).toBe("medium");
  });

  test("nessun voto → null, cioè «non lo so» (mai un medium inventato)", () => {
    expect(medianEffort([])).toBeNull();
    expect(medianTier([])).toBeNull();
  });
});

/**
 * Il rimedio alla misura del 2026-08-10: il giudice one-shot, chiamato 20 volte
 * sullo stesso identico testo, cambiava sforzo nel 33,7% delle coppie e piano
 * (modello+sforzo) nel 54,2% — cioè lo stesso task poteva costare parecchio di
 * più per un lancio di dado. Referti: `docs/effort-variance/`.
 *
 * Questi test diventano rossi se qualcuno rimette il voto singolo: con una sola
 * chiamata vincerebbe la PRIMA risposta, e la minoranza qui è messa apposta per
 * prima.
 */
describe("il giudice si vota, non si crede sulla parola", () => {
  const ALL_MODELS = { availableModels: ALL, fallback: "claude-sonnet-5" };
  /** Un giudice che risponde le cose scritte, una per chiamata, in quest'ordine. */
  const scripted = (answers: string[]) => {
    let i = 0;
    return async () => answers[Math.min(i++, answers.length - 1)]!;
  };

  test("interroga il giudice JUDGE_VOTES volte, non una", async () => {
    let calls = 0;
    await pickTaskPlan({ text: "x" }, { ...ALL_MODELS, complete: async () => { calls++; return "opus high light"; } });
    expect(calls).toBe(JUDGE_VOTES);
  });

  test("la minoranza perde anche se parla per prima", async () => {
    const p = await pickTaskPlan(
      { text: "x" },
      { ...ALL_MODELS, complete: scripted(["opus xhigh", "opus medium", "opus medium"]) },
    );
    expect(p.effort).toBe("medium");
    expect(p.model).toBe("claude-opus-5[1m]");
  });

  test("il voto vale anche sul modello, non solo sullo sforzo", async () => {
    const p = await pickTaskPlan(
      { text: "x" },
      { ...ALL_MODELS, complete: scripted(["fable high", "opus high", "opus high"]) },
    );
    expect(p.model).toBe("claude-opus-5[1m]");
  });

  test("tre voti tutti diversi → quello di mezzo, non il primo né il più caro", async () => {
    const p = await pickTaskPlan(
      { text: "x" },
      { ...ALL_MODELS, complete: scripted(["opus max", "opus medium", "opus high"]) },
    );
    expect(p.effort).toBe("high");
  });

  test("un voto che esplode non porta giù la decisione: decidono gli altri", async () => {
    let i = 0;
    const p = await pickTaskPlan({ text: "x" }, {
      ...ALL_MODELS,
      complete: async () => {
        if (i++ === 0) throw new Error("provider down");
        return "opus high light";
      },
    });
    expect(p.model).toBe("claude-opus-5[1m]");
    expect(p.effort).toBe("high");
  });

  test("un voto illeggibile non conta come astensione: decidono i leggibili", async () => {
    const p = await pickTaskPlan(
      { text: "x" },
      { ...ALL_MODELS, complete: scripted(["boh non so", "opus xhigh", "opus xhigh"]) },
    );
    expect(p.effort).toBe("xhigh");
  });

  test("nessun voto leggibile → fallback, e nessuno sforzo inventato", async () => {
    const p = await pickTaskPlan(
      { text: "x" },
      { ...ALL_MODELS, complete: scripted(["boh", "mah", "???"]) },
    );
    expect(p.model).toBe("claude-sonnet-5");
    expect(p.effort).toBeNull();
  });

  test("i voti partono INSIEME: tre giudici in serie triplicherebbero l'attesa del dispatch", async () => {
    // Nessun voto può rispondere finché non sono arrivati tutti: in serie il
    // primo aspetterebbe per sempre e il test scadrebbe.
    let arrived = 0;
    let openTheGate: () => void = () => {};
    const gate = new Promise<void>((r) => { openTheGate = r; });
    const p = await pickTaskPlan({ text: "x" }, {
      ...ALL_MODELS,
      complete: async () => {
        if (++arrived === JUDGE_VOTES) openTheGate();
        await gate;
        return "opus high light";
      },
    });
    expect(p.effort).toBe("high");
  });
});
