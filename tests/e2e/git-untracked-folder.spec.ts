/**
 * Una cartella aperta come progetto, ma non tracciata dal repo che la contiene.
 *
 * Caso reale: `match-compass` dentro `.openclaw/workspace`. Git non elenca i
 * file che ci sono dentro, collassa tutto in `?? match-compass/`. Il pannello
 * mostrava «1 modifica» con una riga senza nome, e accanto le branch e i remote
 * del repo di sopra, che sembravano di questa cartella.
 *
 * @covers FILE-02
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { canonicalTmpDir, initGitRepo } from "./helpers/file-project";
import { mkdirSync, rmSync, writeFileSync } from "fs";

hermetic(test);

// Canonical spelling (`/private/tmp` on macOS): it is the one the window
// carries, see `canonicalTmpDir`.
const REPO = canonicalTmpDir("e2e-host-repo");
const INNER = `${REPO}/progetto-non-tracciato`;

test.describe("git: cartella non tracciata dal repo che la contiene", () => {
  test.beforeAll(() => {
    mkdirSync(REPO, { recursive: true });
    writeFileSync(`${REPO}/README.md`, "repo ospite\n");
    initGitRepo(REPO, "primo");
    // La sottocartella nasce DOPO il commit, quindi il repo non la conosce.
    mkdirSync(INNER, { recursive: true });
    writeFileSync(`${INNER}/a.txt`, "uno\n");
    writeFileSync(`${INNER}/b.txt`, "due\n");
  });
  test.afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("lo dice, offre di creare un repo qui, e non presta i controlli del repo ospite", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, INNER);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${INNER}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    const git = win.locator('[data-testid="git-changes"]');
    await expect(git).toBeVisible({ timeout: 10000 });
    await git.locator("div").filter({ hasText: /^Git$/ }).first().click();

    // Lo stato viene detto per nome, col repo che lo causa.
    await expect(git.getByText(/Non tracciata dal repo «e2e-host-repo/)).toBeVisible({ timeout: 15000 });

    // Nessuna riga fantasma: il record `?? <cartella>/` non e un file.
    await expect(git.locator("span").filter({ hasText: /^U$/ })).toHaveCount(0);

    // L'azione che scioglie la situazione c'e, e viene prima dei remote.
    await expect(git.getByRole("button", { name: /Crea un repository qui/ })).toBeVisible();
    // La lista dei file non si monta, quindi con lei non si monta nemmeno la
    // sezione dei remote del repo ospite.
    // I remotes non stanno piu' nel pannello in nessun caso: li elenca
    // `BranchList` dentro il popover del ramo. Qui resta il punto vero — dal
    // pannello di una cartella non tracciata non si presta NIENTE del repo che
    // la ospita — e lo dice l'assenza del selettore di ramo qui sotto.
    await expect(git.locator("button").filter({ hasText: /^Remotes/ })).toHaveCount(0);
    await expect(git.locator("button").filter({ hasText: /^(Staged|Changes)/ })).toHaveCount(0);

    // Il ramo del repo ospite si legge ma non si apre: un checkout da qui
    // cambierebbe il repo di sopra sotto ai piedi dell'utente.
    const labelBranch = git.locator("span").filter({ hasText: /e2e-host-repo.+ · main/ });
    await expect(labelBranch).toHaveCount(1);
    await expect(git.locator("button").filter({ hasText: /· main$/ })).toHaveCount(0);
  });
});
