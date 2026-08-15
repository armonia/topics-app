import { test, expect } from "@playwright/test";
import { E2E_BASE, E2E_TUNNEL_BASE, E2E_WS_BASE, tunnelPortFor, E2E_PORT } from "./helpers/test-server";
import { createTopic } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";
import { ospite, daOspite } from "./helpers/ospite";
import { alzaRelayE2E, type RelayE2E } from "./helpers/relay-e2e";
import { WS_PONTE_GIU } from "../../relay/src/ponte";
import { SESSION_COOKIE } from "../../server/lib/device-auth";
import { openSocket } from "./helpers/node-websocket";

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
  const ws = openSocket(`${E2E_WS_BASE}/ws`);
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

/**
 * ── DAL BROWSER, SENZA NESSUN CLIENT SPECIALE ───────────────────────────────
 *
 * I quattro test qui sopra entrano nel tubo con un capo che il tubo lo sa
 * parlare (`creaOspiteHttp`/`creaOspiteWs`). È la prova che il protocollo
 * regge, e non è la prova che il prodotto sia RAGGIUNGIBILE: un telefono
 * davanti a `relay.topics.armonia.io` non ha in mano nessun capo, ha una barra
 * degli indirizzi. Finché la traduzione non esisteva, tutto ciò che è provato
 * sopra non serviva a nessuno.
 *
 * Questi partono da una `Request` e finiscono in una `Response` — le due cose
 * che un browser sa fare e le uniche che gli si possono chiedere. In mezzo c'è
 * il PONTE del Worker (`relay/src/ponte.ts`), il relay finto che instrada e non
 * capisce, il client della macchina che rigioca contro l'ascoltatore dedicato,
 * e il server di test vero in fondo. Il Worker non si deploya: quello è un
 * passo umano, separato.
 */
test.describe("Dal browser, per la porta d'ingresso", () => {
  let relay: RelayE2E;

  test.beforeEach(() => {
    relay = alzaRelayE2E(tunnelPortFor(E2E_PORT));
  });
  test.afterEach(() => {
    relay?.chiudi();
  });

  /** Una richiesta come la scriverebbe un telefono: un URL del relay, e basta. */
  const dalTelefono = (percorso: string, extra: RequestInit = {}) =>
    new Request(relay.indirizzo(percorso), extra);

  test("RELAY-E2E-06: una GET normale torna 200 col corpo giusto, e l'ospite resta l'ospite", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "RELAY-E2E-06" });
    const stamp = Date.now();
    const condivisa = await createTopic(request, `E2E-Ponte-Vista-${stamp}`);
    const nascosta = await createTopic(request, `E2E-Ponte-Nascosta-${stamp}`);
    const { cookie, deviceId } = await ospite(request, `ponte-06-${stamp}`);
    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "topic", resourceId: condivisa.id },
    });

    // 1. IL CONTROLLO POSITIVO, e insieme la cosa che mancava: una richiesta
    //    HTTPS qualunque entra e ne esce una `Response` qualunque.
    const res = await relay.dalBrowser(dalTelefono(`/api/topics/${condivisa.id}/messages`, {
      headers: { cookie },
    }));
    expect(res.status, "una chat condivisa si legge dal ponte con una GET normale").toBe(200);

    // 2. …e il corpo è QUELLO, non un corpo qualsiasi: si confronta con ciò che
    //    lo stesso ospite otterrebbe bussando dritto alla porta del tunnel. È
    //    la sola forma di «giusto» che non sia una ripetizione del codice.
    const dritto = await request.get(`${E2E_TUNNEL_BASE}/api/topics/${condivisa.id}/messages`, {
      headers: daOspite(cookie),
    });
    expect(dritto.status()).toBe(200);
    const dalPonte = await res.text();
    expect(dalPonte, "il corpo dal ponte deve essere identico a quello dalla porta").toBe(await dritto.text());
    expect(() => JSON.parse(dalPonte) as unknown, "e deve restare JSON intero").not.toThrow();
    expect(res.headers.get("content-type") ?? "", "anche le intestazioni tornano indietro").toContain("json");

    // 3. E il CONFINAMENTO non cambia per essere passati dal ponte. Il peer che
    //    la macchina vede è `127.0.0.1` — cioè questo è esattamente il caso in
    //    cui un confine scritto male aprirebbe tutto.
    const altrui = await relay.dalBrowser(dalTelefono(`/api/topics/${nascosta.id}/messages`, {
      headers: { cookie },
    }));
    expect([403, 404], "una chat non condivisa resta chiusa anche dal ponte").toContain(altrui.status);

    const lista = await relay.dalBrowser(dalTelefono("/api/topics", { headers: { cookie } }));
    expect(lista.status, "dal ponte non si diventa il padrone di casa").toBe(403);

    const nudo = await relay.dalBrowser(dalTelefono("/api/topics"));
    expect(nudo.status, "senza identità, dal ponte, non si entra").toBe(401);

    // 4. …e non si scrive. Il rifiuto va guardato anche dalla porta del
    //    proprietario: un 403 su una scrittura già avvenuta sarebbe verde.
    const patch = await relay.dalBrowser(dalTelefono(`/api/topics/${condivisa.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: `E2E-Ponte-Rinominata-${stamp}` }),
    }));
    expect(patch.status, "PATCH dal ponte è rifiutata").toBe(403);

    const creazione = await relay.dalBrowser(dalTelefono("/api/topics", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: `E2E-Ponte-Abusiva-${stamp}` }),
    }));
    expect(creazione.status, "creare qualcosa di nuovo dal ponte è rifiutato").toBe(403);

    const tutte = await request.get(`${E2E_BASE}/api/topics`);
    const { topics } = (await tutte.json()) as { topics: Record<string, { name: string }> };
    expect(topics[condivisa.id]?.name, "il nome della chat non deve essere cambiato").toBe(condivisa.name);
    expect(
      JSON.stringify(topics).includes(`E2E-Ponte-Abusiva-${stamp}`),
      "e la chat che l'ospite ha provato a creare non deve esistere",
    ).toBe(false);
  });

  test("RELAY-E2E-07: un corpo grande si spezza e torna intero", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "RELAY-E2E-07" });
    const stamp = Date.now();
    const condivisa = await createTopic(request, `E2E-Ponte-Grande-${stamp}`);
    const { cookie, deviceId } = await ospite(request, `ponte-07-${stamp}`);
    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "topic", resourceId: condivisa.id },
    });

    // La `sessionKey` è l'unico modo per seminare messaggi in quella chat, e
    // si legge solo dalla porta del proprietario.
    const elenco = await request.get(`${E2E_BASE}/api/topics`);
    const { topics } = (await elenco.json()) as { topics: Record<string, { sessionKey?: string }> };
    const sessionKey = topics[condivisa.id]?.sessionKey;
    expect(sessionKey, "senza sessionKey non si può seminare il corpo grande").toBeTruthy();

    // Un frame porta 96 KiB (`TUBO_BYTE_PER_FRAME`): tre messaggi da 120 KiB
    // fanno un corpo che NON può tornare in un pezzo solo. I due estremi sono
    // marcati, così «è tornato intero» non vuol dire «è tornato lungo uguale».
    const PEZZA = "x".repeat(120 * 1024);
    for (const dove of ["primo", "mezzo", "ultimo"]) {
      await seedMessage(request, {
        sessionKey: sessionKey!,
        role: "assistant",
        content: `[${dove}-${stamp}]${PEZZA}[fine-${dove}-${stamp}]`,
      });
    }

    const res = await relay.dalBrowser(dalTelefono(`/api/topics/${condivisa.id}/messages`, {
      headers: { cookie },
    }));
    expect(res.status).toBe(200);
    const corpo = await res.text();

    // CONTROLLO POSITIVO sul fatto che si sia DAVVERO spezzato. Senza, questo
    // test resterebbe verde su un corpo da due righe e non proverebbe niente
    // del riassemblaggio.
    const pezzi = relay.framePonte.filter((x) => x.verso === "risponde" && x.f.f === "data");
    expect(pezzi.length, "un corpo più grande di un frame deve arrivare a pezzi").toBeGreaterThan(1);

    // …e rimesso insieme. Byte per byte con ciò che si ottiene dalla porta del
    // tunnel: è l'unica definizione di «intero» che non ricopia il codice.
    const dritto = await request.get(`${E2E_TUNNEL_BASE}/api/topics/${condivisa.id}/messages`, {
      headers: daOspite(cookie),
    });
    expect(dritto.status()).toBe(200);
    const atteso = await dritto.text();
    expect(corpo.length, "la misura deve coincidere").toBe(atteso.length);
    expect(corpo, "e il contenuto pure").toBe(atteso);
    expect(corpo.includes(`[primo-${stamp}]`), "il primo pezzo deve esserci").toBe(true);
    expect(corpo.includes(`[fine-ultimo-${stamp}]`), "e l'ultimo anche").toBe(true);
    expect(corpo.length, "il corpo deve superare la misura di un frame").toBeGreaterThan(96 * 1024);
  });

  test("RELAY-E2E-08: un WebSocket aperto dal browser consegna nei due versi", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "RELAY-E2E-08" });
    const stamp = Date.now();
    const condivisa = await createTopic(request, `E2E-Ponte-WS-${stamp}`);
    const nascosta = await createTopic(request, `E2E-Ponte-WS-Nascosta-${stamp}`);
    const { cookie, deviceId } = await ospite(request, `ponte-08-${stamp}`);
    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "topic", resourceId: condivisa.id },
    });

    const padrone = osservatorePadrone();
    const sk = await relay.socketDalBrowser(dalTelefono("/ws", {
      headers: { cookie, upgrade: "websocket", connection: "Upgrade" },
    }));

    try {
      await padrone.pronto;

      // 1. L'UPGRADE è andato a buon fine: `101` e non una pagina di guasto.
      expect(sk.stato, "l'upgrade dal browser deve aprirsi").toBe(101);

      // 2. MACCHINA → BROWSER. `welcome` è la stretta di mano dell'app, ed è
      //    l'unico frame che arriva SEMPRE.
      expect(
        await sk.attendi((f) => f.includes('"welcome"')),
        "un frame della macchina deve arrivare fino al browser",
      ).toBe(true);

      // 3. BROWSER → MACCHINA, e ritorno. `ping`/`pong` è il solo giro che
      //    dipende da ciò che il browser manda e da nient'altro: se il verso
      //    di andata non arrivasse, il `pong` non esisterebbe.
      expect(sk.manda(JSON.stringify({ type: "ping" })), "il socket deve accettare il frame").toBe(true);
      expect(
        await sk.attendi((f) => f.includes('"pong"')),
        "la risposta a ciò che il browser ha mandato deve tornare indietro",
      ).toBe(true);

      // 4. E il confinamento regge anche su questo socket: si muovono tutte e
      //    due le chat, il proprietario da loopback DEVE vedere passare quella
      //    nascosta (senza, il controllo dopo non prova niente) e il browser no.
      for (const t of [condivisa, nascosta]) {
        await request.patch(`${E2E_BASE}/api/topics/${t.id}`, { data: { name: `${t.name}-mossa` } });
      }
      expect(
        await padrone.attendi((f) => f.includes(nascosta.id)),
        "il proprietario da loopback deve vedere passare la chat nascosta",
      ).toBe(true);
      expect(
        sk.frame.join("\n").includes(nascosta.id),
        "l'id di una chat NON condivisa non deve comparire in nessun frame consegnato al browser",
      ).toBe(false);
    } finally {
      padrone.chiudi();
      sk.chiudi();
    }
  });

  test("RELAY-E2E-09: senza macchina si risponde 503, non ci si appende", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "RELAY-E2E-09" });
    const stamp = Date.now();
    const condivisa = await createTopic(request, `E2E-Ponte-Spenta-${stamp}`);
    const { cookie, deviceId } = await ospite(request, `ponte-09-${stamp}`);
    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "topic", resourceId: condivisa.id },
    });

    // CONTROLLO POSITIVO: finché la macchina è collegata, la stessa identica
    // richiesta torna 200. Senza, il 503 di dopo sarebbe indistinguibile da un
    // ponte che non ha mai funzionato.
    const prima = await relay.dalBrowser(dalTelefono(`/api/topics/${condivisa.id}/messages`, {
      headers: { cookie },
    }));
    expect(prima.status, "con la macchina collegata si legge").toBe(200);

    // …e un socket vivo, che dopo dovrà morire DICENDO perché.
    const sk = await relay.socketDalBrowser(dalTelefono("/ws", {
      headers: { cookie, upgrade: "websocket", connection: "Upgrade" },
    }));
    expect(sk.stato).toBe(101);
    expect(await sk.attendi((f) => f.includes('"welcome"')), "il socket deve essere vivo davvero").toBe(true);
    expect(sk.chiusura(), "e non ancora chiuso").toBeNull();

    // Cade la rete di casa.
    relay.spegniMacchina();

    // 1. La richiesta nuova si RIFIUTA, e in fretta: la scadenza del ponte è
    //    mezzo minuto, quindi «prima di cinque secondi» distingue una risposta
    //    da un'attesa che finisce per scadenza.
    const inizio = Date.now();
    const dopo = await relay.dalBrowser(dalTelefono(`/api/topics/${condivisa.id}/messages`, {
      headers: { cookie },
    }));
    expect(dopo.status, "senza macchina collegata si risponde 503").toBe(503);
    expect(Date.now() - inizio, "e si risponde subito, invece di aspettare la scadenza").toBeLessThan(5_000);
    expect(await dopo.text(), "con una frase che si legge, non con una pagina vuota").toContain("not connected");

    // 2. …e il socket che era vivo si chiude DICENDO perché. Restare aperto
    //    verso una macchina che non c'è più somiglia a funzionare, ed è il modo
    //    peggiore di guastarsi.
    expect(sk.chiusura()?.c, "il socket deve chiudersi col codice dell'installazione offline").toBe(WS_PONTE_GIU);
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
