/**
 * Il denominatore del ring. Le proprietà che contano:
 *  • un nome di modello vero (con data e suffissi) trova la sua finestra;
 *  • un modello sconosciuto non mente: cade sul default e lo dichiara;
 *  • le soglie sono UNA sola scala, condivisa fra colore e preavviso.
 *
 * @covers USAGE-07, USAGE-08, USAGE-09
 */
import { describe, it, expect } from "bun:test";
import { hasLongWindowMarker } from "../../shared/context-window";
import { defaultChatModel } from "../providers/claude-models";
import {
  contextWindowFor,
  windowCoveringMeasure,
  windowModelFor,
  windowForMeasure,
  classifyContext,
  contextLevel,
  DEFAULT_CONTEXT_WINDOW,
  CONTEXT_WARN_PERCENT,
  CONTEXT_CRITICAL_PERCENT,
} from "./context-window";

describe("contextWindowFor", () => {
  it("riconosce i nomi pieni che arrivano dal provider, data compresa", () => {
    expect(contextWindowFor("claude-sonnet-4-5-20250929")).toEqual({ tokens: 200_000, known: true });
    expect(contextWindowFor("claude-opus-4-6")).toEqual({ tokens: 200_000, known: true });
    expect(contextWindowFor("gpt-4o-mini")).toEqual({ tokens: 128_000, known: true });
  });

  it("un id Claude NUDO è da 200k, anche sulla generazione 5", () => {
    // Il milione si chiede: la CLI lo serve con l'header beta
    // `context-1m-2025-08-07` e lo espone come id separato. Misurato il
    // 2026-08-03 sulla CLI 2.1.220 mandando lo stesso prompt da ~250k token a
    // ognuno: questi tre rispondono «Prompt is too long», le loro varianti
    // `[1m]` rispondono e basta. Scriverli a 1M metteva l'anello del contesto
    // al 20% su un turno pieno, cioè zero preavviso prima della compattazione.
    expect(contextWindowFor("claude-opus-5")).toEqual({ tokens: 200_000, known: true });
    expect(contextWindowFor("claude-opus-4-8")).toEqual({ tokens: 200_000, known: true });
    expect(contextWindowFor("claude-sonnet-5")).toEqual({ tokens: 200_000, known: true });
    expect(contextWindowFor("claude-opus-5[1m]")).toEqual({ tokens: 1_000_000, known: true });
    // Fable è l'eccezione: un milione di serie, nessuna variante da chiedere.
    expect(contextWindowFor("claude-fable-5")).toEqual({ tokens: 1_000_000, known: true });
  });

  it("gli alias corti del selettore cadono sulla famiglia", () => {
    expect(contextWindowFor("opus")).toEqual({ tokens: 200_000, known: true });
    expect(contextWindowFor("sonnet")).toEqual({ tokens: 200_000, known: true });
    expect(contextWindowFor("haiku")).toEqual({ tokens: 200_000, known: true });
    expect(contextWindowFor("fable")).toEqual({ tokens: 1_000_000, known: true });
  });

  it("la variante a finestra lunga vince sulla famiglia", () => {
    // Stesso modello, servito con la beta 1M: leggerlo come 200k farebbe
    // segnare "90%" a una sessione che sta al 18%.
    expect(contextWindowFor("claude-sonnet-4-5[1m]")).toEqual({ tokens: 1_000_000, known: true });
    expect(contextWindowFor("claude-sonnet-4-5-1m")).toEqual({ tokens: 1_000_000, known: true });
  });

  it("un modello sconosciuto usa il default e lo DICHIARA", () => {
    // `known: false` è il permesso della UI di scrivere "≈": una finestra
    // inventata con tre cifre di precisione è peggio di un'approssimazione
    // dichiarata.
    expect(contextWindowFor("qualcosa-di-nuovo-v9")).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW, known: false });
    expect(contextWindowFor(null)).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW, known: false });
    expect(contextWindowFor("")).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW, known: false });
  });

  it("le chiavi più lunghe vincono su quelle più corte", () => {
    // "gpt-4o-mini" non deve finire su "gpt-4o", né "gpt-5-codex" su "gpt-5".
    expect(contextWindowFor("gpt-4o-mini-2024-07-18").tokens).toBe(128_000);
    expect(contextWindowFor("gpt-5-codex").tokens).toBe(400_000);
  });
});

describe("contextLevel", () => {
  it("una sola scala per colore e preavviso", () => {
    expect(contextLevel(0)).toBe("ok");
    expect(contextLevel(CONTEXT_WARN_PERCENT - 1)).toBe("ok");
    expect(contextLevel(CONTEXT_WARN_PERCENT)).toBe("warn");
    expect(contextLevel(CONTEXT_CRITICAL_PERCENT - 1)).toBe("warn");
    expect(contextLevel(CONTEXT_CRITICAL_PERCENT)).toBe("critical");
    expect(contextLevel(100)).toBe("critical");
  });
});

describe("classifyContext", () => {
  it("calcola percentuale e livello dalla misura reale", () => {
    expect(classifyContext(150_000, { tokens: 200_000, known: true })).toEqual({
      used: 150_000, size: 200_000, percent: 75, level: "warn", reason: "window", estimated: false,
    });
  });

  it("satura a 100: oltre la finestra non esiste il 110%", () => {
    // Succede davvero al confine: la misura è di UNA chiamata e la finestra
    // viene da una tabella. Un ring al 110% disegnerebbe un arco impossibile.
    expect(classifyContext(260_000, { tokens: 200_000, known: true }).percent).toBe(100);
  });

  it("numeri assurdi non producono NaN nel ring", () => {
    expect(classifyContext(Number.NaN, { tokens: 200_000, known: true }).percent).toBe(0);
    expect(classifyContext(-5, { tokens: 200_000, known: true }).used).toBe(0);
    expect(classifyContext(1000, { tokens: 0, known: false }).size).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("propaga `estimated` dalla finestra", () => {
    expect(classifyContext(1000, contextWindowFor("modello-ignoto")).estimated).toBe(true);
    expect(classifyContext(1000, contextWindowFor("claude-opus-4-6")).estimated).toBe(false);
  });
});

/**
 * `[1m]` è una MODALITÀ di servizio, non un modello diverso: il picker manda
 * `claude-opus-5[1m]`, la CLI nei suoi eventi riporta `claude-opus-5` nudo. Chi
 * dimensionava la finestra guardava il secondo e leggeva 200k — l'anello diceva
 * "quasi pieno" a un sesto della capacità vera.
 */
describe("windowModelFor — il suffisso 1M sopravvive al nome nudo della CLI", () => {
  it("la richiesta a 1M vince quando a rispondere è lo stesso modello", () => {
    expect(windowModelFor("claude-opus-5", "claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
    expect(contextWindowFor(windowModelFor("claude-opus-5", "claude-opus-5[1m]")).tokens).toBe(1_000_000);
    // Anche col suffisso di data che la CLI a volte aggiunge.
    expect(contextWindowFor(windowModelFor("claude-opus-5-20260101", "claude-opus-5[1m]")).tokens).toBe(1_000_000);
  });

  it("un ripiego su un ALTRO modello porta la SUA finestra, non quella richiesta", () => {
    // Fast mode / sovraccarico: ha risposto sonnet, la finestra è la sua.
    expect(windowModelFor("claude-sonnet-5", "claude-opus-5[1m]")).toBe("claude-sonnet-5");
    expect(contextWindowFor(windowModelFor("claude-haiku-4-5", "claude-opus-5[1m]")).tokens).toBe(200_000);
  });

  it("senza 1M nella richiesta non inventa niente", () => {
    expect(contextWindowFor(windowModelFor("claude-opus-5", "claude-opus-5")).tokens).toBe(200_000);
    expect(windowModelFor(null, "claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
    expect(windowModelFor("claude-opus-5", null)).toBe("claude-opus-5");
    expect(windowModelFor(null, null)).toBeNull();
  });
});

/**
 * Il caso del 10 agosto 2026: `token-live --json` dava `contextPct` sopra 100 su
 * quattro chat su sette, fino a **576.211 / 200.000 = 288,1%**. Sessione lanciata
 * a `claude-opus-5[1m]`, transcript che riporta `claude-opus-5` nudo — e in mezzo
 * un `topics.model` VUOTO, che è il pezzo che mancava a `windowModelFor`.
 *
 * Tre modi di arrivare alla stessa finestra, in ordine di autorevolezza. Il terzo
 * non è un ripiego elegante: è la prova materiale, e da sola basta.
 */
describe("una sessione a 1M non può leggersi al 288%", () => {
  const NUDO = "claude-opus-5"; // quel che la CLI scrive nel transcript
  const MISURA = 576_211;       // quel che quella chiamata ha davvero letto

  it("col pin sul topic: il suffisso perso dalla CLI lo rimette la richiesta", () => {
    expect(contextWindowFor(windowModelFor(NUDO, "claude-opus-5[1m]")))
      .toEqual({ tokens: 1_000_000, known: true });
  });

  it("senza pin: il default di chat è a finestra lunga, e vale come richiesta", () => {
    // Un pin vuoto non vuol dire «senza modello»: vuol dire QUESTO. È lo stesso
    // id che `spawnPersistentProcess` passa alla CLI.
    expect(hasLongWindowMarker(defaultChatModel())).toBe(true);
    expect(contextWindowFor(windowModelFor(NUDO, defaultChatModel())))
      .toEqual({ tokens: 1_000_000, known: true });
  });

  it("e se anche la richiesta si perde, la misura è la prova: 576k non stanno in 200k", () => {
    // Nessun modello richiesto, resta il nome nudo → 200k, cioè il 288%. Ma
    // quella chiamata ha RICEVUTO RISPOSTA: su una finestra da 200k il provider
    // l'avrebbe rifiutata con «Prompt is too long».
    const senzaRichiesta = contextWindowFor(windowModelFor(NUDO, null));
    expect(senzaRichiesta.tokens).toBe(200_000);
    expect(windowCoveringMeasure(senzaRichiesta, NUDO, MISURA))
      .toEqual({ tokens: 1_000_000, known: true });
  });

  it("nessuna delle tre strade produce un rapporto sopra il 100%", () => {
    for (const requested of ["claude-opus-5[1m]", defaultChatModel(), null]) {
      const model = windowModelFor(NUDO, requested) ?? "";
      const win = windowCoveringMeasure(contextWindowFor(model), model, MISURA);
      expect(MISURA / win.tokens).toBeLessThanOrEqual(1);
    }
  });
});

describe("windowCoveringMeasure — il numeratore è una prova sul denominatore", () => {
  const w = (tokens: number, known = true) => ({ tokens, known });

  it("una misura che ci sta non tocca niente", () => {
    expect(windowCoveringMeasure(w(200_000), "claude-opus-5", 199_999)).toEqual(w(200_000));
    expect(windowCoveringMeasure(w(200_000), "claude-opus-5", 200_000)).toEqual(w(200_000));
    // Zero, NaN, misura assente: non è una prova di niente.
    expect(windowCoveringMeasure(w(200_000), "claude-opus-5", 0)).toEqual(w(200_000));
    expect(windowCoveringMeasure(w(200_000), "claude-opus-5", Number.NaN)).toEqual(w(200_000));
  });

  it("promuove alla finestra lunga solo le famiglie che il beta 1M serve", () => {
    expect(windowCoveringMeasure(w(200_000), "claude-sonnet-5", 300_000)).toEqual(w(1_000_000));
    // Haiku no: `claude-haiku-4-5[1m]` risponde 400. Se una sua misura sfonda i
    // 200k la nostra tabella è sbagliata in un modo che non sappiamo nominare —
    // e allora si dice, invece di inventare un milione.
    expect(windowCoveringMeasure(w(200_000), "claude-haiku-4-5", 300_000)).toEqual(w(300_000, false));
  });

  it("oltre il milione non nomina più niente: dichiara la stima", () => {
    expect(windowCoveringMeasure(w(200_000), "claude-opus-5", 1_400_000)).toEqual(w(1_400_000, false));
  });

  it("non promuove una finestra stimata a una certezza", () => {
    // Il punto di partenza era un'ipotesi (`known: false`): la misura dice che è
    // troppo bassa, non che adesso la conosciamo.
    expect(windowCoveringMeasure(w(200_000, false), "claude-opus-5", 400_000))
      .toEqual(w(1_000_000, false));
  });
});

describe("windowForMeasure — il denominatore si ricalcola, il numeratore no", () => {
  const measure = (
    over: Partial<{ model: string | null; windowTokens: number; estimated: boolean; usedTokens: number }> = {},
  ) => ({
    model: "claude-sonnet-5" as string | null,
    windowTokens: 200_000,
    estimated: false,
    usedTokens: 1_000,
    ...over,
  });

  it("corregge una misura registrata con la finestra sbagliata", () => {
    // Il caso vero: righe scritte quando la tabella dava un milione a Sonnet 5,
    // che invece sta a 200k. L'anello segnava 15% su una sessione al 76% — e
    // sbagliare da questa parte non si vede finché non arriva la compattazione.
    expect(windowForMeasure(measure({ windowTokens: 1_000_000 }), "claude-sonnet-5"))
      .toEqual({ tokens: 200_000, known: true });
  });

  it("segue il modello CORRENTE del topic, non quello della misura", () => {
    expect(windowForMeasure(measure({ model: "claude-haiku-4-5" }), "claude-opus-5[1m]"))
      .toEqual({ tokens: 1_000_000, known: true });
  });

  it("un modello sconosciuto NON sovrascrive la finestra registrata", () => {
    // Poteva essere dichiarata dal provider (Codex manda model_context_window):
    // un dato dichiarato batte una nostra ipotesi.
    const m = measure({ model: "qualcosa-di-ignoto", windowTokens: 333_000 });
    expect(windowForMeasure(m, "qualcosa-di-ignoto")).toEqual({ tokens: 333_000, known: true });
  });

  it("propaga `estimated` della misura quando ricade su di essa", () => {
    const m = measure({ model: "ignoto", windowTokens: 123_000, estimated: true });
    expect(windowForMeasure(m, "ignoto")).toEqual({ tokens: 123_000, known: false });
  });

  it("senza modello corrente usa quello che ha risposto", () => {
    expect(windowForMeasure(measure({ model: "claude-haiku-4-5" }), null))
      .toEqual({ tokens: 200_000, known: true });
  });
});

describe("soglie assolute — il prezzo per chiamata, non solo la capienza", () => {
  // Su una finestra da 1M il 70% è 700k: una sessione che gira a 380k non riceve
  // un fiato, mentre ogni chiamata rilegge quei 380k (~14 chiamate per turno
  // misurate = oltre cinque milioni di token per turno).
  const win1m = { tokens: 1_000_000, known: true };

  it("avvisa a 200k anche se percentualmente è il 20% di un milione", () => {
    const u = classifyContext(200_000, win1m);
    expect(u.percent).toBe(20);
    expect(u.level).toBe("warn");
    expect(u.reason).toBe("cost");
  });

  it("critico a 400k, sempre al 40%", () => {
    const u = classifyContext(400_000, win1m);
    expect(u.percent).toBe(40);
    expect(u.level).toBe("critical");
    expect(u.reason).toBe("cost");
  });

  it("sotto entrambe le soglie resta ok e senza motivo da spiegare", () => {
    const u = classifyContext(150_000, win1m);
    expect(u.level).toBe("ok");
    expect(u.reason).toBeUndefined();
  });

  it("la capienza vince come spiegazione quando scattano entrambe", () => {
    // 190k su 200k: 95% E sopra i 200k assoluti? no — 190k < 200k, quindi solo %.
    const stretta = classifyContext(190_000, { tokens: 200_000, known: true });
    expect(stretta.level).toBe("critical");
    expect(stretta.reason).toBe("window");
    // 950k su 1M: entrambe passate, la finestra è la spiegazione più urgente.
    const entrambe = classifyContext(950_000, win1m);
    expect(entrambe.reason).toBe("window");
  });

  it("il ring resta blu dove il preavviso scatta per costo (colore = percentuale)", () => {
    // Separazione voluta: ContextRing colora su `percent`, il notice legge `level`.
    // Un anello rosso al 40% sarebbe la stessa confusione che il fix delle finestre
    // ha appena eliminato.
    const u = classifyContext(400_000, win1m);
    expect(u.percent).toBeLessThan(70);
    expect(u.level).toBe("critical");
  });
});
