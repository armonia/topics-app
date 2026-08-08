import { test, expect, type APIRequestContext } from "@playwright/test";
import { E2E_BASE, E2E_TUNNEL_BASE } from "./helpers/test-server";
import { createTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
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

/** Appaia un dispositivo e lo fa approvare dal proprietario come persona
 *  DIVERSA da sé: è il gesto che lo rende ospite, e non c'è altro modo. */
async function ospite(
  api: APIRequestContext,
  nome: string,
): Promise<{ cookie: string; deviceId: string }> {
  // La richiesta viene da fuori — è il telefono che chiede, non il Mac.
  const richiesta = await api.post(`${E2E_TUNNEL_BASE}/api/auth/pair/request`, {
    data: { name: nome },
  });
  expect(richiesta.ok()).toBeTruthy();
  // Il `claim` torna SOLO qui, a chi ha chiesto. Chi vede passare il
  // `requestId` in un frame non ce l'ha, ed è per questo che non può incassare.
  const { requestId, claim } = (await richiesta.json()) as { requestId: string; claim: string };

  // L'approvazione viene dal proprietario, cioè da dentro. `personName` è il
  // caso «è di un'altra persona»: è QUELLO che lo rende ospite — il ruolo
  // discende dalla persona, non si sceglie.
  const ok = await api.post(`${E2E_BASE}/api/auth/pair/approve`, {
    data: { requestId, personName: `Persona ${nome}` },
  });
  expect(ok.ok(), "il proprietario deve poter approvare da loopback").toBeTruthy();
  const approvato = (await ok.json()) as { deviceId: string; role: string };
  expect(approvato.role, "una persona diversa dal proprietario deve dare un ospite").toBe("guest");

  // Il token esce UNA volta sola, nel `Set-Cookie` dello status.
  const stato = await api.get(
    `${E2E_TUNNEL_BASE}/api/auth/pair/status?requestId=${requestId}&claim=${claim}`,
  );
  const corpo = (await stato.json()) as { state: string };
  expect(corpo.state).toBe("approved");
  const setCookie = stato.headers()["set-cookie"] ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  expect(cookie, "lo status approvato deve consegnare il biscotto di sessione").toContain(`${SESSION_COOKIE}=`);

  return { cookie, deviceId: approvato.deviceId };
}

const daOspite = (cookie: string) => ({ Cookie: cookie });

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

    // Un contesto browser vero col biscotto dell'ospite: è il percorso che fa
    // davvero un telefono, e l'unico modo di aprire quella socket con quella
    // identità — `WebSocket` di Node non porta header, e `ws` non è fra le
    // dipendenze di questo repo.
    const eq = cookie.indexOf("=");
    const ctx = await browser.newContext({ baseURL: E2E_TUNNEL_BASE });
    await ctx.addCookies([{
      name: cookie.slice(0, eq),
      value: cookie.slice(eq + 1),
      url: E2E_TUNNEL_BASE,
    }]);
    const page = await ctx.newPage();

    const frame: string[] = [];
    page.on("websocket", (ws) => {
      ws.on("framereceived", (f) => { if (typeof f.payload === "string") frame.push(f.payload); });
    });

    try {
      await page.goto(E2E_TUNNEL_BASE, { waitUntil: "domcontentloaded" });
      // Si aspetta che la socket sia SU prima di muovere qualcosa: senza
      // questo, un test verde direbbe solo che il frame è arrivato prima che
      // qualcuno ascoltasse.
      await page.waitForEvent("websocket", { timeout: 15_000 });

      for (const t of [condivisa, nascosta]) {
        await request.patch(`${E2E_BASE}/api/topics/${t.id}`, { data: { name: `${t.name}-mossa` } });
      }
      // I broadcast sono immediati: se il filtro fosse rotto il frame sarebbe
      // già qui. L'attesa è per il filo, non per una riconciliazione.
      await page.waitForTimeout(2000);

      const testo = frame.join("\n");
      expect(
        testo.includes(nascosta.id),
        "l'id di una topic NON condivisa non deve comparire in nessun frame consegnato all'ospite",
      ).toBe(false);
    } finally {
      await ctx.close();
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
