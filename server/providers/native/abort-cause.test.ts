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
        queueMicrotask(() => ac.abort());
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
        abortCause: () => "server-shutdown",
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
   * IL DEFAULT RESTA QUELLO STORICO. Un chiamante che non dichiara la causa —
   * il vero stop a mano, che passa da `/api/chat/abort` — deve continuare a
   * ottenere `user`, altrimenti chi preme Ferma si vedrebbe spiegare cos'ha
   * appena fatto.
   */
  test("senza causa dichiarata resta «user»: lo stop a mano non cambia", async () => {
    const ac = new AbortController();
    let giri = 0;
    globalThis.fetch = (async () => {
      giri++;
      if (giri === 1) { queueMicrotask(() => ac.abort()); return new Response(giroConTool, { status: 200 }); }
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
});
