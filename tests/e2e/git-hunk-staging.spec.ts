/**
 * Mettere in stage UN PEZZO di file.
 *
 * Prima si poteva solo `git add <file>`, tutto o niente: un fix e un
 * rimaneggiamento fatti nella stessa sessione finivano nello stesso commit per
 * il solo motivo di stare nello stesso file.
 *
 * Che la patch ricostruita sia valida lo provano i test unitari di
 * `server/lib/git-hunks.ts`, che applicano per davvero con `git apply` su repo
 * veri. Qui si prova il resto: che la lista dei blocchi arrivi fino allo
 * schermo, che il bottone agisca su QUEL blocco, e che il file su disco non
 * venga toccato da uno stage.
 *
 * @covers FILE-02
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { initGitRepo } from "./helpers/file-project";
import { execFileSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";

hermetic(test);

const PROJ = `/tmp/e2e-hunk-${Date.now()}`;
const FILE = `${PROJ}/f.txt`;

const base = () => Array.from({ length: 40 }, (_, i) => `riga ${i + 1}\n`);

function scriviTreBlocchi() {
  const l = base();
  l[2] = "riga 3 MODIFICATA\n";              // blocco in cima
  l.splice(10, 0, "riga NUOVA A\n");         // blocco in mezzo
  l.splice(26, 2);                           // blocco in fondo
  writeFileSync(FILE, l.join(""));
}

function git(args: string[]): string {
  // Identita' via `-c`: vedi la nota in `helpers/file-project.ts:initGitRepo`.
  // Senza, su CI ogni `commit` muore con «Please tell me who you are».
  return execFileSync("git", ["-c", "user.email=e2e@test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", ...args], { cwd: PROJ, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

test.describe("stage di un blocco alla volta", () => {
  test.beforeAll(() => {
    mkdirSync(PROJ, { recursive: true });
    writeFileSync(FILE, base().join(""));
    initGitRepo(PROJ, "primo");
  });
  test.beforeEach(() => {
    // Ogni test riparte dalle stesse tre modifiche: quello prima puo' averne
    // messa in stage una.
    git(["reset", "-q", "HEAD", "--", "."]);
    git(["checkout", "--", "."]);
    scriviTreBlocchi();
  });
  test.afterAll(() => rmSync(PROJ, { recursive: true, force: true }));

  test("elenca i blocchi e ne mette in stage uno solo, senza toccare il file", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    const git0 = win.locator('[data-testid="git-changes"]');
    await expect(git0).toBeVisible({ timeout: 10000 });
    if (!(await git0.locator('[title="f.txt"]').first().isVisible().catch(() => false))) {
      await git0.locator("div").filter({ hasText: /^Git$/ }).first().click();
    }

    // Aprire il file mostra il diff, e con lui i blocchi.
    await git0.locator('[title="f.txt"]').first().click();

    const blocchi = win.locator('[data-testid="hunk-actions"]');
    await expect(blocchi).toBeVisible({ timeout: 15000 });
    const righe = blocchi.locator('[data-testid="hunk-row"]');
    await expect(righe).toHaveCount(3, { timeout: 10000 });

    // Ogni riga dice dove comincia e quanto muove: e' cio' che serve a
    // scegliere senza rileggersi il diff.
    await expect(righe.nth(1)).toContainText("+1");

    // Stage del blocco in mezzo.
    await righe.nth(1).hover();
    await righe.nth(1).getByTitle("Metti in stage questo blocco").click();

    // Nell'indice c'e' SOLO quel blocco.
    await expect
      .poll(() => git(["diff", "--cached", "--", "f.txt"]), { timeout: 10000 })
      .toContain("riga NUOVA A");
    const staged = git(["diff", "--cached", "--", "f.txt"]);
    expect(staged).not.toContain("riga 3 MODIFICATA");
    expect(staged).not.toContain("-riga 27");

    // E il file su disco non e' stato toccato: stage non e' scrittura.
    expect(readFileSync(FILE, "utf8")).toContain("riga 3 MODIFICATA");
  });

  test("un file con un blocco solo non mostra la lista", async ({ page, request }) => {
    // Con un blocco solo i bottoni sarebbero la stessa cosa di quelli per file
    // che stanno gia' sulla riga della lista: due strade per la stessa azione.
    writeFileSync(FILE, base().join("").replace("riga 3\n", "riga 3 SOLA MODIFICA\n"));

    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    const git0 = win.locator('[data-testid="git-changes"]');
    await expect(git0).toBeVisible({ timeout: 10000 });
    if (!(await git0.locator('[title="f.txt"]').first().isVisible().catch(() => false))) {
      await git0.locator("div").filter({ hasText: /^Git$/ }).first().click();
    }
    await git0.locator('[title="f.txt"]').first().click();

    // Il diff si apre lo stesso: e' la lista dei blocchi a non servire.
    await expect(win.locator(".cm-editor").first()).toBeVisible({ timeout: 15000 });
    await expect(win.locator('[data-testid="hunk-actions"]')).toHaveCount(0);
  });
});
