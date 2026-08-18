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

/**
 * `provider` inietta il provider che `resolveProvider` restituirà. Serve alle
 * due prove sul riattacco: la porta deve saper distinguere un provider che sa
 * riattaccarsi da uno che non lo sa, e quella distinzione è l'unica cosa che
 * separa «adotto il turno vivo» da «fabbrico un turno che nessuno ha chiesto».
 */
function harness(opts?: { provider?: Record<string, unknown> }): Harness {
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

  const deps = {
    browserNavigatedTopics: new Set<string>(),
    ...(opts?.provider ? { resolveProvider: () => opts.provider } : {}),
  } as never;
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

  /**
   * IL RIATTACCO NON DEVE MAI DIVENTARE UN INVIO.
   *
   * Il guasto, misurato il 2026-08-18 su topic:9fe7a291. Il turno vero girava
   * su `claude-code` (figlio CLI vivo nello store del broker). A ogni riavvio
   * del server — una ventina, perché un'altra sessione stava salvando file in
   * `server/` con `TOPICS_SERVER_WATCH=1` — il setaccio di boot chiamava
   * `runHeadlessReattach`, che POSTava `{messages: [], mode:"reattach"}` SENZA
   * dichiarare il provider. `resolveProvider` cadeva sul default della
   * macchina, che qui è il runtime nativo `topics`; quello non ha `reattach`;
   * e il ternario di `drive` ripiegava su `sendChat` con `userContent` = solo
   * il preambolo `<context>` e nessuna domanda.
   *
   * Risultato: nove turni FABBRICATI, pagati all'API, uno per riavvio, ognuno
   * con un «Ciao! Come posso aiutarti con la valutazione del lavoro di
   * Giovanni?» (il nome del topic — l'unica cosa che quel modello vedeva) che
   * si sedeva in chat al posto della risposta vera. La risposta vera, 2.396
   * caratteri di verdetto documentato, non è mai arrivata in `messages`: è
   * rimasta solo nel JSONL della CLI.
   *
   * Due cose lo permettevano insieme: il ripiego silenzioso, e il fatto che
   * `isReattach` salta il cancello 409 (giustamente — adottare il turno vivo è
   * il suo mestiere), quindi il turno fantasma partiva su una sessione che ne
   * aveva già uno in volo.
   */
  test("riattacco su un provider che NON sa riattaccarsi ⇒ 501, e nessun messaggio inviato", async () => {
    let sendChatCalls = 0;
    const h = harness({
      provider: {
        name: "topics",
        capabilities: new Set(["streaming"]),
        connected: true,
        // Nessun `reattach`: è il runtime nativo.
        sendChat: () => { sendChatCalls++; return Promise.resolve({}); },
      },
    });

    const resp = await h.post({ sessionKey: "topic:abc", messages: [], mode: "reattach" });

    expect(resp?.status).toBe(501);
    const body = await resp!.json();
    expect(body.code).toBe("reattach_unsupported");
    expect(body.provider).toBe("topics");
    // Il punto dell'intera prova: non è partita nessuna chiamata al modello.
    expect(sendChatCalls).toBe(0);
    // E nessuna riga in chat: il rifiuto arriva prima della riga parziale.
    expect(h.appended).toEqual([]);
  });

  test("riattacco su un provider che SA riattaccarsi passa la porta", async () => {
    const h = harness({
      provider: {
        name: "claude-code",
        capabilities: new Set(["streaming"]),
        connected: true,
        reattach: () => Promise.resolve("live"),
        sendChat: () => Promise.resolve({}),
      },
    });

    const out = await h.attempt({ sessionKey: "topic:abc", messages: [], mode: "reattach" });

    // La guardia non deve trasformarsi in un muro: il caso per cui il riattacco
    // esiste — il provider giusto, quello che possiede il turno vivo — passa.
    expect(out.status).not.toBe(501);
  });
});
