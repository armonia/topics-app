/**
 * Quanto pesa APRIRE una chat.
 *
 * Nessun cancello di questo repo guardava i byte che `/api/history` mette sul
 * filo. Il budget di frame (`check:fluido`) e quello del click-inchiostro
 * (`check:ink`) misurano cosa succede DOPO che i dati sono arrivati: per
 * costruzione tacciono su una risposta che è ingrassata di megabyte, cioè
 * proprio sui secondi di schermo vuoto che si vedono su una PWA in LAN.
 *
 * Qui si misurano due cose diverse, e la prima è quella che conta:
 *
 *  1. INVARIANTE — sul filo non viaggia mai lo stesso testo due volte. Il
 *     risultato di un tool sta in `toolCall.result` E dentro `toolCall.detail`
 *     (`detail.output` per una shell, `detail.content` per un Read), e il
 *     renderer legge solo il secondo. È una proprietà strutturale: non dipende
 *     dalla macchina, non va ritarata, e diventa rossa appena qualcuno rimette
 *     la copia. Misurato il 2026-08-14 sul DB di questa macchina, topic
 *     6b99e9cf: 8,20 MB → 5,42 MB, cioè il 34% del payload era duplicato, su
 *     1.015 tool call.
 *
 *  2. BUDGET — i byte per messaggio su una fixture fissa. Serve a vedere il
 *     grasso NUOVO, quello che nessun invariante conosce ancora.
 *
 * L'ultimo test è il cancello che si guarda allo specchio: costruisce lo stesso
 * payload SENZA la sfoltita e pretende che l'invariante lo rifiuti. Una
 * condizione mai vista fallire non è un cancello, è una decorazione.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";
import type { ToolCall, ContentBlock } from "../../shared/types";

const TEST_DATA = testTmpDir("history-weight-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

/** Un output di tool grande quanto quelli veri: la mediana misurata è ~4 KB. */
function fakeOutput(seed: string, kb: number): string {
  const line = `${seed} :: la riga di un output di tool, lunga quanto una vera\n`;
  return line.repeat(Math.ceil((kb * 1024) / line.length));
}

/**
 * Una tool call come la scrive il provider: il testo in `detail` E in `result`.
 * È la forma che arriva dal DB, prima che il router la sfoltisca.
 */
function toolCall(id: string, kind: "shell" | "read", kb: number): ToolCall {
  const output = fakeOutput(id, kb);
  const detail = kind === "shell"
    ? { type: "shell" as const, command: `echo ${id}`, output }
    : { type: "read" as const, filePath: `/tmp/${id}.txt`, content: output };
  return { id, name: kind === "shell" ? "Bash" : "Read", args: {}, status: "success", result: output, detail };
}

/**
 * Fixture: 20 messaggi assistente, 3 tool call ciascuno da 4 KB. Le proporzioni
 * (quanti tool per messaggio, quanto pesa un output) vengono dal DB vero di
 * questa macchina, non da un numero tondo scelto a mano.
 */
const MESSAGES = 20;
const TOOLS_PER_MESSAGE = 3;
const TOOL_KB = 4;

function seedThread(ctx: AppContext, sessionKey: string, p: string): void {
  const msgs: StoredMessage[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < MESSAGES; i++) {
    const u = `${p}-u${i}`;
    msgs.push({ id: u, role: "user", content: `domanda ${i}`, timestamp: new Date(Date.now() + i * 2000).toISOString(), parentId });
    const blocks: ContentBlock[] = [];
    const calls: ToolCall[] = [];
    for (let t = 0; t < TOOLS_PER_MESSAGE; t++) {
      const tc = toolCall(`${p}-${i}-${t}`, t % 2 === 0 ? "shell" : "read", TOOL_KB);
      calls.push(tc);
      blocks.push({ kind: "tool", toolCall: tc } as ContentBlock);
    }
    blocks.push({ kind: "text", text: `risposta ${i}` } as ContentBlock);
    const a = `${p}-a${i}`;
    msgs.push({ id: a, role: "assistant", content: `risposta ${i}`, timestamp: new Date(Date.now() + i * 2000 + 1000).toISOString(), parentId: u, blocks, toolCalls: calls });
    parentId = a;
  }
  ctx.saveLocalMessages(sessionKey, msgs);
}

/** `messages.id` è una chiave primaria GLOBALE: ogni sessione semina con un prefisso suo. */
async function historyPayload(sessionKey: string): Promise<{ body: string; json: { messages: StoredMessage[] } }> {
  const { createHistoryRouter } = await import("../../server/routes/history");
  const ctx = await createTestAppContext();
  seedThread(ctx, sessionKey, sessionKey.replace(/[^a-z0-9]/gi, ""));
  const router = createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => { throw new Error("nessun provider: la fixture ha già i messaggi locali"); },
  });
  const path = `/api/history/${encodeURIComponent(sessionKey)}`;
  const url = new URL(`http://h${path}?limit=0`);
  const resp = (await router(new Request(url), url, path, "GET"))!;
  expect(resp.status).toBe(200);
  const body = await resp.text();
  return { body, json: JSON.parse(body) };
}

/** Ogni tool call che il payload mette sul filo, ovunque stia. */
function wireToolCalls(messages: StoredMessage[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const m of messages) {
    for (const b of (m.blocks ?? []) as Array<{ toolCall?: ToolCall }>) if (b.toolCall) out.push(b.toolCall);
    for (const tc of m.toolCalls ?? []) out.push(tc);
  }
  return out;
}

/** Le stringhe dentro `detail`, fino al secondo livello (dove vive `raw`). */
function detailStrings(detail: unknown, depth = 0): string[] {
  if (typeof detail === "string") return [detail];
  if (depth >= 2 || detail === null || typeof detail !== "object") return [];
  return Object.values(detail as Record<string, unknown>).flatMap((v) => detailStrings(v, depth + 1));
}

/** Quante tool call portano `result` già presente, identico, dentro `detail`. */
function duplicated(calls: ToolCall[]): ToolCall[] {
  return calls.filter((tc) => typeof tc.result === "string" && tc.result.length > 0 && detailStrings(tc.detail).includes(tc.result));
}

describe("peso di /api/history", () => {
  test("INVARIANTE: nessun testo di tool viaggia due volte", async () => {
    const { json } = await historyPayload("topic:weight-inv");
    const calls = wireToolCalls(json.messages);
    expect(calls.length).toBe(MESSAGES * TOOLS_PER_MESSAGE);
    expect(duplicated(calls).map((tc) => tc.id)).toEqual([]);
  });

  test("la sfoltita è SENZA PERDITA: il testo tolto è ancora leggibile in detail", async () => {
    const { json } = await historyPayload("topic:weight-lossless");
    const calls = wireToolCalls(json.messages);
    // Nessuna call ha perso il testo: o `result` c'è ancora, o `detail` lo porta.
    for (const tc of calls) {
      const testo = detailStrings(tc.detail).find((s) => s.includes("la riga di un output di tool"));
      expect(typeof testo === "string" && testo.length > 0).toBe(true);
    }
    // E il resto della riga è intatto: id, nome, stato.
    expect(calls.every((tc) => tc.id && tc.name && tc.status === "success")).toBe(true);
  });

  test("BUDGET: i byte per messaggio della fixture stanno sotto il tetto", async () => {
    const { body, json } = await historyPayload("topic:weight-budget");
    const perMessaggio = body.length / json.messages.length;
    // Misurato il 2026-08-14 su questa fixture: ~6,4 KB per messaggio (i 3
    // output da 4 KB pesano solo sul messaggio assistente, e i due ruoli si
    // alternano). Il tetto è il DOPPIO del misurato: sotto ci sta la variazione
    // di un JSON.stringify fra versioni di Bun, sopra ci finisce chiunque
    // rimetta una seconda copia del testo — che sarebbe +100% esatto.
    expect(perMessaggio).toBeLessThan(13 * 1024);
    // E il pavimento: se un giorno la fixture smettesse di portare gli output,
    // il budget passerebbe verde misurando il nulla.
    expect(perMessaggio).toBeGreaterThan(3 * 1024);
  });

  test("il cancello SA diventare rosso: lo stesso payload senza la sfoltita non passa", async () => {
    const { json } = await historyPayload("topic:weight-red");
    // Il payload di prima con la copia rimessa dentro — cioè esattamente ciò
    // che il router restituiva prima di `leanToolCall`.
    const grasso = json.messages.map((m) => ({
      ...m,
      blocks: (m.blocks ?? []).map((b) => {
        const tc = (b as { toolCall?: ToolCall }).toolCall;
        if (!tc) return b;
        const testo = detailStrings(tc.detail).find((s) => s.length > 100);
        return { ...b, toolCall: { ...tc, result: testo } };
      }),
    })) as StoredMessage[];
    const calls = wireToolCalls(grasso);
    expect(duplicated(calls).length).toBe(MESSAGES * TOOLS_PER_MESSAGE);
    // e pesa il doppio, che è la ragione per cui l'invariante esiste
    expect(JSON.stringify(grasso).length).toBeGreaterThan(JSON.stringify(json.messages).length * 1.8);
  });
});
