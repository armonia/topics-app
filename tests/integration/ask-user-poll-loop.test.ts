/**
 * L'anello COMPLETO della domanda all'umano, senza UI e senza CLI:
 *
 *   callAskUserQuestion (il bridge MCP, quello vero)
 *     → POST /api/sessions/:key/ask-user (il route vero, via createTopicsRouter)
 *       → ask-user-bridge
 *         ← deliverAnswer, come fa /api/chat/tool-response quando l'umano clicca
 *
 * Serve perché il difetto che ha rotto la prima domanda vera non stava in
 * nessuno dei due pezzi presi da soli: stava nella GIUNTURA. Il bridge teneva
 * una sola richiesta HTTP aperta per minuti a byte zero, un idle timeout la
 * uccideva dal lato client, e il modello riprendeva con un errore che nessuno
 * aveva scelto. Qui la risposta arriva DOPO che almeno una gamba è scaduta —
 * cioè esattamente sopra la giuntura che si era rotta.
 *
 * Le gambe sono da 150 ms invece dei 25 s di produzione: la lunghezza la decide
 * il chiamante (`legMs`), quindi il test percorre la stessa strada del vivo a
 * velocità di test.
 *
 * @covers ASK-02
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";

const TEST_DATA = testTmpDir("ask-poll-data");
const LEG_MS = 150;

beforeAll(() => setupTestDataDir(TEST_DATA));

/**
 * Un `fetch` che invece di uscire in rete entra nel router vero. Così il bridge
 * gira invariato — stessi header, stesso body, stesso parsing della risposta.
 */
function routerFetch(router: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    const url = new URL(req.url);
    const resp = await router(req, url, url.pathname, req.method);
    return resp ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("ask_user_question — anello bridge ⇄ route", () => {
  test("la risposta arriva dopo che una gamba è già scaduta, e il tool la restituisce", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const { deliverAnswer, hasPendingAsk } = await import("../../server/lib/ask-user-bridge");
    const { callAskUserQuestion } = await import("../../server/mcp/topics-mcp-server");

    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    const sessionKey = "topic:ask-loop";

    const legs: number[] = [];
    const counting = routerFetch(async (...a) => { legs.push(1); return router(...a); });

    const questions = [{
      question: "Cosa affrontiamo adesso?",
      header: "Prossimo",
      options: [{ label: "Coda review" }, { label: "Divari chat" }],
    }];

    const asked = callAskUserQuestion(
      { baseUrl: "http://h", sessionKey },
      { questions },
      counting,
      { legMs: LEG_MS },
    );

    // L'umano legge. Nel frattempo passano più gambe: nessuna di queste deve
    // chiudere la domanda.
    await new Promise((r) => setTimeout(r, LEG_MS * 3));
    expect(legs.length).toBeGreaterThan(1);
    // …e per tutto quel tempo il pannello risulta a schermo, anche nei buchi fra
    // una gamba e l'altra (è ciò che tiene buono il watchdog del turno).
    expect(hasPendingAsk(sessionKey)).toBe(true);

    // Ora clicca: è la stessa chiamata che fa /api/chat/tool-response.
    expect(deliverAnswer(sessionKey, { "Cosa affrontiamo adesso?": "Coda review" })).toBe(true);

    const text = await asked;
    expect(JSON.parse(text)).toEqual({ answers: { "Cosa affrontiamo adesso?": "Coda review" } });
    expect(hasPendingAsk(sessionKey)).toBe(false);
  });

  test("una domanda annullata diventa un errore del tool, mai una risposta inventata", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const { cancelAsk } = await import("../../server/lib/ask-user-bridge");
    const { callAskUserQuestion } = await import("../../server/mcp/topics-mcp-server");

    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    const sessionKey = "topic:ask-cancel";

    const asked = callAskUserQuestion(
      { baseUrl: "http://h", sessionKey },
      { questions: [{ question: "Q?", header: "Q", options: [{ label: "A" }, { label: "B" }] }] },
      routerFetch(router),
      { legMs: LEG_MS },
    );

    await new Promise((r) => setTimeout(r, LEG_MS / 2));
    cancelAsk(sessionKey, "turn aborted"); // l'umano preme Stop

    await expect(asked).rejects.toThrow(/cancelled.*turn aborted/i);
  });

  test("il route rifiuta una domanda vuota invece di far bloccare il bridge", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);

    const url = new URL("http://h/api/sessions/topic%3Aempty/ask-user");
    const resp = (await router(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questions: [] }),
      }),
      url,
      url.pathname,
      "POST",
    ))!;
    expect(resp.status).toBe(400);
    expect((await resp.json() as { error: string }).error).toMatch(/questions/i);
  });
});
