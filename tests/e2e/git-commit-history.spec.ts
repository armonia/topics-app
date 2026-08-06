/**
 * La cronologia dei commit.
 *
 * `/api/git/log` e `gitApi.log` esistevano da sempre e non li chiamava
 * NESSUNO: rotta e metodo erano codice morto che sembrava una funzionalita'.
 * Il pannello mostrava l'ultimo commit e basta.
 *
 * Si carica a strati e i test seguono gli strati: la lista quando apri la
 * sezione, i file quando apri un commit. Un `git show` per ogni commit in
 * lista sarebbe stato il modo piu' rapido di rendere lento il pannello.
 */
import { test, expect, type Locator } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { initGitRepo } from "./helpers/file-project";
import { execFileSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync, unlinkSync } from "fs";

hermetic(test);

const PROJ = `/tmp/e2e-storia-${Date.now()}`;

function git(args: string[]) {
  execFileSync("git", args, { cwd: PROJ, stdio: "pipe" });
}

/**
 * Il pannello Git aperto, cliccando l'intestazione SOLO se serve.
 *
 * Lo stato aperto/chiuso delle sezioni e' ricordato per progetto, quindi un
 * click al buio a volte apre e a volte chiude: il secondo test di questo file
 * partiva gia' aperto e il click lo richiudeva.
 */
async function apriStoria(win: Locator): Promise<Locator> {
  const git = win.locator('[data-testid="git-changes"]');
  await expect(git).toBeVisible({ timeout: 10000 });
  const storia = git.locator('[data-testid="commit-history"]');
  if (!(await storia.isVisible().catch(() => false))) {
    await git.locator("div").filter({ hasText: /^Git$/ }).first().click();
  }
  await expect(storia).toBeVisible({ timeout: 10000 });
  return storia;
}

test.describe("cronologia dei commit", () => {
  test.beforeAll(() => {
    mkdirSync(`${PROJ}/src`, { recursive: true });
    writeFileSync(`${PROJ}/README.md`, "riga uno\n");
    writeFileSync(`${PROJ}/src/vecchio.ts`, "export const a = 1;\n");
    initGitRepo(PROJ, "il primo commit");

    // Secondo commit: una modifica, un'aggiunta, una cancellazione, un rename.
    writeFileSync(`${PROJ}/README.md`, "riga uno\nriga due\nriga tre\n");
    writeFileSync(`${PROJ}/aggiunto.ts`, "export const b = 2;\n");
    git(["mv", "src/vecchio.ts", "src/nuovo.ts"]);
    git(["add", "-A", "--", "."]);
    git(["commit", "-m", "il secondo commit"]);

    // Terzo, cosi' la lista ne ha piu' di due e l'ordine si vede.
    unlinkSync(`${PROJ}/aggiunto.ts`);
    git(["add", "-A", "--", "."]);
    git(["commit", "-m", "il terzo commit"]);
  });

  test.afterAll(() => rmSync(PROJ, { recursive: true, force: true }));

  test("elenca i commit, e ogni commit dice quali file e quante righe", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    const storia = await apriStoria(win);

    // Da chiusa non chiede niente a git: e' una sezione che nessuno guarda.
    await expect(storia.locator('[data-testid="commit-row"]')).toHaveCount(0);

    await storia.getByRole("button", { name: /Cronologia/ }).click();

    const righe = storia.locator('[data-testid="commit-row"]');
    await expect(righe).toHaveCount(3, { timeout: 10000 });
    // Il piu' recente in cima, come `git log`.
    await expect(righe.first()).toContainText("il terzo commit");
    await expect(righe.last()).toContainText("il primo commit");

    // Aprendo un commit arrivano i suoi file, con cosa e' successo a ciascuno.
    await righe.nth(1).click();
    const secondo = storia.locator('[data-testid="commit-row"]').nth(1);
    await expect(secondo).toHaveAttribute("aria-expanded", "true");

    // README ha guadagnato due righe: e' il numero, non solo il nome.
    const readme = storia.locator('[title="README.md"]');
    await expect(readme).toBeVisible({ timeout: 10000 });
    await expect(readme).toContainText("+2");

    // Il rename porta il vecchio nome accanto al nuovo, altrimenti sembra un
    // file comparso dal nulla accanto a una cancellazione senza motivo.
    const rinominato = storia.locator('[title="src/vecchio.ts → src/nuovo.ts"]');
    await expect(rinominato).toBeVisible();
    await expect(rinominato).toContainText("vecchio.ts");

    // Un commit alla volta: aprire il terzo chiude il secondo.
    await righe.first().click();
    await expect(storia.locator('[data-testid="commit-row"]').nth(1)).toHaveAttribute("aria-expanded", "false");
  });

  test("il PRIMO commit si apre senza padre e mostra tutto come aggiunto", async ({ page, request }) => {
    // `<hash>^` non esiste sul commit iniziale: git esce non-zero e la rotta
    // risponde vuoto. E' la cosa giusta (un commit iniziale e' tutto aggiunto),
    // ma e' anche il punto in cui una gestione distratta mostra un errore.
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    const storia = await apriStoria(win);
    await storia.getByRole("button", { name: /Cronologia/ }).click();
    const righe = storia.locator('[data-testid="commit-row"]');
    await expect(righe).toHaveCount(3, { timeout: 10000 });

    await righe.last().click();
    const iniziale = storia.locator('[title="README.md"]');
    await expect(iniziale).toBeVisible({ timeout: 10000 });
    await expect(iniziale).toContainText("+1");
    await expect(storia).not.toContainText(/Error|errore/i);
  });
});
