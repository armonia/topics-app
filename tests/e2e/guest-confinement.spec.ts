import { test, expect, type APIRequestContext } from "@playwright/test";
import { E2E_BASE, E2E_TUNNEL_BASE } from "./helpers/test-server";
import { createTopic, resetPaneStore } from "./helpers/api-fixtures";
import { goToApp, ensureTopicVisible } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { ospite, daOspite } from "./helpers/ospite";
import { SESSION_COOKIE } from "../../server/lib/device-auth";
import { projectIdForPath } from "../../shared/board";

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

  test("GUEST-01b: a shared chat does not open the project's introspection routes", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "GUEST-01b" });
    // The allowlist matched `/api/topics/` as a PREFIX, so the grant on one
    // chat also answered `/context-preview` (the project's CLAUDE.md, README,
    // AGENTS.md), `/environment` (tool and MCP configuration, permission
    // policy) and the checkpoint routes. All GETs, all carrying the granted
    // id: the method axis and the entity axis both said yes. Only the path
    // can say no, and it says no only if it is exact.
    const stamp = Date.now();
    const condivisa = await createTopic(request, `E2E-Guest-Introspezione-${stamp}`);
    const { cookie, deviceId } = await ospite(request, `guest-01b-${stamp}`);
    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "topic", resourceId: condivisa.id },
    });

    // Positive control first: the messages of the granted chat are readable,
    // so a 403 below is the path rule and not a broken grant.
    const messages = await request.get(`${E2E_TUNNEL_BASE}/api/topics/${condivisa.id}/messages`, {
      headers: daOspite(cookie),
    });
    expect(messages.status()).toBe(200);

    for (const sub of ["context-preview", "environment", "checkpoints", "turn-checkpoints", "context-snapshots", "project-id"]) {
      const r = await request.get(`${E2E_TUNNEL_BASE}/api/topics/${condivisa.id}/${sub}`, {
        headers: daOspite(cookie),
      });
      expect(r.status(), `/${sub} of a granted chat is not part of the chat`).toBe(403);
      expect(((await r.json()) as { code?: string }).code).toBe("guest_forbidden");
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

  /**
   * THE LEVEL, ACROSS THE REAL CHAIN.
   *
   * The two unit tests that came with the levels stub `requestIdentity`, so
   * the real chain - path allowlist, then method allowlist, then the entity
   * check, then the level - is never crossed for the new routes. This one
   * crosses all of it: a real pairing, a real cookie, the tunnel listener, on
   * a real card.
   *
   * It asserts BOTH sides. A test that only saw a 403 could not tell "refused
   * because of the level" from "the route does not exist": here the same guest
   * and the same card answer 200 at `comment` and 403 at `edit`, then 200 at
   * `edit` once the owner raises the level.
   */
  test("GUEST-09: comment e edit passano la catena vera, run non passa a nessun livello", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "GUEST-09" });
    const stamp = Date.now();
    const board = projectIdForPath(`/tmp/e2e-guest-level-${stamp}`);
    const made = await request.post(`${E2E_BASE}/api/boards/${board}/tasks`, {
      data: { text: `E2E-Guest-Livello-${stamp}` },
    });
    expect(made.ok(), "the owner creates the card from its own door").toBeTruthy();
    const { id: taskId } = (await made.json()) as { id: string };

    const { cookie, deviceId } = await ospite(request, `guest-09-${stamp}`);
    const shareAt = (level: string) =>
      request.post(`${E2E_BASE}/api/auth/shares`, {
        data: { subjectType: "device", subjectId: deviceId, resourceType: "task", resourceId: taskId, level },
      });

    // `read` FIRST, and the comment refused there. Without this step the
    // middle rung of the scale is not observed at all: replacing the router's
    // guard with `guestAction === "edit" && !meetsLevel(...)` - which lets any
    // `read` guest comment on anything shared with it - left this whole file
    // green. A test that starts at `comment` can only ever see the granted
    // half.
    expect((await shareAt("read")).ok()).toBeTruthy();
    const tooEarly = await request.post(`${E2E_TUNNEL_BASE}/api/tasks/${taskId}/comments`, {
      headers: daOspite(cookie),
      data: { content: "non dovrei riuscire a scrivere" },
    });
    expect(tooEarly.status(), "at `read` a comment is refused").toBe(403);
    expect((await tooEarly.json()).code, "denied by the level, not by the route").toBe("guest_level_denied");

    // `comment`: the GRANTED half, not only the refused one.
    expect((await shareAt("comment")).ok()).toBeTruthy();
    const posted = await request.post(`${E2E_TUNNEL_BASE}/api/tasks/${taskId}/comments`, {
      headers: daOspite(cookie),
      data: { content: "visto, manca un passaggio" },
    });
    expect(posted.status(), "at `comment` the comment goes through").toBe(200);

    // The same guest, the same card, one step up: REFUSED - and refused by the
    // LEVEL, which the code says out loud. That is what separates this 403
    // from "the route is not there".
    const write = await request.patch(`${E2E_TUNNEL_BASE}/api/tasks/${taskId}`, {
      headers: daOspite(cookie),
      data: { text: "riscritta dall'ospite" },
    });
    expect(write.status()).toBe(403);
    expect((await write.json()).code, "denied by the level, not by the route").toBe("guest_level_denied");

    // Level raised, the very same request passes: that is what proves the 403
    // above was about the level and about nothing else.
    expect((await shareAt("edit")).ok()).toBeTruthy();
    const edited = await request.patch(`${E2E_TUNNEL_BASE}/api/tasks/${taskId}`, {
      headers: daOspite(cookie),
      data: { text: `riscritta dall'ospite ${stamp}` },
    });
    expect(edited.status(), "at `edit` correcting the text goes through").toBe(200);
    expect((await edited.json()).text).toBe(`riscritta dall'ospite ${stamp}`);

    // And starting a run stays out at the TOP of the scale: it is the
    // dangerous half of the pair "rewrite the text, then have it executed".
    // Refused by the GATE (`guest_read_only`), not by a check inside the
    // router, so there is no branch left to forget.
    for (const action of ["run", "stop"]) {
      const r = await request.post(`${E2E_TUNNEL_BASE}/api/tasks/${taskId}/${action}`, {
        headers: daOspite(cookie),
      });
      expect(r.status(), `${action} is granted at no level`).toBe(403);
      expect((await r.json()).code).toBe("guest_read_only");
    }

    // Nothing was dispatched: the refusal did not leave a half-started run.
    const after = await request.get(`${E2E_BASE}/api/boards/${board}/tasks/${taskId}`);
    const { task: card } = (await after.json()) as { task: { status: string; assignedTopicId: string | null } };
    expect(card.status, "the card stays where it was").toBe("backlog");
    expect(card.assignedTopicId, "and no agent was bound to it").toBeFalsy();
  });

  /**
   * A LEVEL ON A PROJECT DOES NOT BECOME A LEVEL ON ITS CARDS.
   *
   * Sharing a project is one click on a set whose membership moves on its own,
   * and the cards inside it carry no grant row of their own - so an inherited
   * `edit` would be a write capability nobody can see on the card's own panel
   * and nobody can take back from it, on every card the project holds now and
   * on every card created into it later.
   *
   * Crossed here and not only in the unit test because the whole point is the
   * chain: the gate lets `PATCH /api/tasks/:id` through as a path, and only
   * the level refuses it.
   */
  test("GUEST-11: un progetto condiviso a `edit` apre la lettura, non la scrittura", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "GUEST-11" });
    const stamp = Date.now();
    const board = projectIdForPath(`/tmp/e2e-guest-project-level-${stamp}`);
    const made = await request.post(`${E2E_BASE}/api/boards/${board}/tasks`, {
      data: { text: `E2E-Guest-Progetto-${stamp}` },
    });
    expect(made.ok()).toBeTruthy();
    const { id: taskId } = (await made.json()) as { id: string };

    const { cookie, deviceId } = await ospite(request, `guest-09-prj-${stamp}`);
    const shared = await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "project", resourceId: board, level: "edit" },
    });
    expect(shared.ok(), "the owner shares the PROJECT, at the top of the scale").toBeTruthy();

    // A card created AFTER the grant: the inherited access has to be read at
    // the moment of the question, so this one is inside it too.
    const later = await request.post(`${E2E_BASE}/api/boards/${board}/tasks`, {
      data: { text: `E2E-Guest-Progetto-dopo-${stamp}` },
    });
    const { id: laterId } = (await later.json()) as { id: string };

    // THE LIST AND THE DOOR SAY THE SAME THING. The gate has followed the
    // container since 20260816230500 and the two inventories did not: a card
    // inside a shared project was openable by id and absent from every list a
    // guest has - "I shared it with you" against "I see nothing".
    const inventory = JSON.stringify(await (
      await request.get(`${E2E_TUNNEL_BASE}/api/auth/shared`, { headers: daOspite(cookie) })
    ).json());
    expect(inventory, "la scheda del progetto compare nell'inventario").toContain(taskId);
    expect(inventory, "anche quella creata dopo la concessione").toContain(laterId);

    const feed = await request.get(`${E2E_TUNNEL_BASE}/api/all-boards/tasks`, { headers: daOspite(cookie) });
    expect(feed.status()).toBe(200);
    expect(JSON.stringify(await feed.json())).toContain(taskId);

    for (const id of [taskId, laterId]) {
      const read = await request.get(`${E2E_TUNNEL_BASE}/api/tasks/${id}`, { headers: daOspite(cookie) });
      expect(read.status(), "the project opens its cards for reading").toBe(200);

      const write = await request.patch(`${E2E_TUNNEL_BASE}/api/tasks/${id}`, {
        headers: daOspite(cookie),
        data: { text: "riscritta attraverso il progetto" },
      });
      expect(write.status(), "and stops there").toBe(403);
      expect((await write.json()).code).toBe("guest_level_denied");

      const commented = await request.post(`${E2E_TUNNEL_BASE}/api/tasks/${id}/comments`, {
        headers: daOspite(cookie),
        data: { content: "nemmeno un commento" },
      });
      expect(commented.status()).toBe(403);
    }

    // The owner's text is the one on the card, from the owner's own door.
    const still = await request.get(`${E2E_BASE}/api/boards/${board}/tasks/${taskId}`);
    const { task: card } = (await still.json()) as { task: { text: string } };
    expect(card.text).toBe(`E2E-Guest-Progetto-${stamp}`);
  });

  /**
   * THE SCALE, AS THE GUEST'S OWN APPLICATION SHOWS IT.
   *
   * Everything above proves the SERVER honours three levels. It says nothing
   * about the product, and that is where the two halves had come apart: the
   * guest screen printed "Sola lettura. Puoi vedere, non modificare." at everybody (allow-italian: the exact `guest.readOnly` string on screen)
   * - including a device the owner had just granted `edit` from the sharing
   * panel - and offered no composer and no editable text, so the
   * capability the panel promised was unreachable from the application. Two
   * sentences on the two sides of one permission, saying opposite things.
   *
   * The test opens the real page, on the tunnel listener, with a real guest
   * cookie, and asserts BOTH sides of the same card: absent at `read`,
   * present and EFFECTIVE at `edit` - the rewritten text read back from the
   * owner's own door, which is the only place it counts.
   */
  test("GUEST-12: la vista dell'ospite mostra il livello che gli e' stato dato", async ({ request, browser }) => {
    test.info().annotations.push({ type: "spec", description: "GUEST-12" });
    const stamp = Date.now();
    const board = projectIdForPath(`/tmp/e2e-guest-view-${stamp}`);
    const made = await request.post(`${E2E_BASE}/api/boards/${board}/tasks`, {
      data: { text: `E2E-Guest-Vista-Livello-${stamp}` },
    });
    const { id: taskId } = (await made.json()) as { id: string };
    const { cookie, deviceId } = await ospite(request, `guest-09-view-${stamp}`);
    const shareAt = (level: string) =>
      request.post(`${E2E_BASE}/api/auth/shares`, {
        data: { subjectType: "device", subjectId: deviceId, resourceType: "task", resourceId: taskId, level },
      });

    expect((await shareAt("read")).ok()).toBeTruthy();

    const eq = cookie.indexOf("=");
    const ctx = await browser.newContext({ baseURL: E2E_TUNNEL_BASE });
    await ctx.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: E2E_TUNNEL_BASE }]);
    const page = await ctx.newPage();
    try {
      await page.goto(E2E_TUNNEL_BASE, { waitUntil: "domcontentloaded" });
      const card = page.getByTestId("guest-card");
      await expect(card, "l'ospite vede la scheda che gli e' stata condivisa").toHaveCount(1);

      // AT `read`: neither of the two writes is offered, and the page says so.
      await expect(page.getByTestId("guest-comment-input")).toHaveCount(0);
      await expect(page.getByTestId("guest-edit-open")).toHaveCount(0);
      await expect(card.getByTestId("guest-level")).toHaveText(/vedere|view/i);

      // The owner raises the level from its own door, and the page is loaded
      // again. NOT because a live update would be wrong to want, but because
      // a guest page mounts no socket at all: `SessionRoot` renders the guest
      // view INSTEAD of `<App/>`, and `useWebSocket` lives inside `App`. A
      // test that waited for the composer to appear on its own would be
      // waiting for a frame nothing can deliver, and would fail describing
      // the level instead of the missing socket.
      expect((await shareAt("edit")).ok()).toBeTruthy();
      await page.reload({ waitUntil: "domcontentloaded" });
      const box = page.getByTestId("guest-comment-input");
      await expect(box, "alzato il livello, l'ospite ha da scrivere").toHaveCount(1, { timeout: 15_000 });
      await expect(page.getByTestId("guest-edit-open")).toHaveCount(1);

      // AND IT WORKS, which is the half a presence check cannot see.
      await box.fill("commento scritto dalla vista ospite");
      await page.getByTestId("guest-comment-send").click();
      await expect(card.getByTestId("guest-thread")).toContainText("commento scritto dalla vista ospite", { timeout: 15_000 });

      const newText = `riscritta dalla vista ospite ${stamp}`;
      await page.getByTestId("guest-edit-open").click();
      await page.getByTestId("guest-edit-text").fill(newText);
      await page.getByTestId("guest-edit-save").click();
      await expect(card).toContainText(newText, { timeout: 15_000 });

      // Read back from the OWNER's door: the card really changed, and the
      // comment is really in its thread.
      await expect.poll(async () => {
        const r = await request.get(`${E2E_BASE}/api/boards/${board}/tasks/${taskId}`);
        return ((await r.json()) as { task: { text: string } }).task.text;
      }, { timeout: 15_000 }).toBe(newText);
    } finally {
      await ctx.close();
    }
  });

  /**
   * `/api/auth/shares` IS NOT A GUEST'S SURFACE, and the refusal comes from
   * the gate.
   *
   * The GET branch of that route has no level check of its own, and the gate
   * matches resource ids found in the PATH while this route names its resource
   * in the QUERY: listed as an allowed path, one shared card was enough to
   * enumerate subjects, names and levels of any resource whose id could be
   * named. Closed as a path, the query is never reached.
   */
  test("GUEST-10: un ospite non legge, ne' scrive, chi altro tiene una risorsa", async ({ request }) => {
    test.info().annotations.push({ type: "spec", description: "GUEST-10" });
    const stamp = Date.now();
    const board = projectIdForPath(`/tmp/e2e-guest-shares-${stamp}`);
    const made = await request.post(`${E2E_BASE}/api/boards/${board}/tasks`, {
      data: { text: `E2E-Guest-Shares-${stamp}` },
    });
    const { id: taskId } = (await made.json()) as { id: string };
    const { cookie, deviceId } = await ospite(request, `guest-10-${stamp}`);
    await request.post(`${E2E_BASE}/api/auth/shares`, {
      data: { subjectType: "device", subjectId: deviceId, resourceType: "task", resourceId: taskId, level: "read" },
    });

    // The route EXISTS and ANSWERS: from the owner's door it lists the
    // subjects. This is the half that tells "refused" apart from "there is
    // nothing here".
    const asOwner = await request.get(
      `${E2E_BASE}/api/auth/shares?resourceType=task&resourceId=${taskId}`,
    );
    expect(asOwner.status()).toBe(200);
    expect(JSON.stringify(await asOwner.json())).toContain(deviceId);

    // The same address, with a REAL guest, on a resource genuinely shared with
    // it: refused, and refused at the gate.
    for (const resource of [taskId, "una-risorsa-qualunque"]) {
      const r = await request.get(
        `${E2E_TUNNEL_BASE}/api/auth/shares?resourceType=task&resourceId=${resource}`,
        { headers: daOspite(cookie) },
      );
      expect(r.status(), "not even on its own card").toBe(403);
      const body = await r.json();
      expect(body.code, "refused at the gate, not inside the route").toBe("guest_forbidden");
      expect(JSON.stringify(body), "and no subject leaks out").not.toContain(deviceId);
    }

    // Nor for writing: granting and revoking stay the owner's gestures.
    const post = await request.post(`${E2E_TUNNEL_BASE}/api/auth/shares`, {
      headers: daOspite(cookie),
      data: { subjectType: "device", subjectId: deviceId, resourceType: "task", resourceId: taskId, level: "edit" },
    });
    expect(post.status()).toBe(403);
    expect((await post.json()).code).toBe("guest_forbidden");

    const del = await request.fetch(
      `${E2E_TUNNEL_BASE}/api/auth/shares?resourceType=task&resourceId=${taskId}&subjectType=device&subjectId=${deviceId}`,
      { method: "DELETE", headers: daOspite(cookie) },
    );
    expect(del.status()).toBe(403);
    expect((await del.json()).code).toBe("guest_forbidden");

    // The grant is still standing: the refusal revoked nothing.
    const still = await request.get(`${E2E_TUNNEL_BASE}/api/auth/shared`, { headers: daOspite(cookie) });
    expect(JSON.stringify(await still.json())).toContain(taskId);
  });
});
