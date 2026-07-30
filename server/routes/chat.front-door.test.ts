/**
 * LA PORTA D'INGRESSO DI `POST /api/chat`: chi entra, chi viene respinto.
 *
 * Due guasti veri, entrambi sulle prime venti righe dell'handler.
 *
 * 1. **Nessun cancello sulla concorrenza.** Era l'unica route mutante di
 *    sessione senza: `edit.ts:308` e `branches.ts:29` rispondono già 409 su
 *    stream attivo. Due POST sulla stessa sessione (due finestre sullo stesso
 *    topic, o l'umano che scrive mentre un task dispatchato lavora nella sua
 *    topic) finivano entrambe in `startStream`, che SOVRASCRIVE la voce di
 *    `activeStreams`: il `finally` del primo turno chiudeva il secondo, con il
 *    messageId sbagliato. E il ramo `is409` del client (`useChat.ts`), scritto
 *    per accodare in testa e rispedire a fine turno, era codice morto: nessun
 *    409 su /api/chat esisteva in tutto il server.
 *
 * 2. **`mode: "reattach"` respinto con 400.** Manda `messages: []` per
 *    costruzione — non porta un messaggio, adotta il turno che sta già girando
 *    nel broker dopo un riavvio. La validazione `messages.length === 0` lo
 *    buttava fuori, e il chiamante (`runHeadlessReattach`) drenava quel JSON
 *    come se fosse SSE riportando `end_turn`: un turno mai iniziato,
 *    dichiarato finito bene.
 *
 * Si testa la PORTA, non il turno: tutti i casi qui sotto tornano prima di
 * toccare provider, DB o stream. Il caso che passa il cancello lo si riconosce
 * dal fatto che chiama `appendLocalMessage` — l'effetto immediatamente
 * successivo, e la ragione per cui il 409 deve stare PRIMA (altrimenti il
 * messaggio respinto resterebbe comunque scritto in chat).
 */
import { test, expect, describe } from "bun:test";
import { createChatRouter } from "./chat";
import type { AppContext } from "../types";

interface Harness {
  post: (body: unknown) => Promise<Response | null>;
  /**
   * Come `post`, ma dice ANCHE se la richiesta è andata OLTRE la porta: il
   * cancello risponde con una `Response` pulita, mentre il turno vero muore
   * subito dopo su `resolveProvider`, che questo finto contesto non ha. È
   * l'unico modo di provare che il reattach passa — non scrive nessun
   * messaggio, quindi non lascia traccia in `appended`.
   */
  attempt: (body: unknown) => Promise<{ status?: number; wentDeeper: boolean }>;
  appended: string[];
  streaming: Map<string, { messageId: string }>;
}

function harness(): Harness {
  const appended: string[] = [];
  const streaming = new Map<string, { messageId: string }>();

  const ctx = {
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    getTopicBySessionKey: () => undefined,
    isStreaming: (sessionKey: string) => streaming.get(sessionKey),
    appendLocalMessage: (sessionKey: string, _role: string, content: string) => {
      appended.push(`${sessionKey}:${content}`);
      // Oltre questo punto il test non arriva: il turno vero vuole un provider.
      throw new Error("STOP_AFTER_APPEND");
    },
  } as unknown as AppContext;

  const deps = { browserNavigatedTopics: new Set<string>() } as never;
  const router = createChatRouter(ctx, deps);

  const post = async (body: unknown) => {
    const url = new URL("http://localhost/api/chat");
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return router(req, url, "/api/chat", "POST");
  };

  return {
    appended,
    streaming,
    post,
    attempt: async (body: unknown) => {
      try {
        const resp = await post(body);
        return { status: resp?.status, wentDeeper: false };
      } catch {
        return { wentDeeper: true };
      }
    },
  };
}

describe("POST /api/chat — la porta d'ingresso", () => {
  test("un turno già in volo sulla stessa sessione ⇒ 409, e il messaggio NON viene scritto in chat", async () => {
    const h = harness();
    h.streaming.set("topic:abc", { messageId: "msg-in-volo" });

    const resp = await h.post({ sessionKey: "topic:abc", messages: [{ role: "user", content: "ciao" }] });

    expect(resp?.status).toBe(409);
    const body = await resp!.json();
    expect(body.code).toBe("stream_in_flight");
    // Il client accoda in testa e rispedisce a fine turno: per farlo deve
    // sapere che è un rifiuto, non un guasto.
    expect(body.messageId).toBe("msg-in-volo");
    // Il punto del PRIMA: respinto e non scritto. Se il cancello stesse dopo
    // `appendLocalMessage`, il messaggio comparirebbe in chat come spedito e
    // poi ne partirebbe un secondo dalla coda — lo stesso testo due volte.
    expect(h.appended).toEqual([]);
  });

  test("sessione libera ⇒ il turno passa il cancello (e il messaggio viene scritto)", async () => {
    const h = harness();

    await h.post({ sessionKey: "topic:abc", messages: [{ role: "user", content: "ciao" }] }).catch(() => null);

    expect(h.appended).toEqual(["topic:abc:ciao"]);
  });

  test("uno stream su UN'ALTRA sessione non blocca questa", async () => {
    const h = harness();
    h.streaming.set("topic:altra", { messageId: "msg-altrove" });

    await h.post({ sessionKey: "topic:abc", messages: [{ role: "user", content: "ciao" }] }).catch(() => null);

    expect(h.appended).toEqual(["topic:abc:ciao"]);
  });

  test("`mode: reattach` entra con `messages` VUOTO — è il suo formato, non un errore", async () => {
    const h = harness();

    const out = await h.attempt({ sessionKey: "topic:abc", messages: [], mode: "reattach" });

    // Prima si fermava qui con 400 «messages array required», e l'adozione dei
    // turni sopravvissuti a un riavvio non partiva MAI. Ora prosegue fino alla
    // risoluzione del provider — cioè è oltre la porta.
    expect(out).toEqual({ wentDeeper: true });
  });

  test("`mode: reattach` è esente dal cancello anche con uno stream attivo", async () => {
    const h = harness();
    h.streaming.set("topic:abc", { messageId: "msg-in-volo" });

    const out = await h.attempt({ sessionKey: "topic:abc", messages: [], mode: "reattach" });

    // Adottare il turno VIVO è il mestiere del reattach: il 409 lo fermerebbe
    // proprio nell'unico caso in cui serve.
    expect(out).toEqual({ wentDeeper: true });
  });

  test("`messages` vuoto SENZA reattach resta 400", async () => {
    const h = harness();

    const resp = await h.post({ sessionKey: "topic:abc", messages: [] });

    expect(resp?.status).toBe(400);
  });

  test("`messages` assente resta 400", async () => {
    const h = harness();

    const resp = await h.post({ sessionKey: "topic:abc" });

    expect(resp?.status).toBe(400);
  });
});
