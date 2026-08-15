import { test, expect, type APIRequestContext } from "@playwright/test";
import { E2E_BASE, E2E_TUNNEL_BASE } from "./helpers/test-server";
import { createTopic, resetPaneStore } from "./helpers/api-fixtures";
import { goToApp, ensureTopicVisible } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { ospite, daOspite } from "./helpers/ospite";
import { SESSION_COOKIE } from "../../server/lib/device-auth";

hermetic(test);

/**
 * Il confinamento di un ospite, provato da FUORI.
 *
 * ── PERCHÉ NON BASTA LA PORTA PRINCIPALE ────────────────────────────────────
 * Da loopback non è osservabile. La rete anti-lockout della migration 080 fa
 * proprietaria ogni richiesta locale, senza chiedere credenziali — serve, ed è
 * ciò che impedisce a un database di identità corrotto di chiudere fuori il
 * proprietario da casa propria. Ma vuol dire che un test che bussasse a :13334
 * col biscotto di un ospite vedrebbe un PROPRIETARIO, e passerebbe dicendo
 * l'esatto contrario di ciò che voleva dire: il verde peggiore che esista.
 *
 * Quindi si entra dall'ascoltatore dedicato (`TOPICS_TUNNEL_PORT`), che è lo
 * stesso che in produzione sta dietro al tunnel: ciò che arriva lì non è locale
 * per definizione. Non è una scorciatoia per i test — è il confine vero, ed è
 * l'unico modo di provarlo senza aprirne un secondo che poi va tenuto allineato.
 *
 * ── I TRE ASSI, tutti e tre ─────────────────────────────────────────────────
 * Un ospite è confinato su tre dimensioni indipendenti, e ciascuna da sola
 * lascerebbe passare tutto:
 *   ENTITÀ  — vede la topic condivisa, non le altre;
 *   METODO  — legge e basta: qualunque cosa non sia GET/HEAD è rifiutata,
 *             *anche* sulla risorsa che gli è stata concessa;
 *   FRAMI   — la socket non gli consegna gli eventi di ciò che non ha.
 * Il terzo è quello che sfugge: un filtro che dimenticasse i broadcast
 * lascerebbe l'API perfetta e il contenuto in chiaro sul filo.
 */

// `ospite()` e `daOspite()` vivono in `helpers/ospite.ts`: li usa anche lo spec
// che entra dal RELAY, e due riti di appaiamento da tenere d'accordo sarebbero
// uno di troppo.

test.describe("Confinamento dell'ospite", () => {
  test("GUEST-01: vede la topic condivisa e NON le altre", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "GUEST-01" });
    const stamp = Date.now();
    const condivisa = await createTopic(request, `E2E-Guest-Vista-${stamp}`);
    const nascosta = await createTopic(request, `E2E-Guest-Nascosta-${stamp}`);
    const { cookie, deviceId } = await ospite(request, `guest-01-${stamp}`);

    // La LISTA non è filtrata: è negata. Un cancello vede il percorso, non il
    // corpo, quindi un endpoint che restituisce un INSIEME non è filtrabile lì
    // — e filtrarlo nel router sarebbe il buco che c'è già stato una volta.
    // L'inventario di un ospite passa da un'altra porta.
    const lista = await request.get(`${E2E_TUNNEL_BASE}/api/topics`, { headers: daOspite(cookie) });
    expect(lista.status(), "la lista delle chat non è roba da ospiti").toBe(403);

    // Prima di condividere non ha niente. È il caso che conta di più: un
    // inventario vuoto e uno pieno si distinguono solo se si guarda anche il
    // primo.
    const prima = await request.get(`${E2E_TUNNEL_BASE}/api/auth/shared`, { headers: daOspite(cookie) });
    expect(prima.status()).toBe(200);
    expect(JSON.stringify(await prima.json())).not.toContain(condivisa.id);

    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "topic", resourceId: condivisa.id },
    });

    const dopo = await request.get(`${E2E_TUNNEL_BASE}/api/auth/shared`, { headers: daOspite(cookie) });
    const inventario = JSON.stringify(await dopo.json());
    expect(inventario).toContain(condivisa.id);
    expect(inventario, "una topic non condivisa non deve comparire").not.toContain(nascosta.id);

    // E il contenuto: concesso si legge, non concesso no. Il cancello della
    // singola risorsa è un controllo diverso dall'inventario, e va provato a
    // parte — un inventario giusto con un cancello aperto è tutto in chiaro.
    const suo = await request.get(`${E2E_TUNNEL_BASE}/api/topics/${condivisa.id}/messages`, {
      headers: daOspite(cookie),
    });
    expect(suo.status()).toBe(200);
    const altrui = await request.get(`${E2E_TUNNEL_BASE}/api/topics/${nascosta.id}/messages`, {
      headers: daOspite(cookie),
    });
    expect([403, 404]).toContain(altrui.status());
  });

  test("GUEST-02: legge e basta — anche su ciò che gli è stato concesso", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "GUEST-02" });
    const stamp = Date.now();
    const topic = await createTopic(request, `E2E-Guest-SolaLettura-${stamp}`);
    const { cookie, deviceId } = await ospite(request, `guest-02-${stamp}`);
    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "topic", resourceId: topic.id },
    });

    // Concessa: la legge.
    const lettura = await request.get(`${E2E_TUNNEL_BASE}/api/topics/${topic.id}/messages`, {
      headers: daOspite(cookie),
    });
    expect(lettura.status()).toBe(200);

    // La stessa risorsa, con un metodo che scrive: rifiutata. L'asse del METODO
    // è indipendente da quello dell'entità, e senza di lui «condiviso in
    // lettura» vorrebbe dire «può cancellarlo».
    for (const [metodo, corpo] of [
      ["PATCH", { name: "rinominata dall'ospite" }],
      ["DELETE", undefined],
    ] as const) {
      const r = await request.fetch(`${E2E_TUNNEL_BASE}/api/topics/${topic.id}`, {
        method: metodo,
        headers: daOspite(cookie),
        ...(corpo ? { data: corpo } : {}),
      });
      expect(r.status(), `${metodo} su una risorsa condivisa deve essere rifiutata`).toBe(403);
    }

    // E la topic è ancora quella di prima: il rifiuto non ha lasciato una
    // scrittura a metà. Si guarda dalla porta del proprietario, che è l'unica
    // da cui la lista si vede.
    const tutte = await request.get(`${E2E_BASE}/api/topics`);
    // `topics` è una mappa per id, non un array.
    const { topics } = await tutte.json() as { topics: Record<string, { name: string }> };
    const mia = topics[topic.id];
    expect(mia, "la topic deve esserci ancora").toBeTruthy();
    expect(mia!.name).toBe(topic.name);

    // Creare qualcosa di nuovo è rifiutato allo stesso modo: il cancello guarda
    // il metodo, non se la risorsa esiste già.
    const creazione = await request.post(`${E2E_TUNNEL_BASE}/api/topics`, {
      headers: daOspite(cookie),
      data: { name: `E2E-Guest-Abusiva-${stamp}` },
    });
    expect(creazione.status()).toBe(403);
  });

  test("GUEST-03: senza biscotto non entra, e con uno finto nemmeno", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "GUEST-03" });
    // Da fuori, senza credenziale, non si è proprietari: è esattamente il
    // rovesciamento che l'ascoltatore dedicato esiste per impedire.
    const nudo = await request.get(`${E2E_TUNNEL_BASE}/api/topics`);
    expect(nudo.status(), "da fuori e senza identità non si entra").toBe(401);

    const finto = await request.get(`${E2E_TUNNEL_BASE}/api/topics`, {
      headers: daOspite(`${SESSION_COOKIE}=non-esiste-questo-token`),
    });
    expect([401, 403]).toContain(finto.status());

    // E `/__daemon/*`, che è la superficie più forte del server, non si affaccia
    // affatto su questa porta.
    const daemon = await request.post(`${E2E_TUNNEL_BASE}/__daemon/restart-when-idle`);
    expect([401, 403, 404]).toContain(daemon.status());
  });

  test("GUEST-04: la socket non gli consegna i frame di una topic non condivisa", async ({ request, browser }) => {
    test.info().annotations.push({ type: "spec", description: "GUEST-04" });
    const stamp = Date.now();
    const condivisa = await createTopic(request, `E2E-Guest-WS-Vista-${stamp}`);
    const nascosta = await createTopic(request, `E2E-Guest-WS-Nascosta-${stamp}`);
    const { cookie, deviceId } = await ospite(request, `guest-04-${stamp}`);
    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "topic", resourceId: condivisa.id },
    });

    // DUE osservatori sullo stesso evento: il proprietario da loopback e
    // l'ospite dal tunnel. Serve il primo perché senza di lui questo test
    // sarebbe verde anche se il broadcast non partisse affatto — cioè sarebbe
    // un'asserzione che non può fallire, che è il modo tipico in cui una prova
    // di confinamento mente.
    const apri = async (base: string, biscotto?: string) => {
      const ctx = await browser.newContext({ baseURL: base });
      if (biscotto) {
        const eq = biscotto.indexOf("=");
        await ctx.addCookies([{ name: biscotto.slice(0, eq), value: biscotto.slice(eq + 1), url: base }]);
      }
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: "domcontentloaded" });
      // La socket la si tiene aperta A MANO: un ospite non monta
      // l'applicazione, quindi quella dell'app si chiude dopo la stretta di
      // mano e guardare lì darebbe silenzio per il motivo sbagliato.
      await page.evaluate(() => {
        const w = window as unknown as { __frame: string[] };
        w.__frame = [];
        const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
        ws.addEventListener("message", (e) => w.__frame.push(String(e.data)));
      });
      const frames = () => page.evaluate(() => (window as unknown as { __frame: string[] }).__frame);
      await expect.poll(async () => (await frames()).some((f) => f.includes('"welcome"')), { timeout: 10_000 }).toBe(true);
      return { ctx, frames };
    };

    const proprietario = await apri(E2E_BASE);
    const ospiteWs = await apri(E2E_TUNNEL_BASE, cookie);

    try {
      for (const t of [condivisa, nascosta]) {
        await request.patch(`${E2E_BASE}/api/topics/${t.id}`, { data: { name: `${t.name}-mossa` } });
      }

      // CONTROLLO POSITIVO: il proprietario DEVE vedere passare la topic
      // nascosta. Se questo non arriva, il test successivo non prova niente.
      await expect
        .poll(async () => (await proprietario.frames()).join("\n").includes(nascosta.id), { timeout: 10_000 })
        .toBe(true);

      // E l'ospite, sullo stesso evento, no.
      const suo = (await ospiteWs.frames()).join("\n");
      expect(
        suo.includes(nascosta.id),
        "l'id di una topic NON condivisa non deve comparire in nessun frame consegnato all'ospite",
      ).toBe(false);
    } finally {
      await proprietario.ctx.close();
      await ospiteWs.ctx.close();
    }
  });
});

test.describe("Confinamento dell'ospite · scalata di privilegio", () => {
  test("GUEST-05: un ospite non vede passare un appaiamento altrui, e non ne ruba il gettone", async ({ request, browser }) => {
    test.info().annotations.push({ type: "spec", description: "GUEST-05" });
    // LA CATENA, quando era aperta:
    //  1. `ctx.broadcast` manda `auth:pair-requested` con `requestId` e `code`
    //     a OGNI socket, e a differenza di `broadcastToAll` non consulta il
    //     filtro degli ospiti;
    //  2. `/api/auth/pair/status` è esente dall'identità, e il gate
    //     corto-circuita PRIMA di costruirla — quindi su quel percorso il
    //     confinamento non gira affatto;
    //  3. quella rotta consegna il gettone a CHIUNQUE presenti il `requestId`,
    //     una volta sola.
    // Un ospite con un permesso di lettura su una scheda diventava il
    // dispositivo appena approvato — proprietario, se avevi risposto «è mio».
    const stamp = Date.now();
    const { cookie } = await ospite(request, `guest-05-${stamp}`);

    const eq = cookie.indexOf("=");
    const ctx = await browser.newContext({ baseURL: E2E_TUNNEL_BASE });
    await ctx.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: E2E_TUNNEL_BASE }]);
    const page = await ctx.newPage();

    try {
      await page.goto(E2E_TUNNEL_BASE, { waitUntil: "domcontentloaded" });

      // La socket la si tiene aperta A MANO, dentro la pagina. Ascoltare quella
      // dell'app non serve: un ospite non monta l'applicazione, quindi la sua
      // socket si chiude subito dopo la stretta di mano e un test che guardasse
      // lì sarebbe verde perché non è arrivato NIENTE — non perché il filtro
      // funziona. È la differenza fra provare una cosa e non poterla vedere.
      await page.evaluate(() => {
        const w = window as unknown as { __frame: string[] };
        w.__frame = [];
        const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
        ws.addEventListener("message", (e) => w.__frame.push(String(e.data)));
      });
      const frames = () => page.evaluate(() => (window as unknown as { __frame: string[] }).__frame);
      // Viva, non solo creata.
      await expect.poll(async () => (await frames()).some((f) => f.includes('"welcome"')), { timeout: 10_000 }).toBe(true);

      // Un terzo dispositivo chiede di entrare.
      const terzo = await request.post(`${E2E_TUNNEL_BASE}/api/auth/pair/request`, { data: { name: `vittima-${stamp}` } });
      const { requestId } = await terzo.json() as { requestId: string };

      // 1. L'ospite non deve vedere passare né il codice né il riferimento.
      await page.waitForTimeout(2500);
      const visto = (await frames()).join("\n");
      expect(visto.includes(requestId), "il riferimento dell'appaiamento non deve raggiungere un ospite").toBe(false);
      expect(visto.includes("auth:pair-requested"), "l'ospite non deve nemmeno sapere che qualcuno sta entrando").toBe(false);

      // 2. E anche conoscendolo, non deve poterne ritirare il gettone. Il
      //    proprietario approva; poi l'ospite prova a incassare per primo.
      await request.post(`${E2E_BASE}/api/auth/pair/approve`, { data: { requestId } });
      const furto = await request.get(`${E2E_TUNNEL_BASE}/api/auth/pair/status?requestId=${requestId}`, {
        headers: daOspite(cookie),
      });
      expect(
        (furto.headers()["set-cookie"] ?? ""),
        "il gettone non deve uscire verso chi non ha fatto la richiesta",
      ).not.toContain(`${SESSION_COOKIE}=`);
    } finally {
      await ctx.close();
    }
  });
});

/**
 * ── LA SUPERFICIE DELLE CHAT ────────────────────────────────────────────────
 *
 * I casi sopra condividono con un DISPOSITIVO, chiamando l'API a mano. Non è la
 * strada che percorre un utente, e la differenza non è cosmetica: la rubrica di
 * `/api/auth/subjects` offre la PERSONA e non il ferro quando il dispositivo ne
 * ha una — che è sempre, perché «è di un'altra persona» è il gesto che crea un
 * ospite. Quindi ogni condivisione fatta dall'interfaccia atterra su un soggetto
 * `person`, ed è un cammino che nessuno di quei casi tocca.
 *
 * Qui si guarda quello, sulla superficie delle chat, e sui DUE lati che devono
 * dire la stessa cosa: il cancello (posso aprirla?) e l'inventario (la vedo
 * nell'elenco?). Erano due risposte diverse alla stessa domanda.
 */
test.describe("Confinamento dell'ospite · le chat, condivise come lo fa l'interfaccia", () => {
  /** L'id della PERSONA di un ospite, letto dalla rubrica dal lato proprietario.
   *  È il soggetto che il pannello di condivisione offre davvero. */
  async function personaDi(api: APIRequestContext, nome: string): Promise<string> {
    const r = await api.get(`${E2E_BASE}/api/auth/subjects`);
    expect(r.ok(), "la rubrica si legge dal lato proprietario").toBeTruthy();
    const { subjects } = (await r.json()) as {
      subjects: Array<{ subjectType: string; subjectId: string; name: string }>;
    };
    const p = subjects.find((s) => s.subjectType === "person" && s.name === `Persona ${nome}`);
    expect(p, `la persona «Persona ${nome}» deve comparire fra i destinatari`).toBeTruthy();
    return p!.subjectId;
  }

  test("GUEST-06: una chat condivisa con la PERSONA dell'ospite è leggibile E compare nell'inventario", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "GUEST-06" });
    const stamp = Date.now();
    const nome = `guest-06-${stamp}`;
    const condivisa = await createTopic(request, `E2E-Guest-Persona-${stamp}`);
    const nascosta = await createTopic(request, `E2E-Guest-Persona-Nascosta-${stamp}`);
    const { cookie } = await ospite(request, nome);
    const personId = await personaDi(request, nome);

    // Prima: niente. Senza questa lettura un inventario che restituisse sempre
    // tutto sarebbe indistinguibile da uno che funziona.
    const prima = await request.get(`${E2E_TUNNEL_BASE}/api/auth/shared`, { headers: daOspite(cookie) });
    expect(prima.status()).toBe(200);
    expect(JSON.stringify(await prima.json())).not.toContain(condivisa.id);

    const messa = await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "person", subjectId: personId, resourceType: "topic", resourceId: condivisa.id },
    });
    expect(messa.status(), "condividere con una persona deve riuscire").toBe(200);

    // 1. IL CANCELLO. Espande già i principali, quindi questo passava anche
    //    prima: è il controllo positivo che rende leggibile il punto 2.
    const suo = await request.get(`${E2E_TUNNEL_BASE}/api/topics/${condivisa.id}/messages`, {
      headers: daOspite(cookie),
    });
    expect(suo.status(), "il cancello onora una concessione fatta alla persona").toBe(200);

    // 2. L'INVENTARIO. È l'unica porta da cui un ospite SCOPRE cosa ha, e
    //    guardava il solo dispositivo: la chat era apribile per id e invisibile
    //    nell'elenco — «te l'ho condivisa» / «io non vedo niente».
    const dopo = await request.get(`${E2E_TUNNEL_BASE}/api/auth/shared`, { headers: daOspite(cookie) });
    const inventario = JSON.stringify(await dopo.json());
    expect(inventario, "l'inventario deve dire la stessa cosa del cancello").toContain(condivisa.id);
    expect(inventario, "e non allargarsi a ciò che nessuno ha condiviso").not.toContain(nascosta.id);

    // 3. E resta sola lettura: il terzo asse non si allenta perché il soggetto
    //    è una persona invece di un dispositivo.
    const scrittura = await request.patch(`${E2E_TUNNEL_BASE}/api/topics/${condivisa.id}`, {
      headers: daOspite(cookie),
      data: { name: "rinominata dall'ospite" },
    });
    expect(scrittura.status()).toBe(403);
  });

  test("GUEST-07: la condivisione fatta dal pannello sulla CHAT confina come quella fatta a mano", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "GUEST-07" });
    const stamp = Date.now();
    const nome = `guest-07-${stamp}`;
    const condivisa = await createTopic(request, `E2E-Share-Chat-${stamp}`);
    const nascosta = await createTopic(request, `E2E-Share-Chat-Nascosta-${stamp}`);
    const { cookie } = await ospite(request, nome);
    await personaDi(request, nome); // la rubrica deve già offrirla prima di aprire il pannello

    // Una sola tab aperta: il menu contestuale della barra va a colpire QUELLA
    // chat e non un'omonima lasciata da un caso precedente.
    await resetPaneStore(request, [condivisa.id]);
    await goToApp(page);
    await ensureTopicVisible(page, new RegExp(`E2E-Share-Chat-${stamp}$`));

    // Il pannello di condivisione di una chat vive nelle sue impostazioni, che
    // è la superficie raggiungibile allo stesso modo da ogni layout. Ci si
    // arriva col tasto destro sulla tab, come farebbe chiunque.
    const tab = page.locator('[role="main"]').getByText(new RegExp(`E2E-Share-Chat-${stamp}$`)).first();
    await expect(tab).toBeVisible({ timeout: 10_000 });
    await tab.dispatchEvent("contextmenu");
    const voce = page.locator("button").filter({ hasText: /^Impostazioni$/ });
    await expect(voce).toBeVisible({ timeout: 5_000 });
    await voce.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // IL MONTAGGIO. Senza questa riga il resto del test non proverebbe niente
    // sulla superficie delle chat: proverebbe di nuovo l'API.
    const controllo = dialog.getByTestId("share-control");
    await expect(controllo, "la chat deve offrire lo STESSO controllo di una scheda").toBeVisible();
    await controllo.click();

    // Il PANNELLO è portalato (da agosto 2026 passa dalla primitiva `Menu`:
    // dentro la testata del drawer un `absolute` finiva ritagliato da un
    // antenato `overflow-hidden` e si vedeva alto 41px). Quindi vive fuori dal
    // dialogo, e da qui in giù si cerca nella pagina.
    const pannello = page.getByTestId("share-panel");
    await expect(pannello).toBeVisible({ timeout: 5_000 });

    // Il destinatario è la PERSONA: è ciò che la rubrica offre per un ospite
    // appaiato come «è di un'altra persona».
    const destinatario = pannello.getByRole("button", { name: new RegExp(`^Persona ${nome}`) });
    await expect(destinatario).toBeVisible({ timeout: 5_000 });
    await destinatario.click();

    // Il pannello lo dice: è il segnale che la scrittura è andata a buon fine
    // sul lato di chi condivide, prima di andare a guardare dall'altro. Il
    // testo è tradotto come il resto dell'app (l'inglese era scritto a mano).
    await expect(controllo).toHaveText(/Condivisa con 1/, { timeout: 10_000 });

    // ── E ADESSO DA FUORI, che è l'unico posto da cui il confinamento si vede.
    const inv = await request.get(`${E2E_TUNNEL_BASE}/api/auth/shared`, { headers: daOspite(cookie) });
    expect(inv.status()).toBe(200);
    const elenco = JSON.stringify(await inv.json());
    expect(elenco, "la chat condivisa dal pannello deve comparire all'ospite").toContain(condivisa.id);
    expect(elenco, "e nessun'altra").not.toContain(nascosta.id);

    const letta = await request.get(`${E2E_TUNNEL_BASE}/api/topics/${condivisa.id}/messages`, {
      headers: daOspite(cookie),
    });
    expect(letta.status()).toBe(200);
    const altrui = await request.get(`${E2E_TUNNEL_BASE}/api/topics/${nascosta.id}/messages`, {
      headers: daOspite(cookie),
    });
    expect([403, 404], "la chat non condivisa resta chiusa").toContain(altrui.status());

    const scrittura = await request.patch(`${E2E_TUNNEL_BASE}/api/topics/${condivisa.id}`, {
      headers: daOspite(cookie),
      data: { name: "rinominata dall'ospite" },
    });
    expect(scrittura.status(), "condivisa dal pannello resta comunque in sola lettura").toBe(403);
  });
});
