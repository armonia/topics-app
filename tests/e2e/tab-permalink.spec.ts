/**
 * tab-permalink.spec.ts — il permalink di una tab, dai due lati: il PRODUTTORE
 * (chi il link lo copia, e la parità fra le superfici che lo offrono) e il
 * CONSUMATORE a freddo (chi il link lo apre in una scheda appena nata).
 *
 * Cosa difende, in ordine:
 *  · TABLINK-01 il menu contestuale della TAB copia `/tab/chat/<topicId>` — il
 *    TOPIC, non l'id della pane, che è ciò che cambia a seconda di dove la chat
 *    sta (`<topicId>` in alto, `chat:<topicId>` dentro un progetto);
 *  · TABLINK-02 il menu del TOPIC in sidebar copia la stessa identica stringa:
 *    due superfici che dicono cose diverse sullo stesso soggetto sono un bug;
 *  · TABLINK-03 la palette ⌘K offre lo stesso gesto sulla tab a fuoco;
 *  · TABLINK-04 un permalink self-origin incollato in chat si apre IN-APP.
 *    Era l'asimmetria da chiudere: `/task/<id>` veniva intercettato,
 *    `/topic/<id>` e `/tab/…` no — e facevano partire il browser di sistema su
 *    una copia web dell'app;
 *  · TABLINK-05/06/07 il BOOT DA URL FREDDO (`page.goto('/tab/…')`), che è
 *    tutt'altro codice dal click in-app e non aveva copertura: la SPA servita
 *    su quel path, la tab che nasce e resta ATTIVA attraverso l'onda di
 *    idratazione, e un kind che non passa dall'ascoltatore delle chat;
 *  · TABLINK-08 la clipboard VERA, non lo stub;
 *  · TABLINK-09/10 il RIFIUTO non è mai muto. Sono due canali diversi perché il
 *    toast non è disponibile ovunque: in chat si ricade sul browser esterno
 *    (il context dei toast non è memoizzato e non si può consumare lì), al boot
 *    si mostra il toast — che vive sotto `<ToastProvider>`, cioè non in App;
 *  · TABLINK-11 il criterio di esistenza è ASIMMETRICO, e passa dalla rotta
 *    vera: una CARTELLA che sta sul disco è un soggetto valido anche se il
 *    server non l'ha mai registrata, mentre una chat inventata resta rifiutata.
 *
 * Nel blocco del PRODUTTORE la clipboard è stubbata in `addInitScript` invece di
 * essere letta: così l'asserzione è sulla STRINGA prodotta (esatta, non
 * "contiene qualcosa") e non dipende dal permesso del browser headless — che
 * quando manca fa passare il test invece di romperlo. Lo stub però non può dire
 * se la scrittura ARRIVA alla clipboard di sistema, ed è per questo che
 * TABLINK-08 fa il giro vero, senza stub e senza guardie.
 */
import { test } from "./fixtures/test-fixtures";
import { expect, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTopic, cleanupAll, resetPaneStore, unarchiveTopic } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { buildTabPath } from "../../shared/tab-link";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/** Registra ogni `writeText` invece di scrivere davvero nella clipboard di
 *  sistema. `copyText` (lib/clipboard) legge `navigator.clipboard?.writeText`,
 *  quindi lo stub copre esattamente la porta che l'app usa — e restituendo una
 *  promise risolta fa arrivare il call-site al toast di conferma. */
async function stubClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => { copied.push(String(text)); return Promise.resolve(); },
          readText: () => Promise.resolve(copied[copied.length - 1] ?? ""),
        },
      });
    } catch {
      /* clipboard non ridefinibile: l'asserzione sul contenuto lo dirà */
    }
  });
}

/** Le stringhe copiate finora, nell'ordine. */
function copiedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __copied?: string[] }).__copied ?? []);
}

/** `window.open` registrato invece di aprire davvero: è il canale di
 *  `openExternalOnce` sul web, e serve a provare che un link self-origin NON ci
 *  passa. */
async function stubExternalOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((u?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(u));
      return null;
    }) as typeof window.open;
  });
}

test.describe("Permalink di una tab — il produttore", () => {
  const TS = Date.now();
  const topicIds: string[] = [];
  let mainId = "";
  let otherId = "";

  test.beforeAll(async ({ request }) => {
    const main = await createTopic(request, `E2E-TabLink-${TS}`);
    const other = await createTopic(request, `E2E-TabLink-Dest-${TS}`);
    mainId = main.id;
    otherId = other.id;
    topicIds.push(main.id, other.id);
  });

  test.afterAll(async ({ request }) => {
    await cleanupAll(request, { topics: topicIds });
  });

  test.beforeEach(async ({ request, page }) => {
    // Una sola tab aperta: i locator qui sotto contano su una barra pulita.
    await resetPaneStore(request, [mainId]);
    await stubClipboard(page);
    await stubExternalOpen(page);
  });

  test("TABLINK-01: il menu della tab copia il TOPIC, non l'id della pane", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "CHROME-06" });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const tab = page.getByTestId(`pane-tab-${mainId}`);
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click({ button: "right" });

    const menu = page.getByRole("menu").last();
    await expect(menu).toBeVisible({ timeout: 5000 });
    await menu.getByText("Copia link", { exact: true }).click();

    await expect.poll(() => copiedTexts(page), { timeout: 5000 })
      .toEqual([`${E2E_BASE}/tab/chat/${mainId}`]);
    // Il feedback è un toast, perché il menu si chiude al click.
    await expect(page.getByText("Link copiato")).toBeVisible({ timeout: 5000 });
  });

  test("TABLINK-02: il menu del topic in sidebar copia la STESSA stringa", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const row = page.getByRole("treeitem", { name: new RegExp(`E2E-TabLink-${TS}`) });
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.click({ button: "right" });

    const menu = page.getByRole("menu").last();
    await expect(menu).toBeVisible({ timeout: 5000 });
    await menu.getByRole("menuitem", { name: "Copia link", exact: true }).click();

    await expect.poll(() => copiedTexts(page), { timeout: 5000 })
      .toEqual([`${E2E_BASE}/tab/chat/${mainId}`]);
  });

  test("TABLINK-03: la palette ⌘K offre lo stesso gesto sulla tab a fuoco", async ({ page, commandPalettePage }) => {
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // Il soggetto della voce è la tab A FUOCO: portiamocela cliccandola.
    const tab = page.getByTestId(`pane-tab-${mainId}`);
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click();

    await commandPalettePage.search("Copia link");
    const row = commandPalettePage.overlay.getByRole("option", { name: /Copia link alla tab/ });
    await expect(row).toBeVisible({ timeout: 5000 });
    await row.click();

    await expect.poll(() => copiedTexts(page), { timeout: 5000 })
      .toEqual([`${E2E_BASE}/tab/chat/${mainId}`]);
  });

  test("TABLINK-04: un permalink self-origin in chat si apre IN-APP, non nel browser di sistema", async ({ page, request }) => {
    const link = `${E2E_BASE}/tab/chat/${otherId}`;
    await seedMessage(request, {
      sessionKey: `topic:${mainId.slice(0, 8)}`,
      role: "assistant",
      content: `L'ho aperta qui: ${link}`,
    });

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.getByTestId(`pane-tab-${mainId}`).click();

    // remark-gfm autolinka l'URL scritto in chiaro: dev'essere un vero <a>.
    const anchor = page.locator(`a[href="${link}"]`);
    await expect(anchor).toBeVisible({ timeout: 15000 });

    const before = page.url();
    await anchor.click();

    // La tab della chat di destinazione si apre QUI…
    await expect(page.getByTestId(`pane-tab-${otherId}`)).toBeVisible({ timeout: 10000 });
    // …e nessun browser esterno è stato lanciato, né la SPA ha navigato.
    expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([]);
    expect(page.url()).toBe(before);
  });

  test("TABLINK-09: un permalink MORTO in chat ricade sul browser ESTERNO, invece di restare muto", async ({ page, request }) => {
    // Il difetto: `ChatMarkdown` non passava nessun `notify` a `openTabInApp`,
    // quindi un target che il server dichiara inesistente produceva un click
    // che non apriva niente e non diceva niente. Il toast qui non è
    // utilizzabile (il context non è memoizzato: un `useToast()` in questo
    // renderer farebbe di OGNI link di OGNI messaggio un consumatore che si
    // ri-renderizza a ogni giro), quindi il canale giusto è il RIPIEGO: si
    // torna a com'era prima che i self-origin venissero intercettati — il
    // browser di sistema, dove il contenuto almeno si VEDE.
    const morto = `${E2E_BASE}/tab/chat/11111111-1111-4111-8111-111111111111`;
    await seedMessage(request, {
      sessionKey: `topic:${mainId.slice(0, 8)}`,
      role: "assistant",
      content: `Questa non c'è più: ${morto}`,
    });

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.getByTestId(`pane-tab-${mainId}`).click();

    const anchor = page.locator(`a[href="${morto}"]`);
    await expect(anchor).toBeVisible({ timeout: 15000 });
    await anchor.click();

    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened),
      { timeout: 10000 },
    ).toEqual([morto]);
    // E nessuna tab fantasma: il ripiego non è un permesso a materializzare.
    await expect(page.getByTestId("pane-tab-11111111-1111-4111-8111-111111111111")).toHaveCount(0);
  });
});

/**
 * Il CONSUMATORE, e solo lui: un permalink incollato in una barra degli
 * indirizzi, cioè `page.goto('/tab/…')` su una scheda APPENA NATA.
 *
 * Perché è un blocco a parte e non un altro test del produttore. Il boot a
 * freddo non condivide NIENTE con il click in-app: l'app non è montata, il
 * pane-store non è ancora idratato, e la sequenza che deve funzionare
 * (`App.tsx` legge la URL a livello di modulo → la consuma → dà il colpo a
 * `setTimeout(0)` → ri-asserisce in debounce sui bump di `lastSeq` per 8s) è
 * codice che il produttore non tocca mai. Fino a qui la copertura era ZERO:
 * nessuno spec faceva una `goto` su `/tab/…`.
 *
 * Ci sono TRE cose distinte che possono rompersi, e sono tre test:
 *  · il server non serve nemmeno la SPA su quel path (spa-fallback) — TABLINK-05
 *    lo pretende con lo status della risposta, non deducendolo dalla pagina;
 *  · l'app non instrada il target (la tab non nasce) — TABLINK-05;
 *  · l'app instrada e poi l'idratazione le RUBA il fuoco. È la race vera, e si
 *    vede solo se la tab di destinazione è già aperta e NON è quella che il
 *    fallback `visibleOrder[0]` sceglierebbe — TABLINK-06.
 * TABLINK-07 ripete il giro su un kind che passa da un altro ascoltatore
 * (`topics:open-utility` invece di `topics:open-topic`), perché "funziona per le
 * chat" non dice niente sugli altri sei.
 *
 * NIENTE stub della clipboard qui: TABLINK-08 legge quella VERA.
 */
test.describe("Permalink di una tab — il consumatore a freddo", () => {
  const TS = Date.now();
  const topicIds: string[] = [];
  /** La destinazione del permalink. */
  let targetId = "";

  /**
   * La tab che c'è GIÀ quando il permalink arriva, e che qui serve a due cose:
   * essere quella che il fallback del fuoco sceglierebbe da sola, e restare in
   * piedi mentre la destinazione si apre.
   *
   * Perché un PANNELLO e non una seconda chat. Nel modello dell'app la prima tab
   * NON fissata è lo slot «anteprima», e un'apertura singola ha licenza di
   * sostituirla (`usePaneOrdering` → `findPreviewInList` → `onClosePanel`). Il
   * fissaggio però è device-local (`loadPanelOrder().pinned` in localStorage) e
   * un contesto Playwright nasce sempre vuoto: una chat seminata dal server
   * risulterebbe «anteprima» e verrebbe chiusa — con la topic ARCHIVIATA, che è
   * un effetto cross-device. È un comportamento che NON riguarda i permalink
   * (vale per qualunque apertura su un profilo senza storage: click in sidebar
   * compreso) ed è segnalato a parte; qui va tolto di mezzo, o questo test
   * misurerebbe quello invece del fuoco. Le pane di utilità sono fissate per
   * costruzione (`effectivePinnedIds` aggiunge utility/project/browser/terminal),
   * quindi un pannello è una tab «permanente» senza inventarsi stato locale.
   */
  const BYSTANDER = "__dashboard__";

  test.beforeAll(async ({ request }) => {
    const target = await createTopic(request, `E2E-TabBoot-${TS}`);
    targetId = target.id;
    topicIds.push(target.id);
  });

  test.afterAll(async ({ request }) => {
    await cleanupAll(request, { topics: topicIds });
  });

  test("TABLINK-05: `/tab/chat/<id>` a freddo apre quella tab e le lascia il fuoco", async ({ page, request }) => {
    // Workspace SENZA la destinazione: la tab deve nascere dal permalink, non
    // essere già lì. `resetPaneStore` passa da `seedPaneStore` (mai una PUT
    // nuda), che aspetta il silenzio dello store e verifica di essere rimasto
    // l'ultimo scrittore — un beacon di teardown della pagina precedente
    // atterrerebbe sopra e questo test partirebbe da un workspace vuoto.
    await resetPaneStore(request, [BYSTANDER]);
    // Aperto ⟺ non archiviato: `resetPaneStore` riapre solo le topic che semina,
    // e questa apposta non la semina.
    await unarchiveTopic(request, targetId);

    const response = await page.goto(`/tab/chat/${targetId}`);
    // Il permalink deve essere INDIRIZZABILE dal server, non solo dal client: su
    // un path sconosciuto il server risponde 404 e la SPA non parte affatto.
    // Asserito qui perché è l'unico punto in cui lo status è ancora leggibile.
    expect(response?.status()).toBe(200);

    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const tab = page.getByTestId(`pane-tab-${targetId}`);
    await expect(tab).toBeVisible({ timeout: 15000 });
    // ATTIVA, non solo presente: aprire una tab e lasciarla dietro un'altra è
    // esattamente il modo in cui questo difetto si presenta.
    await expect(tab).toHaveAttribute("data-active", "true", { timeout: 15000 });

    // La rotta si CONSUMA: il pane-store è già la persistenza della tab, e una
    // `/tab/…` che resta nella URL la riaprirebbe a ogni reload per sempre.
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10000 }).toBe("/");
  });

  test("TABLINK-06: la tab già aperta ma non a fuoco: il permalink glielo porta, e l'idratazione non glielo ruba", async ({ page, request }) => {
    // Le due tab in quest'ordine: senza permalink il fuoco andrebbe alla PRIMA
    // (Effect A → `visibleOrder[0]`, e su una scheda nuova non c'è nessun
    // `focusedPaneId` locale da ripristinare — è device-local e non viaggia nello
    // snapshot). Quindi un `data-active` sulla SECONDA può venire solo dal
    // permalink: il test non può passare per caso.
    await resetPaneStore(request, [BYSTANDER, targetId]);

    await page.goto(`/tab/chat/${targetId}`);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const target = page.getByTestId(`pane-tab-${targetId}`);
    const bystander = page.getByTestId(`pane-tab-${BYSTANDER}`);
    await expect(target).toBeVisible({ timeout: 15000 });
    await expect(target).toHaveAttribute("data-active", "true", { timeout: 15000 });

    // E ci RESTA. Il fuoco corretto al primo frame non prova niente: l'onda di
    // idratazione (WS `ui-state:init`, poi il fallback HTTP a 500ms) rifà la
    // riconciliazione del fuoco più volte, ed è lì che la tab appena aperta
    // veniva scalzata. L'attesa è deliberata e dimensionata sulla finestra di
    // boot (`TAB_INTENT_TTL_MS` 8s, ri-asserzione in debounce a 400ms): serve a
    // far passare l'onda, non a "dare tempo" a un locator.
    await page.waitForTimeout(3000);
    await expect(target).toHaveAttribute("data-active", "true");
    // E la tab che c'era prima è ancora lì, semplicemente non a fuoco: aprire un
    // permalink non è un modo per svuotare il workspace.
    await expect(bystander).toHaveAttribute("data-active", "false");
  });

  test("TABLINK-07: `/tab/panel/<tipo>` a freddo: un kind che NON passa dalle chat", async ({ page, request }) => {
    await resetPaneStore(request, [BYSTANDER]);

    await page.goto("/tab/panel/board");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // L'id della pane di un panel è `__<tipo>__` (utilityPanelId): il permalink
    // porta il TIPO, e chi lo riceve è `topics:open-utility` — un ascoltatore
    // diverso da quello delle chat, con la sua whitelist. Se un domani quella
    // whitelist e `TAB_PANELS` divergono, è qui che si vede.
    const panel = page.getByTestId("pane-tab-__board__");
    await expect(panel).toBeVisible({ timeout: 15000 });
    await expect(panel).toHaveAttribute("data-active", "true", { timeout: 15000 });
    await expect(page.getByTestId(`pane-tab-${BYSTANDER}`)).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10000 }).toBe("/");
  });

  test("TABLINK-10: un permalink verso un soggetto INESISTENTE lo DICE, e non conia niente", async ({ page, request }) => {
    // Il difetto: `DEAD_TAB_MESSAGE` era irraggiungibile in produzione —
    // nessun call-site passava `notify`, quindi ogni rifiuto era un no-op
    // silenzioso. Cablarlo non è banale come sembra: il toast è un context e
    // App RENDERIZZA `<ToastProvider>`, quindi `useToast()` dentro App
    // restituisce il no-op. Da qui `<BootDeepLinkResolver>`, montato sotto il
    // provider — ed è questo test a impedire che l'estrazione si perda.
    await resetPaneStore(request, [BYSTANDER]);
    const inventato = "00000000-0000-4000-8000-000000000000";

    await page.goto(`/tab/chat/${inventato}`);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    await expect(page.getByText("Questa tab non esiste più")).toBeVisible({ timeout: 20000 });
    // …e nessuna pane fantasma: è il buco che la verifica esiste per chiudere.
    await expect(page.getByTestId(`pane-tab-${inventato}`)).toHaveCount(0);
    await expect(page.getByTestId(`pane-tab-${BYSTANDER}`)).toBeVisible();
  });

  test("TABLINK-11: una CARTELLA che esiste sul disco è un soggetto valido, anche se il server non l'ha mai registrata", async ({ request }) => {
    // Il difetto: la guardia di esistenza era la stessa per tutti i kind, e per
    // i progetti chiedeva una riga in `projects`/`worktrees` o una pane in
    // `ui_state`. Ma l'app apre finestre di progetto senza registrare NIENTE
    // sul server (`handleProjectClick`: `ensurePaneRegistered` +
    // `recent-projects` su localStorage), e alla chiusura `PURGE_ORPHAN_PANE`
    // non lascia né closedStack né tombstone. Risultato: apri `~/scratch` col
    // picker, copi il link, chiudi la tab, riclicchi il link → non succedeva
    // NIENTE. E la cartella, intanto, esiste.
    //
    // Qui si passa dalla rotta VERA (non da un resolver finto) e da una
    // directory VERA: è il filesystem il criterio, e un mock proverebbe solo
    // che il mock funziona.
    const scratch = mkdtempSync(join(tmpdir(), "e2e-tablink-"));
    try {
      const vivo = await request.get(`/api/tabs/resolve?ref=${encodeURIComponent(buildTabPath({ kind: "project", key: scratch })!)}`);
      expect(vivo.status()).toBe(200);
      expect((await vivo.json()).state).toBe("closed");

      // …e il permalink a un file DENTRO quella cartella vale uguale: il
      // soggetto da confermare è il progetto ospite, ed è quello che il client
      // chiede (`openFileTab`).
      const file = await request.get(`/api/tabs/resolve?ref=${encodeURIComponent(buildTabPath({ kind: "file", key: "src/a.ts", projectPath: scratch })!)}`);
      expect((await file.json()).state).toBe("closed");

      // Una cartella che NON esiste resta `unknown`: la guardia non è stata
      // spenta, è stata resa asimmetrica.
      const morto = await request.get(`/api/tabs/resolve?ref=${encodeURIComponent(buildTabPath({ kind: "project", key: `${scratch}/mai-esistito` })!)}`);
      expect((await morto.json()).state).toBe("unknown");

      // E una CHAT inventata continua a essere rifiutata: `topics` è una
      // tabella, lì `unknown` vuol dire davvero «chiave inventata».
      const chat = await request.get("/api/tabs/resolve?ref=/tab/chat/22222222-2222-4222-8222-222222222222");
      expect((await chat.json()).state).toBe("unknown");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("TABLINK-08: «Copia link» scrive nella clipboard VERA, non in uno stub", async ({ page, request }) => {
    // TABLINK-01 fissa la STRINGA prodotta con `navigator.clipboard` stubbato in
    // `addInitScript`. Utile — ma uno stub non può dire se la scrittura arriva
    // davvero alla clipboard: `copyText` (lib/clipboard) inghiotte l'errore e
    // torna `false`, quindi una copia che non avviene resterebbe invisibile.
    // Qui non c'è nessuno stub: si clicca e si RILEGGE. Senza `if (clip)` —
    // `playwright.config.ts` concede clipboard-read/write a tutta la suite, e
    // una guardia del genere trasformerebbe l'unico difetto che questo test
    // cerca in un verde.
    await resetPaneStore(request, [targetId]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    const tab = page.getByTestId(`pane-tab-${targetId}`);
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click({ button: "right" });

    const menu = page.getByRole("menu").last();
    await expect(menu).toBeVisible({ timeout: 5000 });
    await menu.getByText("Copia link", { exact: true }).click();

    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
      .toBe(`${E2E_BASE}/tab/chat/${targetId}`);
  });
});
