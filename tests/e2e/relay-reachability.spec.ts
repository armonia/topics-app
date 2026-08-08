import { test, expect } from "@playwright/test";
import { E2E_BASE, E2E_WS_BASE, tunnelPortFor, E2E_PORT } from "./helpers/test-server";
import { createTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { ospite, daOspite } from "./helpers/ospite";
import { alzaRelayE2E, type RelayE2E } from "./helpers/relay-e2e";
import { SESSION_COOKIE } from "../../server/lib/device-auth";

hermetic(test);

/**
 * DA UN'ALTRA RETE, passando dal relay.
 *
 * ── COSA PROVA CHE `guest-confinement.spec.ts` NON PROVA ────────────────────
 * Quello entra dalla porta del tunnel: la prova che il confine esiste. Questo
 * entra dal RELAY — cioè da una sessione vera che attraversa il protocollo,
 * viene rigiocata dal proxy contro `127.0.0.1:<TOPICS_TUNNEL_PORT>` e torna
 * indietro a pezzi. È l'unica forma in cui il prodotto è raggiungibile da fuori
 * casa, e nessuno dei due lati da solo la copre: il tunnel senza relay non è
 * raggiungibile, il relay senza il confine è un modo per far entrare Internet
 * come padrone di casa.
 *
 * La cosa che si vuole vedere è che passare dal relay non cambia NIENTE della
 * postura di fiducia. Il proxy non reimplementa niente: rigioca. Quindi un
 * ospite che arriva dal relay deve essere lo stesso ospite di prima — non
 * promosso a proprietario perché il peer è `127.0.0.1` (che è esattamente il
 * rovesciamento che l'ascoltatore dedicato esiste per impedire), e non chiuso
 * fuori da un secondo strato che nessuno ha chiesto.
 *
 * ── DOV'È LA RETE, E DOVE NON C'È ───────────────────────────────────────────
 * Fra i due capi non c'è: al posto del Worker c'è `shared/relay-fake.ts`, che
 * instrada e non capisce. Il Worker vero non si tocca e non si deploya — è un
 * passo umano, separato. Tutto il resto è quello di produzione: il client, il
 * proxy, l'ascoltatore, il database.
 */

/** Un osservatore da LOOPBACK: è il proprietario, e serve come controllo
 *  positivo — senza di lui «l'ospite non ha visto passare X» sarebbe verde
 *  anche se X non fosse mai partito. */
function osservatorePadrone(): {
  frame: string[];
  pronto: Promise<void>;
  chiudi: () => void;
  attendi(p: (f: string) => boolean, ms?: number): Promise<boolean>;
} {
  const frame: string[] = [];
  const ws = new WebSocket(`${E2E_WS_BASE}/ws`);
  const pronto = new Promise<void>((res) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => res());
  });
  ws.addEventListener("message", (e: MessageEvent) => frame.push(String(e.data)));
  return {
    frame,
    pronto,
    chiudi: () => { try { ws.close(); } catch { /* già chiusa */ } },
    async attendi(p, ms = 10_000) {
      const limite = Date.now() + ms;
      while (Date.now() < limite) {
        if (frame.some(p)) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return frame.some(p);
    },
  };
}

test.describe("Raggiungibilità dal relay · l'ospite resta l'ospite", () => {
  let relay: RelayE2E;

  test.beforeEach(() => {
    relay = alzaRelayE2E(tunnelPortFor(E2E_PORT));
  });
  test.afterEach(() => {
    relay?.chiudi();
  });

  test("RELAY-E2E-01: dal relay si legge ciò che è condiviso, e nient'altro", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "RELAY-E2E-01" });
    const stamp = Date.now();
    const condivisa = await createTopic(request, `E2E-Relay-Vista-${stamp}`);
    const nascosta = await createTopic(request, `E2E-Relay-Nascosta-${stamp}`);
    const { cookie, deviceId } = await ospite(request, `relay-01-${stamp}`);
    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "topic", resourceId: condivisa.id },
    });

    // 1. IL CONTROLLO POSITIVO. Un 200 su una risorsa concessa si può ottenere
    //    solo con un biscotto valido che è arrivato fino in fondo: prova in un
    //    colpo il tubo, il rigioco e l'identità ereditata.
    const suo = await relay.chiedi("GET", `/api/topics/${condivisa.id}/messages`, { cookie });
    expect(suo.stato, "una chat condivisa si legge anche passando dal relay").toBe(200);
    expect(() => JSON.parse(suo.corpo) as unknown, "e il corpo torna intero").not.toThrow();

    // La macchina ha davvero visto arrivare una sessione — cioè il 200 è
    // passato dal PROXY e non da qualche scorciatoia del test. Le sessioni
    // nascono al primo aggancio, quindi si guarda dopo la prima richiesta.
    expect(relay.sessioniHost(), "il proxy deve aver registrato l'aggancio").toBeGreaterThan(0);

    // 2. …e il confinamento regge lo stesso. Non è una seconda regola: è la
    //    stessa, ereditata dal rigioco.
    const altrui = await relay.chiedi("GET", `/api/topics/${nascosta.id}/messages`, { cookie });
    expect([403, 404], "una chat non condivisa resta chiusa dal relay").toContain(altrui.stato);

    // 3. La lista intera è roba da proprietari, e dal relay non si è
    //    proprietari — è il rovesciamento che si stava provando a impedire.
    const lista = await relay.chiedi("GET", "/api/topics", { cookie });
    expect(lista.stato, "dal relay non si diventa il padrone di casa").toBe(403);

    // 4. E senza credenziale non si entra affatto: il peer del proxy È
    //    `127.0.0.1`, quindi questo è il caso in cui un confine scritto male
    //    aprirebbe tutto.
    const nudo = await relay.chiedi("GET", "/api/topics");
    expect(nudo.stato, "senza identità, dal relay, non si entra").toBe(401);

    const finto = await relay.chiedi("GET", "/api/topics", { cookie: `${SESSION_COOKIE}=non-esiste-questo-token` });
    expect([401, 403]).toContain(finto.stato);
  });

  test("RELAY-E2E-02: dal relay si legge e basta — la scrittura è rifiutata", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "RELAY-E2E-02" });
    const stamp = Date.now();
    const topic = await createTopic(request, `E2E-Relay-SolaLettura-${stamp}`);
    const { cookie, deviceId } = await ospite(request, `relay-02-${stamp}`);
    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "topic", resourceId: topic.id },
    });

    // Controllo positivo: la stessa risorsa, letta, torna 200. Senza, i tre
    // rifiuti qui sotto sarebbero indistinguibili da un tubo rotto.
    const lettura = await relay.chiedi("GET", `/api/topics/${topic.id}/messages`, { cookie });
    expect(lettura.stato).toBe(200);

    const patch = await relay.chiedi("PATCH", `/api/topics/${topic.id}`, {
      cookie, corpo: JSON.stringify({ name: "rinominata dal relay" }),
    });
    expect(patch.stato, "PATCH su una risorsa condivisa è rifiutata anche dal relay").toBe(403);

    const del = await relay.chiedi("DELETE", `/api/topics/${topic.id}`, { cookie });
    expect(del.stato, "e DELETE pure").toBe(403);

    const creazione = await relay.chiedi("POST", "/api/topics", {
      cookie, corpo: JSON.stringify({ name: `E2E-Relay-Abusiva-${stamp}` }),
    });
    expect(creazione.stato, "creare qualcosa di nuovo dal relay è rifiutato").toBe(403);

    // E il rifiuto non ha lasciato una scrittura a metà: si guarda dalla porta
    // del proprietario, l'unica da cui la lista si vede.
    const tutte = await request.get(`${E2E_BASE}/api/topics`);
    const { topics } = (await tutte.json()) as { topics: Record<string, { name: string }> };
    expect(topics[topic.id], "la chat deve esserci ancora").toBeTruthy();
    expect(topics[topic.id]!.name).toBe(topic.name);
    expect(
      JSON.stringify(topics).includes(`E2E-Relay-Abusiva-${stamp}`),
      "e la chat che l'ospite ha provato a creare non deve esistere",
    ).toBe(false);
  });

  test("RELAY-E2E-03: il WebSocket passa dal relay e consegna, senza consegnare troppo", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "RELAY-E2E-03" });
    const stamp = Date.now();
    const condivisa = await createTopic(request, `E2E-Relay-WS-Vista-${stamp}`);
    const nascosta = await createTopic(request, `E2E-Relay-WS-Nascosta-${stamp}`);
    const { cookie, deviceId } = await ospite(request, `relay-03-${stamp}`);
    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "topic", resourceId: condivisa.id },
    });

    const padrone = osservatorePadrone();
    const sk = await relay.apriSocket("/ws", { cookie });

    try {
      await padrone.pronto;

      // 1. LA STRETTA DI MANO è andata a buon fine ATTRAVERSO il tubo: non è un
      //    dettaglio, è metà del lavoro — un upgrade che non si rigioca lascia
      //    il prodotto senza niente di vivo da fuori rete.
      expect(sk.socket.stato(), "il socket deve risultare aperto dal lato ospite").toBe("aperto");

      // 2. …e consegna un frame. `welcome` è la stretta di mano dell'app, ed è
      //    l'unico frame che arriva SEMPRE: qualunque altro dipenderebbe da
      //    cosa succede sul server mentre il test guarda.
      expect(
        await sk.attendi((f) => f.includes('"welcome"')),
        "un frame deve arrivare fino all'ospite passando dal relay",
      ).toBe(true);

      // 3. Il CONFINAMENTO regge anche qui. Si muovono tutte e due le chat…
      for (const t of [condivisa, nascosta]) {
        await request.patch(`${E2E_BASE}/api/topics/${t.id}`, { data: { name: `${t.name}-mossa` } });
      }

      // …il proprietario DEVE vedere passare quella nascosta (senza questo il
      // controllo dopo non prova niente)…
      expect(
        await padrone.attendi((f) => f.includes(nascosta.id)),
        "il proprietario da loopback deve vedere passare la chat nascosta",
      ).toBe(true);

      // …e l'ospite, sullo stesso evento, no.
      expect(
        sk.frame.join("\n").includes(nascosta.id),
        "l'id di una chat NON condivisa non deve comparire in nessun frame consegnato dal relay",
      ).toBe(false);
    } finally {
      padrone.chiudi();
    }
  });

  test("RELAY-E2E-04: il relay instrada e non capisce", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "RELAY-E2E-04" });
    const stamp = Date.now();
    const condivisa = await createTopic(request, `E2E-Relay-Opaco-${stamp}`);
    const { cookie, deviceId } = await ospite(request, `relay-04-${stamp}`);
    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "topic", resourceId: condivisa.id },
    });

    const r = await relay.chiedi("GET", `/api/topics/${condivisa.id}/messages`, { cookie });
    expect(r.stato).toBe(200);

    // CONTROLLO POSITIVO: quell'id è DAVVERO passato dal relay. Senza questa
    // riga, «non compare nell'involucro» sarebbe verde anche per una richiesta
    // che non è mai partita — l'asserzione che non può fallire.
    expect(
      relay.grezzi.some((g) => g.includes(condivisa.id)),
      "l'id deve essere passato sul filo, altrimenti il controllo dopo è vuoto",
    ).toBe(true);

    // E adesso la promessa: di tutto ciò che è passato, il relay può leggere
    // l'involucro e basta. Il percorso della richiesta — che porta l'id — sta
    // DENTRO `payload`, e da lì non deve uscire.
    const leggibile = JSON.stringify(relay.involucri);
    expect(leggibile.includes(condivisa.id), "l'id non deve comparire in ciò che il relay può leggere").toBe(false);
    expect(leggibile.includes("payload"), "e nessun contenuto deve affacciarsi sull'involucro").toBe(false);
    expect(leggibile.includes(cookie.split("=")[1] ?? "***"), "né il gettone di sessione").toBe(false);

    // …ma l'involucro non è vuoto: il relay instrada, quindi qualcosa deve pur
    // vederla. È il controllo che distingue «opaco» da «non è passato niente».
    expect(
      relay.involucri.some((i) => i.t === "to-host" || i.t === "to-guest"),
      "il relay deve aver instradato buste opache",
    ).toBe(true);

    // E il biscotto continua a funzionare dal relay: l'opacità non è stata
    // ottenuta buttando via la richiesta.
    const ancora = await relay.chiedi("GET", `/api/topics/${condivisa.id}/messages`, { cookie });
    expect(ancora.stato).toBe(200);
    // …mentre chi non ha nulla in mano resta fuori — dallo stesso tubo.
    const senza = await relay.chiedi("GET", `/api/topics/${condivisa.id}/messages`);
    expect([401, 403]).toContain(senza.stato);
  });
});

test.describe("Raggiungibilità dal relay · quando la porta non c'è", () => {
  test("RELAY-E2E-05: senza porta del tunnel il proxy rifiuta invece di indovinare", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "RELAY-E2E-05" });
    const stamp = Date.now();
    const { cookie } = await ospite(request, `relay-05-${stamp}`);

    // `null` = «non configurata». Il rifiuto è DICHIARATO, non un guasto:
    // indovinare la 3333 vorrebbe dire rigiocare sulla porta di cui ogni
    // richiesta è LOCALE, cioè far entrare Internet come padrone di casa.
    const spento = alzaRelayE2E(null);
    try {
      const r = await spento.chiedi("GET", "/api/topics", { cookie });
      expect(r.stato, "senza porta configurata si risponde 503, non si indovina").toBe(503);

      // …e il tubo è vivo lo stesso: il rifiuto è una risposta, non una corsia
      // morta. Senza questa riga, un tubo rotto sarebbe indistinguibile.
      expect(
        spento.involucri.some((i) => i.t === "to-guest"),
        "il 503 deve essere tornato indietro come busta, non come silenzio",
      ).toBe(true);
    } finally {
      spento.chiudi();
    }
  });
});
