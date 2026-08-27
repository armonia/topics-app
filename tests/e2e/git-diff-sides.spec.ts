/**
 * «Staged» e «Changes» mostrano due diff DIVERSI, e un rename non è un file nuovo.
 *
 * C'era una coppia sola per tutti: `HEAD` a sinistra e il file su disco a
 * destra. Cliccare un file sotto «Staged» e cliccarlo sotto «Changes» dava lo
 * stesso identico diff — e non era nessuno dei due, era la SOMMA.
 *
 * Il caso che lo rende grave è `MM`, cioè un file messo in stage a metà: è
 * l'uscita GARANTITA dello staging per blocco di questo stesso pannello. Chi lo
 * usa vedeva sotto anche ciò che non aveva messo in stage, e non poteva
 * rispondere alla domanda che ci si fa prima di ogni commit: «cosa sto per
 * committare?». Nel frattempo `LineStat`, sulla stessa riga, mostrava numeri
 * diversi per gruppo — il pannello si contraddiceva da solo.
 *
 * E il rename: il lato sinistro si chiedeva col nome NUOVO, `git show
 * HEAD:<nuovo>` esce non-zero e la rotta risponde 200 con corpo vuoto. Lato
 * sinistro bianco, file intero in verde: un rename con una riga cambiata si
 * presentava come il file intero aggiunto.
 *
 * @covers FILE-02
 */
import { expect } from "@playwright/test";
import { test } from "./fixtures/file-explorer.fixture";
import { resetPaneStore } from "./helpers/api-fixtures";
import { seedFileProject, cleanupFileProject, type FileProject } from "./helpers/file-project";
import { hermetic } from "./fixtures/hermetic";
import { execFileSync } from "child_process";
import { writeFileSync } from "fs";

hermetic(test);

test.describe("i due lati del diff", () => {
  let project: FileProject | undefined;
  let topicId = "";
  let tmpDir = "";
  let topicName = "";

  // L'identita' viaggia CON il comando: senza, `git commit` passa sul portatile
  // di chi scrive (config globale) e fallisce sul runner, che non ne ha —
  // «Author identity unknown». Vedi la stessa costante in
  // git-commit-history.spec.ts e in helpers/file-project.ts.
  const git = (dir: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=e2e", "-c", "user.email=e2e@test", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir, encoding: "utf-8" },
    );

  test.beforeAll(async ({ request }) => {
    project = await seedFileProject(request, "diff-sides");
    ({ topicId, tmpDir, topicName } = project);

    // Un file `MM`: una riga in stage, un'altra solo sul disco. Tre contenuti
    // genuinamente diversi — HEAD, indice, disco — così ogni coppia sbagliata
    // si vede.
    writeFileSync(`${tmpDir}/mm.txt`, "a\nb\nc\nd\ne\nf\ng\nh\n");
    git(tmpDir, "add", "mm.txt");
    git(tmpDir, "commit", "-m", "base mm", "--no-gpg-sign");
    writeFileSync(`${tmpDir}/mm.txt`, "IN-STAGE\nb\nc\nd\ne\nf\ng\nh\n");
    git(tmpDir, "add", "mm.txt");
    writeFileSync(`${tmpDir}/mm.txt`, "IN-STAGE\nb\nc\nd\ne\nf\ng\nSUL-DISCO\n");
  });

  test.beforeEach(async ({ request }) => {
    if (topicId) await resetPaneStore(request, [topicId]);
  });
  test.afterAll(async ({ request }) => {
    await cleanupFileProject(request, project);
  });

  test("la rotta serve tre contenuti diversi: HEAD, indice, disco", async ({ request }) => {
    // La prova più stretta, prima della UI: se il server non sa dare l'indice,
    // nessuna coppia può essere giusta.
    const q = (extra: string) =>
      `/api/git/show?path=${encodeURIComponent(tmpDir)}&file=mm.txt${extra}`;

    const head = await (await request.get(q(""))).text();
    const indice = await (await request.get(q("&side=index"))).text();
    const disco = await (await request.get(
      `/api/files/content?path=${encodeURIComponent(`${tmpDir}/mm.txt`)}`,
    )).text();

    expect(head).toContain("a\nb");
    expect(head).not.toContain("IN-STAGE");

    expect(indice).toContain("IN-STAGE");
    expect(indice).not.toContain("SUL-DISCO");

    expect(disco).toContain("IN-STAGE");
    expect(disco).toContain("SUL-DISCO");

    // I tre sono diversi a due a due: è tutto il punto.
    expect(head).not.toBe(indice);
    expect(indice).not.toBe(disco);
  });

  test("un `side` inventato viene rifiutato invece di finire in un comando", async ({ request }) => {
    // `side` compone un argomento di `git show`: accetta un valore solo, e
    // tutto il resto è 400. Il cancello sui due punti della `rev` resta intatto
    // proprio per questo.
    const r = await request.get(
      `/api/git/show?path=${encodeURIComponent(tmpDir)}&file=mm.txt&side=qualunque`,
    );
    expect(r.status()).toBe(400);
  });

  test("lo stesso file MM compare in due righe, ognuna col suo gruppo", async ({
    fileExplorerPage,
    page,
  }) => {
    // Il gruppo sulla riga e' cio' che poi viaggia fino a `handleFileClick` e
    // decide QUALE coppia si confronta. Senza, le due liste aprivano lo stesso
    // diff — che non era nessuno dei due.
    //
    // L'intestazione con le due etichette vive nella vista PIENA di
    // `GitChanges`, che e' un pannello a parte (`ProjectWindow`, view `git`) e
    // non la barra laterale: le coppie in se' sono verificate sopra contro la
    // rotta, e la scelta della coppia in `diffEndpoints.test.ts`.
    await fileExplorerPage.gotoProject(tmpDir, topicName);
    const gitChanges = page.locator('[data-testid="git-changes"]');
    await expect(gitChanges).toBeVisible({ timeout: 15000 });
    const header = gitChanges.locator('[data-testid="project-sidebar-git"]');
    // L'ETICHETTA, non il centro: al centro della riga c'e' il nome del ramo,
    // che e' un CONTROLLO — cliccarlo apre la sua tendina e la sezione resta
    // chiusa (misurato con `elementFromPoint`).
    if ((await header.getAttribute("aria-expanded")) !== "true") {
      await header.getByText("Git", { exact: true }).click();
    }

    // Due righe per lo stesso file: e' cosa vuol dire `MM`.
    await expect(gitChanges.locator('[data-git-file="mm.txt"]')).toHaveCount(2, { timeout: 10000 });
    await expect(gitChanges.locator('[data-git-file="mm.txt"][data-git-group="staged"]')).toHaveCount(1);
    await expect(gitChanges.locator('[data-git-file="mm.txt"][data-git-group="unstaged"]')).toHaveCount(1);
  });

  test("un rename mostra il nome vecchio a sinistra, non un file comparso dal nulla", async ({
    request,
  }) => {
    // `git mv` + una riga cambiata. Col nome NUOVO a sinistra la rotta risponde
    // vuoto (a HEAD quel nome non c'era) e il diff dichiara tutto aggiunto;
    // col nome VECCHIO risponde il contenuto, e il diff è una riga.
    writeFileSync(`${tmpDir}/vecchio.md`, "riga uno\nriga due\nriga tre\n");
    git(tmpDir, "add", "vecchio.md");
    git(tmpDir, "commit", "-m", "base rename", "--no-gpg-sign");
    git(tmpDir, "mv", "vecchio.md", "nuovo.md");
    writeFileSync(`${tmpDir}/nuovo.md`, "riga uno\nriga DUE\nriga tre\n");
    git(tmpDir, "add", "nuovo.md");

    const q = (file: string) =>
      `/api/git/show?path=${encodeURIComponent(tmpDir)}&file=${encodeURIComponent(file)}`;

    const newColName = await (await request.get(q("nuovo.md"))).text();
    const oldColName = await (await request.get(q("vecchio.md"))).text();

    // Il difetto in una riga: col nome nuovo non c'è niente da confrontare.
    expect(newColName.trim()).toBe("");
    expect(oldColName).toContain("riga due");
  });
});
