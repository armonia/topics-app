/**
 * A SHARED PROJECT SAYS SO ON ITS TAB.
 *
 * The request, verbatim: «se un progetto è condiviso con una certa organizzazione, dovrei vedere l'icona dell'organizzazione sulla tab del progetto stesso, in modo da ricordarmi che condivido e tutti quanti possono vedere quella sessione». allow-italian: the request as it was written, and the words are the specification
 *
 * Not decoration: it is the only thing standing between writing something
 * private and writing it in a session five people can read, and a fact you
 * discover by opening a menu always arrives late.
 *
 * WHY THE SECOND MEMBER IS THIS FILE'S FIRST GESTURE. Every project created on
 * an installation is stamped with that installation's own organisation
 * (`projects.ts`, `orgId: installationOrgId(...)`): on the live database ten
 * projects out of ten carry `org_id` and not one of them is visible to anybody.
 * Tying the mark to the column would have marked every tab as shared while
 * nobody could see anything — green, plausible, and empty. The mark follows the
 * WARNING: somebody else is reading. So this file starts by putting somebody
 * else in the organisation.
 *
 * THE ANCHOR IS A `data-testid`. `PaneTabBar` already carries the lesson
 * written on its own label: test locators hung off Tailwind classes, and
 * renaming one turned them green-and-empty.
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
let orgName = "";
let mateId = "";
let projectId = "";

test.describe("Il marchio dell'organizzazione sulla tab di progetto", () => {
  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-shared-org" }));

    // The INSTALLATION's own organisation: it is the one the server stamps on
    // every new project, so it is the only one that can end up on this tab.
    const list = await request.get(`${E2E_BASE}/api/auth/orgs`);
    expect(list.ok(), "l'elenco delle organizzazioni deve rispondere").toBeTruthy();
    const orgs = ((await list.json()) as { orgs: Array<{ id: string; name: string; installation?: boolean; members: number }> }).orgs;
    const own = orgs.find((o) => o.installation) ?? orgs[0];
    expect(own, "il server di test deve avere un'organizzazione d'installazione").toBeTruthy();
    orgId = own!.id;
    orgName = own!.name;
    expect(own!.members, "la baseline parte da una sola persona: è il caso che NON è condivisione").toBe(1);

    // The second member. From here on "shared" stops being just a word.
    //
    // Through the test verb and not `POST /api/auth/orgs/:id/members`, which
    // answers 403 `no_seats_left` here: with no licence token there is one
    // seat, and the second member is precisely what the product refuses. Not a
    // way around the behaviour — it is the token a test server does not have,
    // and signing one just to populate two rows would be a second
    // implementation of the licence inside the suite.
    const invite = await request.post(`${E2E_BASE}/api/test/orgs/${orgId}/members`, {
      data: { name: "Compagna E2E" },
    });
    expect(invite.ok(), "invitare una persona nell'organizzazione deve riuscire").toBeTruthy();
    mateId = ((await invite.json()) as { personId: string }).personId;

    const created = await request.post(`${E2E_BASE}/api/projects`, {
      data: { name: PROJECT_NAME, path: PROJECT_PATH },
    });
    expect(created.ok(), "il progetto di prova deve nascere").toBeTruthy();
    const p = (await created.json()) as { id: string; orgId: string | null };
    projectId = p.id;
    expect(p.orgId, "un progetto nasce nell'organizzazione dell'installazione").toBe(orgId);
  });

  test.afterAll(async ({ request }) => {
    if (projectId) await request.delete(`${E2E_BASE}/api/projects/${projectId}`).catch(() => {});
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    // OUR tab only: panes left behind by earlier specs are noise on a shared
    // tab bar.
    await resetPaneStore(page.request, []);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("SHAREORG-01: la tab porta il marchio, e il titolo dice CON CHI", async ({ page }) => {
    await goToApp(page);
    const tab = page.getByTestId(TAB).first();
    await expect(tab, "la tab del progetto deve essere aperta").toBeVisible({ timeout: 15000 });

    const mark = tab.getByTestId("pane-tab-shared-org");
    await expect(mark).toBeVisible({ timeout: 10000 });
    await expect(mark, "il marchio deve puntare all'organizzazione giusta")
      .toHaveAttribute("data-org-id", orgId);

    // The icon alone says "shared"; the question anyone has is "with whom".
    const tooltip = await mark.getAttribute("title");
    expect(tooltip, "il titolo deve nominare l'organizzazione").toContain(orgName);

    await tab.screenshot({ path: "test-results/tab-progetto-condiviso.png" });
  });

  test("SHAREORG-02: marcato incognito il marchio sparisce, e torna, senza ricaricare", async ({ page }) => {
    await goToApp(page);
    const mark = page.getByTestId(TAB).first().getByTestId("pane-tab-shared-org");
    await expect(mark).toBeVisible({ timeout: 15000 });

    // No `reload` anywhere in this test, and that is the point: the PATCH
    // emits `project:updated` and the tab has to react to it.
    const off = await page.request.patch(`${E2E_BASE}/api/projects/${projectId}`, {
      data: { incognito: true },
    });
    expect(off.ok()).toBeTruthy();
    await expect(mark, "«incognito» è il ritiro dall'organizzazione: il marchio deve cadere")
      .toHaveCount(0, { timeout: 10000 });

    const on = await page.request.patch(`${E2E_BASE}/api/projects/${projectId}`, {
      data: { incognito: false },
    });
    expect(on.ok()).toBeTruthy();
    await expect(mark, "e tornare indietro deve riportarlo").toBeVisible({ timeout: 10000 });
  });

  test("SHAREORG-03: tolta l'altra persona, il progetto non è più condiviso con nessuno", async ({ page }) => {
    // The rule this file defends, seen from outside: the organisation stays on
    // the project — `org_id` does not change — and the mark goes away anyway,
    // because there is nobody left to read it.
    //
    // The reload here is not a shortcut: no frame carries membership (that is
    // stated in `projectSharingStore`), so a change of members is NOT a live
    // event. Pretending otherwise with a longer wait would give a test that
    // passes for the wrong reason.
    await goToApp(page);
    await expect(page.getByTestId(TAB).first().getByTestId("pane-tab-shared-org"))
      .toBeVisible({ timeout: 15000 });

    const via = await page.request.delete(
      `${E2E_BASE}/api/auth/orgs/${orgId}/members?personId=${encodeURIComponent(mateId)}`,
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
