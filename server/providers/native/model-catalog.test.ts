/**
 * IL CATALOGO DEI MODELLI È UNA GUARDIA, NON UN'ETICHETTA.
 *
 * `routes/chat.ts` confronta il modello richiesto con ciò che il provider
 * DICHIARA: quello che non compare nel catalogo viene scartato
 * (`Dropping stale model override`) e la sessione cade sul default. Quindi un
 * catalogo vecchio non è un dettaglio cosmetico — è un declassamento silenzioso
 * di ogni sessione che chiede il modello mancante.
 *
 * ── Il guasto che lo fa nascere (18-19/08/2026) ─────────────────────────────
 * Il catalogo si era fermato alla generazione 4-6. Il picker offriva
 * `claude-opus-5[1m]`, `long-window.ts` (17/08) sapeva già tradurre quel
 * suffisso nell'header beta che l'API vuole, e `agent-loop.ts` lo chiamava — ma
 * la guardia scartava l'override prima, perché l'id non era in lista. Risultato
 * misurato: ogni card della board girava su `claude-sonnet-4-6` mentre l'app
 * scriveva Opus 5 in due punti diversi dell'interfaccia.
 *
 * Nessuno dei test esistenti poteva vederlo: guardavano il loop, la finestra
 * lunga, la compattazione — cioè i pezzi che funzionavano. Mancava la domanda
 * «il catalogo e il codice che esegue sono d'accordo?».
  * @covers RT-06
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeProvider, DEFAULT_MODEL } from "./provider";
import { splitLongWindow } from "./long-window";
import { topicsRoutingAvailable } from "../../../shared/task-coding-models";
import type { ProvidersSnapshot } from "../../../shared/types";

const provider = new NativeProvider({ type: "native" });

describe("catalogo dei modelli del runtime nativo", () => {
  test("il default è nel catalogo (se no la guardia scarta anche lui)", async () => {
    // Un default fuori catalogo è il caso peggiore: non c'è nessun override da
    // incolpare, e la sessione parte comunque su un id che il provider dice di
    // non conoscere.
    const models = await provider.listModels();
    expect(models).toContain(DEFAULT_MODEL);
  });

  test("la finestra lunga è RAGGIUNGIBILE: almeno un id `[1m]` è offerto", async () => {
    // È l'invariante che il guasto ha violato. `long-window.ts` esiste solo per
    // eseguire questi id: un catalogo senza nemmeno uno rende quel modulo
    // codice morto e la finestra da 1M irraggiungibile, in silenzio.
    const models = await provider.listModels();
    const lunghi = models.filter((m) => splitLongWindow(m).longWindow);
    expect(lunghi.length, "nessun modello a finestra lunga nel catalogo: long-window.ts sarebbe irraggiungibile").toBeGreaterThan(0);
  });

  test("ogni id `[1m]` ha anche la sua versione nuda", async () => {
    // Offrire solo la variante lunga costringerebbe la finestra da 1M anche a
    // chi non la vuole: il nome nudo è la scelta normale, quello col suffisso
    // è l'aggiunta.
    const models = await provider.listModels();
    for (const m of models) {
      const { model: nudo, longWindow } = splitLongWindow(m);
      if (longWindow) expect(models, `${m} è offerto senza ${nudo}`).toContain(nudo);
    }
  });

  test("il modello di default di Topics (opus 5.5) e' nel catalogo, lungo e nudo", async () => {
    // Since 09/22 app_settings.claude_model is claude-opus-5-5[1m], and the
    // providers snapshot reports it as this runtime's default. Outside this
    // list the picker cannot show the model the runtime is using, and the
    // default sits outside its own catalogue: the 08/18 failure again.
    const models = await provider.listModels();
    expect(models).toContain("claude-opus-5-5[1m]");
    expect(models).toContain("claude-opus-5-5");
  });

  test("nessun duplicato e nessun nome vuoto", async () => {
    const models = await provider.listModels();
    expect(new Set(models).size).toBe(models.length);
    for (const m of models) expect(m.trim().length).toBeGreaterThan(0);
  });

  test("IL PREDICATO MORDE: il catalogo di prima del guasto sarebbe stato bocciato", () => {
    // Senza questo caso, i controlli sopra resterebbero verdi anche se
    // `splitLongWindow` smettesse di riconoscere il suffisso, e nessuno lo
    // saprebbe finché non ricapita.
    const oldCatalogue = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    const lunghi = oldCatalogue.filter((m) => splitLongWindow(m).longWindow);
    expect(lunghi.length, "il catalogo 4-6 non aveva nessuna finestra lunga: è esattamente il caso da bocciare").toBe(0);
  });
});

/** The Claude models the live Claude Code catalog offered on 2026-09-28. */
const CLAUDE_CODE_OFFER = [
  "claude-opus-5-5", "claude-opus-5-5[1m]", "claude-opus-4-8", "claude-opus-4-8[1m]",
  "claude-sonnet-5-5", "claude-sonnet-5-5[1m]", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]",
  "claude-haiku-4-5", "claude-haiku-3-55", "claude-fable-5-1",
];
/** The ids of that offer that did NOT answer 200 on the 2026-09-28 probe (see MODELS). */
const NOT_SERVED = ["claude-sonnet-4-6[1m]", "claude-haiku-3-55"];

function routingSnapshot(nativeModels: string[]): ProvidersSnapshot {
  const entry = (name: string, models: string[]) =>
    ({ name, models, status: "ready" as const, isDefault: false, requirements: [], fetchedAt: "2026-09-28T00:00:00Z" });
  return {
    providers: [entry("topics", nativeModels), entry("claude-code", CLAUDE_CODE_OFFER)],
    defaultProvider: "claude-code",
    generatedAt: "2026-09-28T00:00:00Z",
  };
}

describe("the routing switch reads this catalog", () => {
  test("every Claude Code model the engine answered 200 for can be routed through Topics", async () => {
    // The switch was disabled for Fable 5.1, Opus 4.8 and Haiku 4.5 by its
    // short name: the catalog lacked the first two, and knew Haiku only by
    // its dated id.
    const snapshot = routingSnapshot(await provider.listModels());
    for (const model of CLAUDE_CODE_OFFER) {
      expect(topicsRoutingAvailable("claude-code", model, snapshot), model).toBe(!NOT_SERVED.includes(model));
    }
  });
});

describe("the engine runs an alias under its catalog id", () => {
  const realHome = process.env.HOME;
  const realFetch = globalThis.fetch;
  let home: string;

  beforeAll(() => {
    // A fake but fresh token: the turn never reaches the refresh path or the network.
    home = mkdtempSync(join(tmpdir(), "native-alias-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "fake-but-fresh", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
    process.env.HOME = home;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("a turn asked for claude-haiku-4-5 sends the dated id the catalog lists", async () => {
    const sent: string[] = [];
    const done = [
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (String(url).includes("/v1/messages")) sent.push(JSON.parse(String(init.body)).model);
      return new Response(done, { status: 200 });
    }) as unknown as typeof fetch;

    const engine = new NativeProvider({ type: "native", defaultWorkspace: home });
    await engine.sendChat("topic:alias-probe", "hi", {
      onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {}, onDone: () => {}, onError: () => {},
    }, { model: "claude-haiku-4-5" });

    expect(sent).toEqual(["claude-haiku-4-5-20251001"]);
  });
});
