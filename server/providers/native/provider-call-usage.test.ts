/**
 * I TOKEN DEL RUNTIME NATIVO DEVONO USCIRE DALLA PORTA CHE LI SCRIVE SULLA RIGA.
 *
 * ── Il guasto ───────────────────────────────────────────────────────────────
 * Il conteggio di un turno ha DUE destinazioni, e il runtime nativo ne serviva
 * una sola. `recordTurnUsage` riempie il registro in memoria che il dispatcher
 * rilegge per il chip vivo sulla card; `handler.onCallUsage` e' l'altra porta,
 * quella che la rotta della chat accumula, deposita sulla colonna della riga e
 * spedisce al client. Il provider nativo non ha mai chiamato la seconda:
 * `grep -c onCallUsage server/providers/native/` dava 0, mentre claude-code la
 * chiama. Misurato sul DB vivo il 29/08/2026: 0 righe assistant su 147 nelle
 * ultime 24 ore portavano un conteggio, e l'ultima che ce l'aveva era del
 * 24/08 — il giorno in cui le sessioni sono passate a questo runtime.
 * Segnalato con queste parole: «non vedo piu' il consumo token nella chat
 * topics».
 *
 * Qui si guida il provider VERO (`sendChat`, non il ciclo sotto) contro un
 * finto stream SSE di due giri, e si guarda cosa arriva a `onCallUsage`. Il
 * ciclo aveva gia' il suo test (`round-usage.test.ts`, USAGE-03) e restava
 * verde con il difetto in piedi: il buco non era nel ciclo, era nel cablaggio
 * del provider, che nessun test attraversava.
 *
 * Niente rete e niente credenziali vere: la `HOME` del test contiene un token
 * finto ma fresco, che e' tutto cio' che serve per non passare dal rinnovo.
 * @covers USAGE-04
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeProvider } from "./provider";
import type { StreamHandler } from "../types";

const HOME_VERA = process.env.HOME;
const fetchVero = globalThis.fetch;
let casa: string;
let ws: string;

/** Un evento SSE come lo manda l'API. */
function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const giroConTool = sse([
  {
    type: "message_start",
    message: {
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 7,
        cache_creation: { ephemeral_1h_input_tokens: 3 },
      },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"non-esiste.txt"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
]);

const giroFinale = sse([
  {
    type: "message_start",
    message: {
      usage: {
        input_tokens: 200,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_1h_input_tokens: 1 },
      },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fatto" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
]);

type Consegna = {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation1h: number;
  model?: string;
};

function registratore(consegne: Consegna[]): StreamHandler {
  return {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => {},
    onError: () => {},
    onCallUsage: (u) => consegne.push(u as Consegna),
  };
}

describe("il provider nativo e la porta che scrive i token sulla riga", () => {
  beforeAll(() => {
    casa = mkdtempSync(join(tmpdir(), "native-callusage-home-"));
    ws = mkdtempSync(join(tmpdir(), "native-callusage-ws-"));
    mkdirSync(join(casa, ".claude"), { recursive: true });
    writeFileSync(
      join(casa, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "finto-ma-fresco", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
      }),
    );
    process.env.HOME = casa;
  });

  afterAll(() => {
    globalThis.fetch = fetchVero;
    if (HOME_VERA === undefined) delete process.env.HOME; else process.env.HOME = HOME_VERA;
    for (const d of [casa, ws]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
  });

  test("ogni giro esce da onCallUsage, non solo dal registro interno", async () => {
    const risposte = [giroConTool, giroFinale];
    globalThis.fetch = (async () => new Response(risposte.shift() ?? giroFinale, { status: 200 })) as unknown as typeof fetch;

    const consegne: Consegna[] = [];
    const provider = new NativeProvider({ type: "native", defaultWorkspace: ws, model: "claude-haiku-4-5-20251001" });
    await provider.sendChat("topic:prova-usage", "leggi un file", registratore(consegne));

    // DUE consegne, una per giro. Una sola vorrebbe dire che il conteggio
    // arriva tutto alla fine, che era il guasto gia' curato nel ciclo; zero
    // vuol dire che questa porta non e' collegata, che era il guasto qui.
    expect(consegne.length).toBe(2);
  });

  test("la forma consegnata e' quella che la rotta sa leggere", async () => {
    const risposte = [giroFinale];
    globalThis.fetch = (async () => new Response(risposte.shift() ?? giroFinale, { status: 200 })) as unknown as typeof fetch;

    const consegne: Consegna[] = [];
    const provider = new NativeProvider({ type: "native", defaultWorkspace: ws, model: "claude-haiku-4-5-20251001" });
    await provider.sendChat("topic:prova-forma", "di' fatto", registratore(consegne));

    expect(consegne.length).toBe(1);
    const u = consegne[0];
    // I nomi contano quanto i numeri: la rotta legge `inputTokens`, e il ciclo
    // internamente li chiama `input`/`cacheWrite`. Una traduzione mancata qui
    // lascerebbe la colonna vuota lo stesso, con tutti i campi a posto ma con
    // le chiavi sbagliate — cioe' il difetto tornerebbe senza rompere niente.
    expect(u.inputTokens).toBe(200);
    expect(u.outputTokens).toBe(5);
    expect(u.cacheRead).toBe(20);
    expect(u.cacheCreation).toBe(5);
    // Quota DISGIUNTA, non un addendo: e' la parte di `cacheCreation` scritta
    // con la durata di un'ora. Sommarla la conterebbe due volte nel prezzo.
    expect(u.cacheCreation1h).toBe(1);
    // Senza il modello la rotta non sa a che tariffa contare, e il turno esce
    // con i token ma senza prezzo.
    expect(u.model).toBe("claude-haiku-4-5-20251001");
  });
});
