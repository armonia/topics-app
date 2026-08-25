/**
 * LA SONDA DELLE CAPACITÀ RICORDA IL SÌ, DIMENTICA IL NO.
 *
 * Segnalato: «in locale non funziona il microfono su questo input».
 *
 * La causa non era la UI né il motore. Misurato sull'istanza viva:
 * `POST /api/stt` trascrive in 5,2s con whisper.cpp, e `/api/stt/capabilities`
 * su loopback risponde 200. Via rete però risponde **401 device not paired**,
 * perché sta dietro l'identità — ed è la risposta giusta finché il dispositivo
 * non è dentro.
 *
 * Il difetto era la MEMORIA: la promessa veniva ricordata anche quando
 * falliva, quindi quel 401 diventava la risposta definitiva della sessione.
 * `isSupported` restava falso, il bottone del microfono non si disegnava
 * affatto, e nessun gesto poteva farlo tornare: solo un ricarico della pagina.
 *
 * Ricordare il sì e dimenticare il no costa al massimo una fetch in più per
 * pannello mentre il dispositivo non è ancora dentro. Il contrario costa la
 * funzione, in silenzio, fino al prossimo ricarico.
 *
 * @covers CHAT-04
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { fetchSttCapabilities, forgetSttCapabilities } from "../../client/src/lib/stt";

const vero = globalThis.fetch;
let chiamate = 0;

/** Un server che risponde come quello vero, con lo stato che gli si dice. */
function serve(stato: number, corpo?: unknown) {
  chiamate = 0;
  globalThis.fetch = (async () => {
    chiamate += 1;
    return new Response(corpo ? JSON.stringify(corpo) : "", {
      status: stato,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const CAPACE = { available: true, provider: "elevenlabs", model: "scribe_v2", providers: [], language: null };

describe("la sonda STT non si porta dietro un no", () => {
  beforeEach(() => { forgetSttCapabilities(); });
  afterEach(() => { globalThis.fetch = vero; forgetSttCapabilities(); });

  it("un 401 NON diventa la risposta della sessione", () => {
    // È il caso vero: un dispositivo appena arrivato in rete riceve
    // `device not paired` finché l'accoppiamento non è concluso.
    serve(401, { error: "device not paired" });
    return fetchSttCapabilities().then(async (uno) => {
      expect(uno.available).toBe(false);
      // La seconda domanda deve arrivare al server, non a una memoria.
      serve(200, CAPACE);
      const due = await fetchSttCapabilities();
      expect(due.available, "dopo l'accoppiamento il microfono deve tornare").toBe(true);
      expect(chiamate, "la seconda domanda dev'essere andata in rete").toBe(1);
    });
  });

  it("un SÌ invece si ricorda: dieci pannelli, una fetch", async () => {
    // La memoria esiste per una ragione misurata: ogni ChatPane monta la
    // dettatura, e senza aprire dieci topic significava dieci richieste
    // identiche allo stesso endpoint di configurazione.
    serve(200, CAPACE);
    for (let i = 0; i < 10; i += 1) await fetchSttCapabilities();
    expect(chiamate, "un sì si chiede una volta sola").toBe(1);
  });

  it("anche una rete giù si dimentica", async () => {
    chiamate = 0;
    globalThis.fetch = (async () => { chiamate += 1; throw new Error("offline"); }) as unknown as typeof fetch;
    expect((await fetchSttCapabilities()).available).toBe(false);
    serve(200, CAPACE);
    expect((await fetchSttCapabilities()).available).toBe(true);
  });

  it("forgetSttCapabilities dimentica anche un sì", async () => {
    // Serve a chi SA che qualcosa è cambiato (l'accoppiamento è appena
    // riuscito) invece di aspettare un tentativo naturale, che vorrebbe dire
    // aspettare che l'utente riapra un pannello.
    serve(200, CAPACE);
    await fetchSttCapabilities();
    expect(chiamate).toBe(1);
    forgetSttCapabilities();
    await fetchSttCapabilities();
    expect(chiamate, "dopo la dimenticanza si torna a chiedere").toBe(2);
  });
});
