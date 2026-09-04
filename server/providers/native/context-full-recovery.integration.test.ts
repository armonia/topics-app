/**
 * IL CONTESTO PIENO NON UCCIDE LA CHAT.
 *
 * ── Il difetto (card 18bdf214, misurato sul database vivo) ──────────────────
 * Due topic col runtime nativo hanno smesso di rispondere, e non hanno più
 * ripreso. Ogni invio finiva in:
 *
 *   [StreamWS] Error for topic:6b9605e5: API 400
 *   {"type":"invalid_request_error","message":"prompt is too long:
 *    1000176 tokens > 1000000 maximum"}
 *
 * Non era la compattazione che non partiva: `compaction_markers` conserva la
 * sua ricevuta per quel topic, `pre=1115713 → post=480494`. Era la
 * compattazione che DICHIARAVA di aver funzionato mentre produceva una
 * richiesta ancora doppia del tetto — perché stimava a 4 caratteri per token
 * un contenuto che ne fa 1,9, e perché svuotava i risultati dei tool lasciando
 * interi i loro ARGOMENTI, che erano il 77% del peso rimasto.
 *
 * Da lì in poi la chat era morta per sempre: un 400 non è ritentabile
 * (`classifyFailure` lo classifica «give-up», e fa bene: la stessa richiesta
 * darebbe lo stesso errore), la storia in memoria restava identica, e ogni
 * messaggio successivo ripeteva lo stesso errore. In chat: «Errore del
 * provider».
 *
 * Questo test guida il turno contro un `fetch` finto che risponde ESATTAMENTE
 * come l'API vera: prima il 400 col conteggio dentro, poi un giro sano. Quello
 * che deve succedere in mezzo — ricalibrare la stima sul numero vero,
 * ricompattare, avvisare in chat e rifare il giro da solo — è tutto il punto
 * della card.
 * @covers CHAT-COMPACT-04
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, type AgentMessage } from "./agent-loop";
import { estimateTokens, DEFAULT_CHARS_PER_TOKEN } from "./compaction";
import type { StreamHandler } from "../types";
import type { RetryPolicy } from "./retry";

const HOME_VERA = process.env.HOME;
let homeDir: string;
let ws: string;
let credentialsPath: string;
const realFetch = globalThis.fetch;

const FAST: RetryPolicy = { maxAttempts: 3, baseMs: 1, capMs: 4, jitter: () => 1 };

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/**
 * Un giro sano che dichiara un prompt ENORME ma reale: è da qui che il ciclo
 * impara quanti caratteri fa un token su questa conversazione, senza aspettare
 * di sbatterci contro.
 */
function giroSano(promptTokens: number): string {
  return sse([
    { type: "message_start", message: { usage: { input_tokens: promptTokens } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "eccomi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
  ]);
}

/**
 * Il rapporto VERO fra caratteri e token sul contenuto di un agente, misurato
 * sul caso reale: 1.921.976 caratteri per 1.000.176 token. È il numero che il
 * codice assumeva essere 4, ed è tutta la differenza.
 */
const RAPPORTO_VERO = 1.92;

/**
 * L'API finta, e il motivo per cui NON è un copione.
 *
 * Un copione («al primo colpo rispondi 400, al secondo 200») dimostrerebbe
 * solo che il ciclo sa contare fino a due: passerebbe anche se la
 * ricompattazione non togliesse un byte. Qui il tetto è VERO — la richiesta
 * viene pesata come la peserebbe Anthropic, e viene rifiutata finché è troppo
 * grande. Il turno passa solo se la compattazione lo fa entrare davvero.
 */
function apiConTetto(maxTokens: number) {
  return (body: string): Response => {
    const tokens = Math.ceil(body.length / RAPPORTO_VERO);
    if (tokens > maxTokens) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `prompt is too long: ${tokens} tokens > ${maxTokens} maximum`,
          },
        }),
        { status: 400 },
      );
    }
    return new Response(giroSano(tokens), { status: 200 });
  };
}

interface Ledger {
  done: number;
  errors: string[];
  retries: Array<{ reason: string; attempt: number }>;
  compactions: Array<{ preTokens?: number; postTokens?: number }>;
  text: string;
}

function fresh(): Ledger {
  return { done: 0, errors: [], retries: [], compactions: [], text: "" };
}

function handler(reg: Ledger): StreamHandler {
  return {
    onTextDelta: (d) => { reg.text += d; },
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => { reg.done++; },
    onError: (e: string) => { reg.errors.push(e); },
    onRetry: (i) => { reg.retries.push({ reason: i.reason, attempt: i.attempt }); },
    onCompaction: (m) => { reg.compactions.push(m) },
  };
}

/**
 * Una storia sintetica sopra il tetto, fatta come quella vera: il peso sta
 * negli ARGOMENTI delle chiamate (il corpo dei file scritti), non nei
 * risultati. È la forma che la vecchia compattazione non sapeva alleggerire.
 */
function storiaOltreIlTetto(rounds: number, argSize: number): AgentMessage[] {
  const h: AgentMessage[] = [{ role: "user", content: "Rifammi il parser da capo." }];
  for (let i = 0; i < rounds; i++) {
    h.push({
      role: "assistant",
      content: [
        { type: "text", text: `Giro ${i}.` },
        { type: "tool_use", id: `t${i}`, name: "write_file", input: { path: `src/f${i}.ts`, content: "x".repeat(argSize) } },
      ],
    });
    h.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "scritto" }] });
  }
  return h;
}

function montaApi(api: (body: string) => Response) {
  let n = 0;
  const corpi: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    corpi.push(body);
    n++;
    return api(body);
  }) as unknown as typeof fetch;
  return { calls: () => n, corpi };
}

describe("una chat col contesto pieno si rimette in moto da sola", () => {
  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), "ctx-full-home-"));
    ws = mkdtempSync(join(tmpdir(), "ctx-full-ws-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    credentialsPath = join(homeDir, ".claude", ".credentials.json");
    process.env.HOME = homeDir;
  });

  beforeEach(() => {
    writeFileSync(
      credentialsPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
    );
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (HOME_VERA === undefined) delete process.env.HOME; else process.env.HOME = HOME_VERA;
    for (const d of [homeDir, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  test("il 400 «prompt is too long» non chiude il turno: si compatta e si risponde", async () => {
    const reg = fresh();
    // Il tetto è quello di haiku (200k), pesato come lo pesa l'API vera.
    const s = montaApi(apiConTetto(200_000));
    // TANTI giri leggeri, di proposito: dopo aver alleggerito gli argomenti la
    // stima a 4 caratteri per token dice «ci stiamo» (≈120k token) mentre
    // l'API, che conta sul serio, ne trova ≈250k. È il difetto in provetta.
    const history = storiaOltreIlTetto(1_200, 3_000);
    const prima = estimateTokens(history);

    const out = await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history, toolContext: { workspace: ws }, autonomy: "auto-apply", retryPolicy: FAST },
      handler(reg),
    );

    // PRIMA: il turno moriva qui, e ogni turno successivo pure.
    expect(reg.errors).toEqual([]);
    expect(out.turnEnd.end).toBe("end_turn");
    expect(reg.text).toBe("eccomi");
    expect(reg.done).toBe(1);
    // La prima richiesta è stata rifiutata dal tetto vero, la seconda è
    // passata: la compattazione ha fatto entrare la conversazione davvero.
    expect(s.calls()).toBe(2);
    expect(Math.ceil(s.corpi[0]!.length / RAPPORTO_VERO)).toBeGreaterThan(200_000);
    expect(Math.ceil(s.corpi[1]!.length / RAPPORTO_VERO)).toBeLessThanOrEqual(200_000);
    // La storia in memoria è stata sostituita, quindi il turno DOPO riparte
    // leggero: è questo che toglie la chat dal loop di errore.
    expect(estimateTokens(history)).toBeLessThan(prima / 2);
  });

  test("in chat arriva una frase leggibile, non un errore di rete", async () => {
    const reg = fresh();
    montaApi(apiConTetto(200_000));
    await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history: storiaOltreIlTetto(1_200, 3_000), toolContext: { workspace: ws }, autonomy: "auto-apply", retryPolicy: FAST },
      handler(reg),
    );
    // Il cartello vivo che dice PERCHÉ non si muove niente...
    expect(reg.retries.map((r) => r.reason)).toContain("contesto pieno: compatto e riprovo");
    // ...e il divisore permanente nel trascritto, col peso prima e dopo.
    expect(reg.compactions.length).toBeGreaterThan(0);
    const m = reg.compactions[reg.compactions.length - 1]!;
    expect(m.postTokens!).toBeLessThan(m.preTokens!);
  });

  test("se il contesto pieno non si sblocca, la resa è leggibile e non si gira a vuoto", async () => {
    // Un tetto che nessuna compattazione può raggiungere: il turno deve
    // ARRENDERSI dopo due tentativi, non ritentare per sempre.
    const reg = fresh();
    const s = montaApi(apiConTetto(500));
    const errore = await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history: storiaOltreIlTetto(1_200, 3_000), toolContext: { workspace: ws }, autonomy: "auto-apply", retryPolicy: FAST },
      handler(reg),
    ).catch((e: Error) => e);

    // Ci si ferma al più dopo due ricompattazioni, e prima ancora se una di
    // esse non libera niente: il tetto non è il solo freno, l'altro è
    // «compattare non sta più servendo».
    expect(s.calls()).toBeGreaterThanOrEqual(2);
    expect(s.calls()).toBeLessThanOrEqual(1 + 2);
    const detail = errore instanceof Error ? errore.message : String(errore);
    // Non «API 400: {json}»: una frase che dice cos'è successo e cosa fare.
    expect(detail).toContain("Contesto pieno");
    expect(detail).toContain("Apri una chat nuova");
  });

  test("un giro andato bene calibra la stima, così il 400 non arriva nemmeno", async () => {
    // La parte che PREVIENE invece di riparare: dal prompt che l'API dichiara
    // di aver contato si ricava il rapporto vero, e da lì in poi la soglia si
    // valuta su un numero misurato invece che sui 4 caratteri assunti.
    const reg = fresh();
    montaApi(apiConTetto(200_000));
    const history = storiaOltreIlTetto(20, 1_000);
    const calibration = { charsPerToken: DEFAULT_CHARS_PER_TOKEN };
    await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history, calibration, toolContext: { workspace: ws }, autonomy: "auto-apply", retryPolicy: FAST },
      handler(reg),
    );
    expect(reg.errors).toEqual([]);
    // Più PRUDENTE del rapporto vero, e va bene così: noi contiamo i caratteri
    // del contenuto, l'API pesa anche l'impalcatura JSON che li avvolge. Un
    // rapporto più basso significa «stimo di pesare di più», che è l'errore
    // dalla parte giusta.
    expect(calibration.charsPerToken).toBeLessThan(DEFAULT_CHARS_PER_TOKEN);
    expect(calibration.charsPerToken).toBeLessThanOrEqual(RAPPORTO_VERO);
    expect(calibration.charsPerToken).toBeGreaterThan(1);
  });
});
