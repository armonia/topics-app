/**
 * LA PROVA CHE MANCAVA: il provider NATIVO vero, la route vera, e lo
 * spegnimento chiamato come lo chiama `gracefulShutdown`.
 *
 * ── Perché non bastavano le altre ──────────────────────────────────────────
 * Fino a qui la catena del 20/08 era coperta a pezzi:
 *   · `native/abort-cause.test.ts` prova il CICLO (con un controller costruito
 *     a mano) e il ponte `stop()` → `signal.reason`;
 *   · `chat-stream-abort.test.ts` prova la ROUTE, ma inietta `onAborted` a mano
 *     con un provider finto.
 *
 * In mezzo restava scoperto proprio il giunto che si è spezzato: che sia il
 * provider NATIVO, annullato dal SUO `stop()`, a far arrivare il cartello fino
 * alla riga del database. Un test che simula `onAborted` dimostra che la route
 * reagisce bene a un evento — non che quell'evento venga emesso.
 *
 * Qui non si simula niente di quella catena: si registra il `NativeProvider`
 * vero, si apre un turno vero dalla route vera (la rete è l'unica cosa finta:
 * un finto endpoint SSE), e poi si chiama `provider.stop()` — la stessa riga
 * che `gracefulShutdown` esegue dentro `stopAllProviders()`. Poi si legge il
 * database.
 *
 * ── L'invariante temporale, che è l'altra cosa che questo test protegge ────
 * Fra l'`abort()` e la scrittura della riga c'è un giro di microtask: la
 * promise del turno rigetta, e il `catch` di `sendChat` gira dopo. In
 * produzione il margine è la finestra di `stopAllProviders` (3500 ms) prima di
 * `closeDatabase()`. Se qualcuno un domani rendesse quella catena più lunga —
 * un `await` di troppo prima di `updateLastMessage` — il cartello smetterebbe
 * di arrivare su disco e il turno tornerebbe a morire muto. Questo test
 * fallisce se succede.
  * @covers RT-01
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { createChatRouter } from "../../server/routes/chat";
import { NativeProvider } from "../../server/providers/native/provider";
import type { AppContext, Topic } from "../../server/types";

const TEST_DATA = testTmpDir("native-shutdown-data");
const HOME_VERA = process.env.HOME;
let casa: string;
const fetchVero = globalThis.fetch;

/** Un giro che scrive della prosa e poi chiede un tool: dopo il tool il ciclo
 *  fa un altro giro, ed è lì che lo spegnimento lo trova. */
function giroConTool(): string {
  return [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ho capito il richiamo. " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Prima misuro il divario." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "read_file", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"non-esiste.txt"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

describe("spegnimento del server sopra un turno NATIVO: la catena intera", () => {
  beforeAll(() => {
    setupTestDataDir(TEST_DATA);
    casa = mkdtempSync(join(tmpdir(), "native-shutdown-home-"));
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
    try { rmSync(casa, { recursive: true, force: true }); } catch { /* scratch */ }
  });

  test("stop() del provider vero → cartello sulla riga, causa e lavoro salvi", async () => {
    const ctx: AppContext = await createTestAppContext();
    (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
    (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void })
      .broadcastToTopicSubscribers = () => {};

    const sessionKey = "topic:native-shutdown";
    const topic: Topic = {
      id: "t-native-shutdown", name: "canzone", slug: "canzone", parentId: null, links: [],
      sessionKey, color: "#5865f2", icon: "MessageSquare",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      archived: false, provider: "topics",
    } as Topic;
    ctx.saveSingleTopic(topic);

    // IL PROVIDER VERO. Nessun finto `onAborted`: quello che arriva alla route
    // lo emette il runtime nativo, per conto suo.
    const provider = new NativeProvider({ type: "native" });
    provider.start();

    // La sola cosa finta è la rete. Il primo giro consegna prosa + un tool;
    // appena il ciclo lo esegue, il server "si spegne".
    let giri = 0;
    let spentoOra: (() => void) | null = null;
    globalThis.fetch = (async () => {
      giri++;
      if (giri === 1) {
        // Lo spegnimento arriva mentre il turno è in volo, come un SIGTERM.
        queueMicrotask(() => spentoOra?.());
        return new Response(giroConTool(), { status: 200 });
      }
      throw new Error("il turno non doveva arrivare a un secondo giro");
    }) as unknown as typeof fetch;

    const chatRouter = createChatRouter(ctx, {
      resolveProvider: () => provider,
      detectLocalhostAutoNav: () => {},
      bindTopicToProject: () => {},
      resolveProjectRef: () => null,
      getProjectIdForTopic: () => null,
      getWorkspaceProjects: () => [],
      autoBindProject: () => {},
      watchSessionForSubagents: () => {},
      updateUnreadCount: () => {},
      browserNavigatedTopics: new Set<string>(),
      WORKSPACE_DIR: testTmpDir("native-shutdown-ws"),
    } as never);

    // `stop()` è ESATTAMENTE la riga che gracefulShutdown esegue dentro
    // `stopAllProviders()`. Non una sua imitazione.
    spentoOra = () => provider.stop();

    const url = new URL("http://topics.test/api/chat");
    const resp = await chatRouter(
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey, messages: [{ role: "user", content: "facciamo una canzone" }] }),
      }),
      url, "/api/chat", "POST",
    );
    expect(resp?.status).toBe(200);
    // Si DRENA l'SSE fino a `[DONE]`: è il modo di aspettare che il turno sia
    // finalizzato senza inventare una `sleep` che un domani sarebbe flaky.
    // Che il drain finisca è già metà della prova: un turno che muore muto
    // lascia lo stream aperto per sempre (era il difetto n.1).
    const reader = resp!.body!.getReader();
    const scadenza = setTimeout(() => reader.cancel().catch(() => {}), 10_000);
    try { while (true) { const { done } = await reader.read(); if (done) break; } }
    finally { clearTimeout(scadenza); }

    const messaggi = ctx.loadLocalMessages(sessionKey);
    const assistente = messaggi.filter((m) => m.role === "assistant").pop();

    // 1. LA RIGA ESISTE E NON È PIÙ "IN CORSO". Il turno è chiuso, non appeso.
    expect(assistente).toBeDefined();
    expect(assistente!.partial).toBeFalsy();

    // 2. IL LAVORO GIÀ FATTO È SALVO. La prosa scritta prima dello spegnimento
    //    resta leggibile: è il difetto n.5, quello che perdeva il testo dei
    //    giri precedenti.
    const prosa = (assistente!.blocks ?? [])
      .filter((b) => b.kind === "text")
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("");
    expect(prosa).toContain("Ho capito il richiamo");

    // 3. E C'È LA SPIEGAZIONE, arrivata fin qui dal `stop()` del provider vero.
    //    Senza il blocco `error` il client non disegna né banner né «Riprova»:
    //    è la differenza fra una risposta troncata e una caduta spiegata.
    const cartello = (assistente!.blocks ?? []).find((b) => b.kind === "error");
    expect(cartello).toBeDefined();
    expect(cartello && cartello.kind === "error" ? cartello.text : "").toContain("riavviato");
  }, 30_000);
});
