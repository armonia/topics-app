/**
 * I TOKEN DEVONO SCORRERE MENTRE IL TURNO GIRA, non arrivare tutti alla fine.
 *
 * ── Il guasto ───────────────────────────────────────────────────────────────
 * Il chip vivo sulla card della board legge il registro dell'uso ogni quattro
 * secondi. Il runtime nativo ci depositava il totale UNA VOLTA SOLA, a turno
 * finito: su un agente dispacciato — decine di minuti, centinaia di giri di
 * tool — il numero restava fermo per tutto il tempo, e al primo turno restava a
 * zero perché la card non aveva nessun totale precedente da mostrare. Segnalato
 * con queste parole: «non vedo più i token scorrere nei task in progress».
 *
 * Qui si guida `runAgentTurn` contro un finto stream SSE (due giri: uno che
 * chiede un tool, uno che chiude) e si guarda QUANDO l'uso viene consegnato.
 * Niente rete e niente credenziali vere: la `HOME` del test contiene un token
 * finto ma fresco, che è tutto ciò che serve per non passare dal rinnovo.
 * @covers USAGE-03
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAgentTurn, type AgentMessage } from "./agent-loop";
import type { StreamHandler, ProviderUsage } from "../types";
import { partsFromMessage } from "../../../shared/token-cost";

const HOME_VERA = process.env.HOME;
let casa: string;
let ws: string;
const fetchVero = globalThis.fetch;

/** Un evento SSE come lo manda l'API. */
function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const giroConTool = sse([
  { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 10, cache_creation_input_tokens: 7, cache_creation: { ephemeral_1h_input_tokens: 7 } } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"non-esiste.txt"}' } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
]);

const giroFinale = sse([
  { type: "message_start", message: { usage: { input_tokens: 200, cache_read_input_tokens: 20, cache_creation_input_tokens: 3, cache_creation: { ephemeral_1h_input_tokens: 3 } } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fatto" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
]);

function handler(): StreamHandler {
  return {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => {},
    onError: () => {},
  };
}

describe("l'uso del runtime nativo, giro per giro", () => {
  beforeAll(() => {
    casa = mkdtempSync(join(tmpdir(), "native-usage-home-"));
    ws = mkdtempSync(join(tmpdir(), "native-usage-ws-"));
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

  test("ogni giro consegna il SUO uso, prima che il turno finisca", async () => {
    const risposte = [giroConTool, giroFinale];
    globalThis.fetch = (async () => new Response(risposte.shift() ?? giroFinale, { status: 200 })) as unknown as typeof fetch;

    const consegne: Array<{ input: number; output: number; cacheWrite1h: number }> = [];
    const history: AgentMessage[] = [{ role: "user", content: "leggi un file" }];
    const out = await runAgentTurn(
      {
        model: "claude-haiku-4-5-20251001",
        history,
        toolContext: { workspace: ws },
        autonomy: "auto-apply",
        onRoundUsage: (u) => consegne.push({ input: u.input, output: u.output, cacheWrite1h: u.cacheWrite1h }),
      },
      handler(),
    );

    // DUE consegne, non una: è la differenza fra un contatore che scorre e un
    // contatore che si accende alla fine.
    expect(consegne.length).toBe(2);
    expect(consegne[0]).toEqual({ input: 100, output: 20, cacheWrite1h: 7 });
    expect(consegne[1]).toEqual({ input: 200, output: 5, cacheWrite1h: 3 });

    // E la somma delle consegne è ESATTAMENTE il totale del turno: chi somma i
    // delta arriva dove arriverebbe aspettando la fine, senza contare due volte.
    expect(out.usage.input).toBe(300);
    expect(out.usage.output).toBe(25);
    expect(out.turnEnd.end).toBe("end_turn");
  });

  test("la quota di cache a un'ora entra nel totale, invece di sparire", async () => {
    // Era persa in fondo alla somma dei giri: `total.cacheWrite1h` non veniva
    // mai incrementato, quindi la parte di scrittura che costa 2x risultava
    // sempre zero e veniva tariffata 1.25x.
    const risposte = [giroConTool, giroFinale];
    globalThis.fetch = (async () => new Response(risposte.shift() ?? giroFinale, { status: 200 })) as unknown as typeof fetch;
    const out = await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history: [{ role: "user", content: "vai" }], toolContext: { workspace: ws }, autonomy: "auto-apply" },
      handler(),
    );
    expect(out.usage.cacheWrite).toBe(10);
    expect(out.usage.cacheWrite1h).toBe(10);
  });

  /**
   * THE COLUMN MEANS "THE WHOLE PROMPT", and this runtime used to write a
   * tenth of a percent of it.
   *
   * The API reports `input_tokens` as the fresh share alone. Passed on as-is it
   * landed in `messages.usage_prompt_tokens`, which everywhere else in the repo
   * is the total WITH cache inside it: `partsFromMessage` subtracts the cache
   * read from it, so a real turn with 14 fresh and 230541 read produced a
   * billable share of `max(0, 14 - 230541)` = zero and disappeared from the
   * profile and the person stats. On the live database: 1448 CLI rows out of
   * 1448 satisfied `prompt >= cache_read`, 0 native rows out of 6 did.
   * @covers USAGE-03
   */
  test("l'uso consegnato a fine turno porta il prompt INTERO, cache compresa", async () => {
    const risposte = [giroConTool, giroFinale];
    globalThis.fetch = (async () => new Response(risposte.shift() ?? giroFinale, { status: 200 })) as unknown as typeof fetch;

    let delivered: ProviderUsage | undefined;
    const h = handler();
    h.onDone = (m) => { delivered = m?.usage; };

    const out = await runAgentTurn(
      { model: "claude-haiku-4-5-20251001", history: [{ role: "user", content: "vai" }], toolContext: { workspace: ws }, autonomy: "auto-apply" },
      h,
    );

    // 300 fresh + 30 read + 10 written: the prompt as the column counts it.
    expect(delivered?.inputTokens).toBe(340);
    expect(delivered?.outputTokens).toBe(25);
    // The shares stay reported separately TOO, because the price bills them at
    // three different rates. They are inside the total, not beside it.
    expect(delivered?.cacheRead).toBe(30);
    expect(delivered?.cacheCreation).toBe(10);
    // The one-hour share is a SUBSET of the write, so it does not enter the
    // total a second time: 340, not 350.
    expect(delivered?.cacheCreation1h).toBe(10);

    // THE CONTRACT, written the way whoever consumes the row reads it.
    expect(delivered!.inputTokens!).toBeGreaterThanOrEqual(delivered!.cacheRead!);

    // And the whole way down to the shape the chat uses: the billable share is
    // what is NOT a cache read, i.e. fresh + write + answer. It used to come
    // out as 25 (the answer alone), because the subtraction went below zero.
    const shares = partsFromMessage({
      usagePromptTokens: delivered?.inputTokens,
      usageCompletionTokens: delivered?.outputTokens,
      cacheReadTokens: delivered?.cacheRead,
    });
    expect(shares).toEqual({ billable: 335, cacheRead: 30 });

    // The live registry does NOT change: there the usage stays raw, round by
    // round, and it is the source of the chip on the card. The two measures
    // coexist without ever being added to each other.
    expect(out.usage.input).toBe(300);
  });

  /**
   * A CANCELLED TURN HAS STILL BEEN PAID FOR.
   *
   * The loop called `onAborted` with the text and the reason but without the
   * usage, so a turn stopped by the watchdog or by the human's Stop - after the
   * model had already worked through several rounds - finalized its row with
   * tokens, cost and model empty, and looked free.
   * @covers USAGE-03
   */
  test("un turno annullato a meta' consegna comunque quel che ha consumato", async () => {
    // The first round runs, then the stop arrives: the loop checks the signal
    // at the top of the next iteration and leaves through `onAborted`.
    const stop = new AbortController();
    globalThis.fetch = (async () => {
      stop.abort();
      return new Response(giroConTool, { status: 200 });
    }) as unknown as typeof fetch;

    let aborted: ProviderUsage | undefined;
    const h = handler();
    h.onAborted = (m) => { aborted = m?.usage; };

    const out = await runAgentTurn(
      {
        model: "claude-haiku-4-5-20251001",
        history: [{ role: "user", content: "vai" }],
        toolContext: { workspace: ws },
        autonomy: "auto-apply",
        signal: stop.signal,
      },
      h,
    );

    expect(out.turnEnd.end).toBe("cancelled");
    // 100 fresh + 10 read + 7 written, from the single round that did run.
    expect(aborted?.inputTokens).toBe(117);
    expect(aborted?.outputTokens).toBe(20);
    expect(aborted?.cacheRead).toBe(10);
  });
});
