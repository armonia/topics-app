/**
 * LO SPEGNIMENTO DEL SERVER NON PUÒ TRAVESTIRSI DA «L'UTENTE HA PREMUTO STOP».
 *
 * ── Il guasto (20/08/2026, topic:9f9e9629) ─────────────────────────────────
 * Un turno sul runtime NATIVO era a metà di un `bash` quando fswatch ha visto
 * un salvataggio in `server/`. `restart-when-idle` ha atteso i suoi 60 secondi
 * di cap per le chat, poi SIGTERM → `stopAllProviders()` → `NativeProvider.
 * stop()` → `abort()` su ogni sessione viva.
 *
 * Da lì in poi il sistema ha raccontato una cosa che non era successa:
 *   · `sendChat` scriveva `cancelled` con `cause: "user"` FISSO, perché un
 *     `AbortSignal` porta il segnale e non la ragione;
 *   · `activity_log` registrava «stream aborted by user»;
 *   · e soprattutto `finalizeStream`, che su uno stop dell'umano tace di
 *     proposito, taceva — quindi in chat non compariva nessun cartello e
 *     nessun «Riprova».
 *
 * L'utente ha visto una risposta che si ferma a metà frase e non riprende più.
 *
 * ── Il secondo difetto, indipendente dal primo ─────────────────────────────
 * `runAgentTurn` controlla `signal.aborted` in cima a ogni giro e, se scattato,
 * usciva con un `return` MUTO: nessun `onDone`, nessun `onError`, nessun
 * `onAborted`. Ma `routes/chat.ts` finalizza il turno SOLO da uno di quei tre.
 * Quel ramo lasciava quindi lo stream SSE aperto su un turno già morto, in
 * attesa che dopo minuti arrivasse un watchdog con la sua spiegazione sbagliata
 * («il provider non risponde»).
 *
 * Le due prove qui sotto sono rosse contro il codice di prima: la prima perché
 * `cause` era la costante `"user"`, la seconda perché sul ramo dell'abort non
 * veniva chiamato nessun handler.
  * @covers RT-01
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, type AgentMessage } from "./agent-loop";
import type { StreamHandler } from "../types";
import type { TurnEndInfo } from "../stop-reason";

const HOME_VERA = process.env.HOME;
let casa: string;
let ws: string;
const fetchVero = globalThis.fetch;

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** Come `giroConTool`, ma il tool è un comando LUNGO: serve a mettere l'abort
 *  DENTRO l'esecuzione, che è il punto dove il turno passa il suo tempo. */
const giroConToolLungo = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "misuro la densità" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_9", name: "bash", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"sleep 30"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
]);

/** Un giro che chiede un tool: dopo di lui il ciclo fa un altro giro, ed è
 *  proprio all'inizio del giro dopo che il controllo sull'abort scatta. */
const giroConTool = sse([
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sto misurando" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "read_file", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"non-esiste.txt"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
]);

interface Spia extends StreamHandler {
  eventi: string[];
  fini: TurnEndInfo[];
}

function spia(): Spia {
  const eventi: string[] = [];
  const fini: TurnEndInfo[] = [];
  return {
    eventi,
    fini,
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: (m) => { eventi.push("done"); if (m?.turnEnd) fini.push(m.turnEnd); },
    onError: () => { eventi.push("error"); },
    onAborted: (m) => { eventi.push("aborted"); if (m?.turnEnd) fini.push(m.turnEnd); },
  };
}

describe("il ciclo dell'agente nativo quando il server si spegne sotto di lui", () => {
  beforeAll(() => {
    casa = mkdtempSync(join(tmpdir(), "native-abort-home-"));
    ws = mkdtempSync(join(tmpdir(), "native-abort-ws-"));
    mkdirSync(join(casa, ".claude"), { recursive: true });
    writeFileSync(
      join(casa, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "finto-ma-fresco", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
    process.env.HOME = casa;
  });

  afterAll(() => {
    globalThis.fetch = fetchVero;
    if (HOME_VERA === undefined) delete process.env.HOME; else process.env.HOME = HOME_VERA;
    for (const d of [casa, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  /**
   * LE CONDIZIONI DEL 20/08, ricreate: un turno che ha già prodotto testo e un
   * tool, e lo spegnimento che arriva fra un giro e l'altro.
   */
  test("l'uscita sull'abort NON è muta: chiama onAborted con la causa vera", async () => {
    const ac = new AbortController();
    // Il finto server risponde al primo giro con una richiesta di tool, e
    // ANNULLA mentre il ciclo esegue il tool — cioè esattamente dove arriva un
    // SIGTERM: fra due richieste al modello.
    let giri = 0;
    globalThis.fetch = (async () => {
      giri++;
      if (giri === 1) {
        // Lo spegnimento parte subito dopo che questo giro è stato consegnato.
        queueMicrotask(() => ac.abort("server-shutdown"));
        return new Response(giroConTool, { status: 200 });
      }
      throw new Error("il ciclo non doveva chiedere un secondo giro dopo l'abort");
    }) as unknown as typeof fetch;

    const h = spia();
    const history: AgentMessage[] = [{ role: "user", content: "misura il divario" }];
    const out = await runAgentTurn(
      {
        model: "claude-haiku-4-5-20251001",
        history,
        toolContext: { workspace: ws },
        autonomy: "auto-apply",
        signal: ac.signal,
      },
      h,
    );

    // 1. QUALCUNO È STATO AVVISATO. Prima non veniva chiamato nessun handler, e
    //    `routes/chat.ts` finalizza solo da done/error/aborted: lo stream SSE
    //    restava aperto su un turno morto.
    expect(h.eventi).toContain("aborted");
    expect(h.eventi).not.toContain("done");
    expect(h.eventi).not.toContain("error");

    // 2. E GLI È STATA DETTA LA VERITÀ. Prima era `cause: "user"` fisso, ed è
    //    la bugia che si portava via il cartello in chat.
    expect(out.turnEnd.end).toBe("cancelled");
    expect(out.turnEnd.cause).toBe("server-shutdown");
    expect(h.fini[0]?.cause).toBe("server-shutdown");

    // 3. IL LAVORO GIÀ FATTO NON SI PERDE: il testo prodotto prima dello stop
    //    torna al chiamante, che lo persiste sotto il cartello.
    expect(out.text).toContain("sto misurando");
  });

  /**
   * IL CASO VERO DEL 20/08, che i due capi verdi non toccavano.
   *
   * Gli altri test di questo file annullano fra un giro e l'altro, con un tool
   * istantaneo: lì il controllo in cima al giro basta. Ma un turno d'agente sta
   * quasi tutto il tempo FERMO dentro un tool, e il 20/08 su topic:9f9e9629 lo
   * spegnimento è arrivato dentro un `bash` con un `sleep 100`. Il comando non
   * ascoltava il segnale, `stopAllProviders` aspetta 3,5 secondi e poi
   * `process.exit(0)`: il turno è uscito senza mai chiamare `onAborted`, e la
   * chat è rimasta con mezza frase e nessuna spiegazione.
   *
   * Il tempo QUI È IL TEST: 30 secondi di comando contro una finestra di 3,5.
   */
  test("abort DENTRO un tool lungo: il turno finisce subito, non alla fine del comando", async () => {
    const ac = new AbortController();
    let giri = 0;
    globalThis.fetch = (async () => {
      giri++;
      if (giri === 1) {
        // Annulla mentre il `sleep 30` gira, non fra un giro e l'altro.
        setTimeout(() => ac.abort("server-shutdown"), 150);
        return new Response(giroConToolLungo, { status: 200 });
      }
      throw new Error("nessun secondo giro atteso: il turno era già annullato");
    }) as unknown as typeof fetch;

    const h = spia();
    const partito = Date.now();
    const out = await runAgentTurn(
      {
        model: "claude-haiku-4-5-20251001",
        history: [{ role: "user", content: "misura" }],
        toolContext: { workspace: ws, signal: ac.signal },
        autonomy: "auto-apply",
        signal: ac.signal,
      },
      h,
    );
    const durata = Date.now() - partito;

    // 1. Non ha aspettato il comando. Sopra i 3,5s il server sarebbe già uscito.
    expect(durata).toBeLessThan(3000);
    // 2. Qualcuno è stato avvisato: senza `onAborted` la route non finalizza,
    //    e il cartello in chat non viene mai scritto.
    expect(h.eventi).toContain("aborted");
    // 3. Con la causa vera, che è quella che accende il cartello.
    expect(out.turnEnd.end).toBe("cancelled");
    expect(out.turnEnd.cause).toBe("server-shutdown");
    // 4. La prosa già scritta sopravvive e finisce sotto il cartello.
    expect(out.text).toContain("misuro la densità");
  });

  /**
   * LO STOP A MANO, che è l'altro verso e conta quanto il primo.
   *
   * Chi preme Ferma passa da `/api/chat/abort`, che dichiara `"user"`. Il
   * turno deve restare `cancelled/user`, perché è su quella causa che
   * `cancelledNotice` tace: a chi ha appena premuto stop non si spiega cos'ha
   * premuto.
   */
  test("stop a mano: la causa è «user» e arriva dal segnale", async () => {
    const ac = new AbortController();
    let giri = 0;
    globalThis.fetch = (async () => {
      giri++;
      if (giri === 1) { queueMicrotask(() => ac.abort("user")); return new Response(giroConTool, { status: 200 }); }
      throw new Error("nessun secondo giro atteso");
    }) as unknown as typeof fetch;

    const h = spia();
    const out = await runAgentTurn(
      {
        model: "claude-haiku-4-5-20251001",
        history: [{ role: "user", content: "vai" }],
        toolContext: { workspace: ws },
        autonomy: "auto-apply",
        signal: ac.signal,
      },
      h,
    );
    expect(out.turnEnd).toEqual({ end: "cancelled", cause: "user" });
    // Anche qui l'handler viene chiamato: la finalizzazione dello stream non
    // dipende da CHI ha annullato, solo il cartello sì.
    expect(h.eventi).toContain("aborted");
  });

  /**
   * NIENTE DEFAULT INVENTATI, ed è la lezione del 20/08 messa in una prova.
   *
   * Se qualcuno annulla senza dichiararsi — un `abort()` nudo, da una strada
   * che non esiste ancora — il ciclo NON deve indovinare «user». Un `user`
   * inventato fa tacere il cartello, e un turno morto senza spiegazione è
   * esattamente il guasto da cui nasce tutto questo file. Meglio `cancelled`
   * senza causa: `cancelledNotice` su quel ramo scrive comunque.
   */
  test("annullamento non dichiarato: nessuna causa inventata", async () => {
    const ac = new AbortController();
    let giri = 0;
    globalThis.fetch = (async () => {
      giri++;
      if (giri === 1) { queueMicrotask(() => ac.abort()); return new Response(giroConTool, { status: 200 }); }
      throw new Error("nessun secondo giro atteso");
    }) as unknown as typeof fetch;

    const out = await runAgentTurn(
      {
        model: "claude-haiku-4-5-20251001",
        history: [{ role: "user", content: "vai" }],
        toolContext: { workspace: ws },
        autonomy: "auto-apply",
        signal: ac.signal,
      },
      spia(),
    );
    // `abort()` senza argomenti mette in `reason` una DOMException della
    // piattaforma, che non è una nostra causa: si resta senza.
    expect(out.turnEnd.end).toBe("cancelled");
    expect(out.turnEnd.cause).toBeUndefined();
  });
});

/**
 * IL PONTE FRA `stop()` E IL CICLO, che i test qui sopra non attraversavano.
 *
 * I test del ciclo guidano `runAgentTurn` con un `AbortController` costruito a
 * mano, quindi provano che la causa LETTA dal segnale arriva fino in fondo — ma
 * non che sia `NativeProvider.stop()` a metterla dentro. Rimettendo il difetto
 * originale (`abort()` senza argomenti in `stop()`) restavano tutti verdi: il
 * pezzo di catena che il 20/08 si e' spezzato non era coperto da nessuno.
 *
 * Qui si guarda proprio quel pezzo: si mette una sessione con un turno in volo
 * nel provider VERO, si chiama `stop()` come fa `stopAllProviders()` dentro
 * `gracefulShutdown`, e si legge cosa e' finito in `signal.reason`.
 */
describe("stop() del provider nativo: la causa entra nel segnale", () => {
  test("spegnimento: ogni turno vivo viene annullato con «server-shutdown»", async () => {
    const { NativeProvider } = await import("./provider");
    const prov = new NativeProvider({ type: "native" });
    const ac = new AbortController();
    // Una sessione con un turno in volo, nella forma che il provider usa.
    (prov as unknown as { sessions: Map<string, unknown> }).sessions.set("topic:vivo", {
      history: [], workspace: null, abort: ac, lastUsedAt: Date.now(),
    });

    prov.stop();

    expect(ac.signal.aborted).toBe(true);
    // IL PUNTO: non basta che sia annullato — deve essere annullato DICENDO
    // perche'. Con `abort()` nudo qui ci sarebbe una DOMException, il ciclo
    // non riconoscerebbe nessuna causa, e a valle sparirebbe il cartello.
    expect(ac.signal.reason).toBe("server-shutdown");
  });

  /**
   * L'altro capo della stessa catena: `abort()` con la ragione dichiarata dai
   * suoi tre chiamanti veri (`/api/chat/abort` → user, i due watchdog di
   * `routes/chat.ts` → watchdog).
   */
  test("abort(reason): la ragione dichiarata finisce nel segnale", async () => {
    const { NativeProvider } = await import("./provider");
    const prov = new NativeProvider({ type: "native" });
    const ac = new AbortController();
    (prov as unknown as { sessions: Map<string, unknown> }).sessions.set("topic:x", {
      history: [], workspace: null, abort: ac, lastUsedAt: Date.now(),
    });

    await prov.abort("topic:x", undefined, "watchdog");

    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBe("watchdog");
  });
});
