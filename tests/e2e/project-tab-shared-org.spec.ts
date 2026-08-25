/**
 * LA TAB DI UN PROGETTO CONDIVISO LO DICE.
 *
 * Il feedback, verbatim: «se un progetto è condiviso con una certa
 * organizzazione, dovrei vedere l'icona dell'organizzazione sulla tab del
 * progetto stesso, in modo da ricordarmi che condivido e tutti quanti possono
 * vedere quella sessione». Non è un vezzo grafico: è l'unica cosa che sta fra
 * chi scrive e lo scrivere una cosa privata in una sessione che vedono in
 * cinque, e un'informazione che si scopre aprendo un menu arriva sempre dopo.
 *
 * PERCHE' IL SECONDO MEMBRO E' IL PRIMO GESTO DI QUESTO FILE. Ogni progetto
 * creato su un'installazione nasce timbrato con l'organizzazione
 * dell'installazione stessa (`projects.ts`, `orgId: installationOrgId(...)`):
 * sul database vivo, dieci progetti su dieci portano `org_id` e nessuno di
 * essi è visibile a qualcuno. Legare il marchio alla colonna avrebbe marcato
 * tutte le tab come condivise mentre nessuno poteva vedere niente — verde,
 * plausibile, e privo di contenuto. Il marchio segue l'AVVISO: qualcun altro
 * legge. Quindi qui si comincia mettendo qualcun altro nell'organizzazione.
 *
 * L'APPIGLIO E' UN `data-testid`. `PaneTabBar` porta già la lezione scritta sul
 * proprio nome: «i locator dei test erano agganciati alle classi Tailwind, e
 * rinominarne una li faceva passare a verde-vuoto».
 *
 * @covers PROJECT-04
 */
import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

hermetic(test);

const PROJECT_PATH = `/tmp/e2e-shared-org-${Date.now()}`;
const PROJECT_NAME = PROJECT_PATH.split("/").pop()!;
const TAB = `pane-tab-project:${encodeURIComponent(PROJECT_PATH)}`;

let orgId = "";
let orgNome = "";
let compagnaId = "";
let projectId = "";

test.describe("Il marchio dell'organizzazione sulla tab di progetto", () => {
  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-shared-org" }));

    // L'organizzazione DELL'INSTALLAZIONE: è quella con cui il server timbra
    // ogni progetto nuovo, quindi è l'unica che può finire su questa tab.
    const elenco = await request.get(`${E2E_BASE}/api/auth/orgs`);
    expect(elenco.ok(), "l'elenco delle organizzazioni deve rispondere").toBeTruthy();
    const orgs = ((await elenco.json()) as { orgs: Array<{ id: string; name: string; installation?: boolean; members: number }> }).orgs;
    const mia = orgs.find((o) => o.installation) ?? orgs[0];
    expect(mia, "il server di test deve avere un'organizzazione d'installazione").toBeTruthy();
    orgId = mia!.id;
    orgNome = mia!.name;
    expect(mia!.members, "la baseline parte da una sola persona: è il caso che NON è condivisione").toBe(1);

    // Il secondo membro. Da qui in poi «condiviso» smette di essere una parola.
    //
    // Dal verbo di test e non da `POST /api/auth/orgs/:id/members`, che qui
    // risponde 403 `no_seats_left`: senza gettone di licenza i posti sono uno,
    // e il secondo membro e' proprio cio' che il prodotto rifiuta. Non e' un
    // aggiramento del comportamento — e' il gettone che a un server di test
    // manca, e firmarne uno per popolare due righe sarebbe una seconda
    // implementazione della licenza dentro la suite.
    const invito = await request.post(`${E2E_BASE}/api/test/orgs/${orgId}/members`, {
      data: { name: "Compagna E2E" },
    });
    expect(invito.ok(), "invitare una persona nell'organizzazione deve riuscire").toBeTruthy();
    compagnaId = ((await invito.json()) as { personId: string }).personId;

    const creato = await request.post(`${E2E_BASE}/api/projects`, {
      data: { name: PROJECT_NAME, path: PROJECT_PATH },
    });
    expect(creato.ok(), "il progetto di prova deve nascere").toBeTruthy();
    const p = (await creato.json()) as { id: string; orgId: string | null };
    projectId = p.id;
    expect(p.orgId, "un progetto nasce nell'organizzazione dell'installazione").toBe(orgId);
  });

  test.afterAll(async ({ request }) => {
    if (projectId) await request.delete(`${E2E_BASE}/api/projects/${projectId}`).catch(() => {});
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    // Solo la NOSTRA tab: le pane lasciate dalle spec precedenti fanno da
    // rumore su una barra condivisa.
    await resetPaneStore(page.request, []);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("SHAREORG-01: la tab porta il marchio, e il titolo dice CON CHI", async ({ page }) => {
    await goToApp(page);
    const tab = page.getByTestId(TAB).first();
    await expect(tab, "la tab del progetto deve essere aperta").toBeVisible({ timeout: 15000 });

    const marchio = tab.getByTestId("pane-tab-shared-org");
    await expect(marchio).toBeVisible({ timeout: 10000 });
    await expect(marchio, "il marchio deve puntare all'organizzazione giusta")
      .toHaveAttribute("data-org-id", orgId);

    // L'icona da sola dice «condiviso»; la domanda che uno ha è «con chi».
    const titolo = await marchio.getAttribute("title");
    expect(titolo, "il titolo deve nominare l'organizzazione").toContain(orgNome);

    await tab.screenshot({ path: "test-results/tab-progetto-condiviso.png" });
  });

  test("SHAREORG-02: marcato incognito il marchio sparisce, e torna, senza ricaricare", async ({ page }) => {
    await goToApp(page);
    const marchio = page.getByTestId(TAB).first().getByTestId("pane-tab-shared-org");
    await expect(marchio).toBeVisible({ timeout: 15000 });

    // Nessun `reload` in questo test, ed è il punto: la PATCH emette
    // `project:updated` e la tab deve reagire a quello.
    const off = await page.request.patch(`${E2E_BASE}/api/projects/${projectId}`, {
      data: { incognito: true },
    });
    expect(off.ok()).toBeTruthy();
    await expect(marchio, "«incognito» è il ritiro dall'organizzazione: il marchio deve cadere")
      .toHaveCount(0, { timeout: 10000 });

    const on = await page.request.patch(`${E2E_BASE}/api/projects/${projectId}`, {
      data: { incognito: false },
    });
    expect(on.ok()).toBeTruthy();
    await expect(marchio, "e tornare indietro deve riportarlo").toBeVisible({ timeout: 10000 });
  });

  test("SHAREORG-03: tolta l'altra persona, il progetto non è più condiviso con nessuno", async ({ page }) => {
    // La regola che questo file difende, vista da fuori: l'organizzazione resta
    // sul progetto — `org_id` non cambia — e il marchio se ne va lo stesso,
    // perché non c'è più nessun altro che legga.
    //
    // Qui il ricarico c'è, e non è una scorciatoia: nessun frame porta
    // l'appartenenza (lo dice `projectSharingStore`), quindi un cambio di
    // membri NON è un evento vivo. Fingere il contrario con un'attesa più
    // lunga darebbe un test che passa per il motivo sbagliato.
    await goToApp(page);
    await expect(page.getByTestId(TAB).first().getByTestId("pane-tab-shared-org"))
      .toBeVisible({ timeout: 15000 });

    const via = await page.request.delete(
      `${E2E_BASE}/api/auth/orgs/${orgId}/members?personId=${encodeURIComponent(compagnaId)}`,
    );
    expect(via.ok(), "togliere un membro deve riuscire").toBeTruthy();

    await goToApp(page);
    const tab = page.getByTestId(TAB).first();
    await expect(tab).toBeVisible({ timeout: 15000 });
    await expect(
      tab.getByTestId("pane-tab-shared-org"),
      "un'organizzazione di una persona sola non condivide niente con nessuno",
    ).toHaveCount(0, { timeout: 10000 });
  });
});
