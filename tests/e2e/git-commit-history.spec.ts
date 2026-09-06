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
 *
 * @covers FILE-02
 */
import { test, expect, type Locator } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore, seedProjectPane, waitForPaneStoreQuiet } from "./helpers/api-fixtures";
import { canonicalTmpDir, initGitRepo } from "./helpers/file-project";
import { execFileSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync, unlinkSync } from "fs";

hermetic(test);

// Canonical spelling (`/private/tmp` on macOS): it is the one the window
// carries, see `canonicalTmpDir`.
const PROJ = canonicalTmpDir("e2e-storia");
/**
 * A LOCAL (bare) remote holding only the first commit: the repo stays two
 * commits AHEAD.
 *
 * Not decoration. Since PROJECT-12 the sidebar's git section does not exist on
 * a clean repo aligned with its upstream — and with it goes the history
 * button, which lives in its header. These tests are about the CLEAN tree
 * (everything committed, nothing to stage), and the one state in which the
 * sidebar still shows the section without dirtying the tree is exactly what
 * the spec calls "unpushed commits": work in flight, not cleanliness. The
 * panel keeps saying "clean working tree", which is the case measured here.
 */
const REMOTE = `${PROJ}-remote.git`;

/**
 * L'identita' viaggia CON il comando, non con la macchina.
 *
 * Un `git commit` senza `user.name`/`user.email` non fallisce sul portatile di
 * chi scrive il test — lo salva la config globale — e fallisce sul runner, che
 * non ne ha nessuna: «Author identity unknown. *** Please tell me who you are.»
 * Questo file ne aveva gia' la prova a due passi di distanza (il repo VUOTO piu'
 * sotto fa `git config user.email`), ma il repo principale no. Passandola con
 * `-c` a ogni invocazione il test non dipende piu' da com'e' configurata la
 * macchina che lo esegue. `commit.gpgsign=false` per la stessa ragione: una
 * chiave di firma e' un'altra cosa che il runner non ha.
 */
const IDENTITA = [
  "-c", "user.name=e2e",
  "-c", "user.email=e2e@test",
  "-c", "commit.gpgsign=false",
];

function git(args: string[]) {
  execFileSync("git", [...IDENTITA, ...args], { cwd: PROJ, stdio: "pipe" });
}
/**
 * Il popover della cronologia, aperto dal suo bottone nella riga d'intestazione.
 *
 * Era una fascia nel PIEDE del pannello, e da li' e' stata tolta: competeva con
 * la lista dei file per l'altezza di un pannello che puo' scendere a 160px, e a
 * perdere era sempre lei — tagliata, schiacciata, senza aria. Il popover si
 * clampa allo SCHERMO, quindi quella competizione non esiste piu'.
 *
 * Il popover vive in un PORTALE su document.body: si cerca dalla pagina, non
 * dentro `[data-testid="git-changes"]`.
 */
async function openHistory(win: Locator): Promise<Locator> {
  const git = win.locator('[data-testid="git-changes"]');
  await expect(git).toBeVisible({ timeout: 10000 });
  const head = git.locator('[data-testid="project-sidebar-git"]');
  // L'ETICHETTA, non il centro della riga: al centro c'e' il nome del ramo, che
  // e' un controllo e apre la sua tendina invece di espandere la sezione.
  if ((await head.getAttribute("aria-expanded")) !== "true") {
    await head.getByText("Git", { exact: true }).click();
  }
  const bottone = git.locator('[data-testid="git-history-button"]');
  await expect(bottone).toBeVisible({ timeout: 10000 });
  if ((await bottone.getAttribute("aria-expanded")) !== "true") await bottone.click();
  const pop = win.page().locator('[data-testid="git-history-popover"]');
  await expect(pop).toBeVisible({ timeout: 10000 });
  return pop;
}

test.describe("cronologia dei commit", () => {
  test.beforeAll(() => {
    mkdirSync(`${PROJ}/src`, { recursive: true });
    writeFileSync(`${PROJ}/README.md`, "riga uno\n");
    writeFileSync(`${PROJ}/src/vecchio.ts`, "export const a = 1;\n");
    initGitRepo(PROJ, "il primo commit");
    // The remote is born NOW and receives only this commit: the two that
    // follow stay unpushed (see `REMOTE`).
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", REMOTE], { stdio: "pipe" });
    git(["remote", "add", "origin", REMOTE]);
    git(["push", "-q", "-u", "origin", "main"]);

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

  test.afterAll(() => {
    rmSync(PROJ, { recursive: true, force: true });
    rmSync(REMOTE, { recursive: true, force: true });
  });

  test("elenca i commit, e ogni commit dice quali file e quante righe", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    await expect(win).toHaveCount(1, { timeout: 15000 });

    // Prima di aprire, git non e' stato interrogato: il popover non esiste
    // nemmeno nel DOM, e con lui la lista dei commit.
    await expect(page.locator('[data-testid="git-history-popover"]')).toHaveCount(0);

    const storia = await openHistory(win);

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

  test("la cronologia sta in un POPOVER, che si clampa allo schermo", async ({ page, request }) => {
    // Il difetto che questo chiude: la cronologia era una fascia nel piede del
    // pannello e competeva con la lista dei file per l'altezza. Tre correzioni
    // di fila l'hanno mancata (padding, ritmo, comprimibilita'), perche' il
    // problema non era una misura ma il POSTO. In un popover non c'e' piu'
    // niente da spartire: il tetto e' lo spazio sotto il bottone.
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);
    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    const pop = await openHistory(win);
    await expect(pop.locator('[data-testid="commit-row"]').first()).toBeVisible({ timeout: 10000 });

    const g = await pop.evaluate((el: HTMLElement) => {
      const b = el.getBoundingClientRect();
      return {
        top: +b.top.toFixed(1), bot: +b.bottom.toFixed(1),
        left: +b.left.toFixed(1), right: +b.right.toFixed(1),
        vw: window.innerWidth, vh: window.innerHeight,
      };
    });
    // Dentro lo schermo su tutt'e quattro i lati, col margine del sistema.
    expect(g.top).toBeGreaterThanOrEqual(0);
    expect(g.left).toBeGreaterThanOrEqual(0);
    expect(g.right).toBeLessThanOrEqual(g.vw);
    expect(g.bot).toBeLessThanOrEqual(g.vh);

    // E il pannello non ha piu' un piede: ne' cronologia ne' remotes dentro.
    const pannello = win.locator('[data-testid="git-changes"]');
    await expect(pannello.locator('[data-testid="commit-history"]')).toHaveCount(0);
    await expect(pannello.locator("button").filter({ hasText: /^Remotes|^Add remote/ })).toHaveCount(0);
  });

  test("la riga d'intestazione non trabocca a barra STRETTA", async ({ page, request }) => {
    // Misurato prima: a 160px (il minimo trascinabile) la riga sforava di
    // 58,6px — i due gruppi erano entrambi `flex-shrink-0`, quindi il testo
    // usciva dal pannello invece di troncare.
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);
    await page.addInitScript(([path]) => {
      try {
        sessionStorage.setItem(`project-sidebar-width:${path}`, "160");
        sessionStorage.setItem(`sidebar-sections:${path}`, JSON.stringify({ files: true, git: true, processes: false }));
      } catch { /* niente sessionStorage */ }
    }, [PROJ] as [string]);
    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    const riga = win.locator('[data-testid="project-sidebar-git"]');
    await expect(riga).toBeVisible({ timeout: 15000 });

    const sforo = await riga.evaluate((el: HTMLElement) => {
      const cs = getComputedStyle(el);
      const dentro = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const usato = [...el.children].reduce((s, c) => s + c.getBoundingClientRect().width, 0);
      return +(usato - dentro).toFixed(1);
    });
    expect(sforo).toBeLessThanOrEqual(0.5);
  });


  test("con l'albero PULITO la cronologia resta raggiungibile, e l'icona git non e' accesa", async ({ page, request }) => {
    // Clean but not aligned: two commits ahead of the remote (see `REMOTE`).
    // Since PROJECT-12 it is the only state in which the sidebar shows the
    // section with no file to stage — hence the only one in which the "clean
    // working tree" message and the history button are on screen together.
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    const pannello = win.locator('[data-testid="git-changes"]');
    await expect(pannello).toBeVisible({ timeout: 15000 });
    const head = pannello.locator('[data-testid="project-sidebar-git"]');
    // L'ETICHETTA, non il centro: al centro della riga c'e' il nome del ramo,
    // che e' un CONTROLLO — cliccarlo apre la sua tendina e la sezione resta
    // chiusa (misurato con `elementFromPoint`).
    if ((await head.getAttribute("aria-expanded")) !== "true") {
      await head.getByText("Git", { exact: true }).click();
    }

    // Albero pulito: il messaggio c'e', la lista no. Ed e' proprio lo stato in
    // cui il vecchio piede si comportava peggio — al posto della lista c'era un
    // messaggio corto che non spinge, e tutto lo spazio finiva sotto la
    // cronologia. Ora la cronologia non e' nel pannello: il caso non esiste.
    await expect(pannello.getByText(/Albero di lavoro pulito|Clean working tree/)).toBeVisible({ timeout: 10000 });
    // Ma resta raggiungibile: il bottone c'e' anche ad albero pulito, perche'
    // dei commit ce ne sono.
    const pop = await openHistory(win);
    await expect(pop.locator('[data-testid="commit-row"]').first()).toBeVisible({ timeout: 10000 });

    // E l'icona di git non e' colorata: sta accanto alla pastiglia del
    // conteggio e alle frecce ahead/behind, che il colore ce l'hanno per dire
    // qualcosa. Un blu sempre acceso non e uno stato. Le sorelle File e
    // Processi non sono colorate: il confronto e' con loro, non con un valore
    // scritto a mano.
    const colori = await win.evaluate((root: HTMLElement) => {
      // PER TESTID, non per classe di layout. Cercava `className.includes("h-8")`,
      // cioe' l'altezza che quelle intestazioni avevano: da quando sono card
      // (`h-9 md:h-7`, vedi SECTION_CARD) quel filtro non trova piu' niente e
      // il test e' andato rosso su un cambio di GEOMETRIA mentre credeva di
      // parlare di COLORI. I testid ci sono gia' e non si muovono con lo stile.
      const iconOf = (testid: string) => {
        const riga = root.querySelector(`[data-testid="project-sidebar-${testid}"]`);
        const svg = riga?.querySelector("svg");
        return svg ? getComputedStyle(svg).color : null;
      };
      return { git: iconOf("git"), file: iconOf("files"), processi: iconOf("processes") };
    });
    expect(colori.git).not.toBeNull();
    expect(colori.git).toBe(colori.file ?? colori.processi);
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
    const storia = await openHistory(win);
    const righe = storia.locator('[data-testid="commit-row"]');
    await expect(righe).toHaveCount(3, { timeout: 10000 });

    await righe.last().click();
    const iniziale = storia.locator('[title="README.md"]');
    await expect(iniziale).toBeVisible({ timeout: 10000 });
    await expect(iniziale).toContainText("+1");
    await expect(storia).not.toContainText(/Error|errore/i);
  });

  test("un repo SENZA commit non mostra affatto la sezione Cronologia", async ({ page, request }) => {
    // Un accordion che, aperto, puo' solo dire «Nessun commit» e' un controllo
    // che promette qualcosa e non ha niente da dare. E non serve chiedere la
    // lista per saperlo: `lastCommit.hash` e' vuoto quando `git log -1` esce
    // non-zero, cioe' esattamente quando la storia non c'e'.
    const VUOTO = canonicalTmpDir("e2e-storia-vuota");
    mkdirSync(VUOTO, { recursive: true });
    writeFileSync(`${VUOTO}/nuovo.txt`, "mai committato\n");
    // `-b main`: senza, il ramo iniziale lo decide `init.defaultBranch` della
    // macchina — `main` dove qualcuno l'ha configurato, `master` sul runner.
    execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: VUOTO, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: VUOTO, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: VUOTO, stdio: "pipe" });

    try {
      await resetPaneStore(request, []);
      await seedProjectPane(request, VUOTO);
      await waitForPaneStoreQuiet(request);
      await goToApp(page);
      await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

      const win = page.locator(`[data-testid="project-window"][data-project-path="${VUOTO}"]`);
      const pannello = win.locator('[data-testid="git-changes"]');
      await expect(pannello).toBeVisible({ timeout: 15000 });
      const header = pannello.locator('[data-testid="project-sidebar-git"]');
      // Si clicca l'ETICHETTA, non il centro della riga: al centro c'e' il nome
  // del ramo, che e' un CONTROLLO — cliccarlo apre la tendina dei rami e la
  // sezione resta chiusa (misurato: `elementFromPoint` al centro restituisce
  // lo span del branch).
  if ((await header.getAttribute("aria-expanded")) !== "true") {
    await header.getByText("Git", { exact: true }).click();
  }

      // Il pannello c'e' e funziona: il file non tracciato si vede.
      await expect(pannello.locator('[data-git-file="nuovo.txt"]').first()).toBeVisible({ timeout: 10000 });
      // La cronologia no.
      await expect(pannello.locator('[data-testid="commit-history"]')).toHaveCount(0);
    } finally {
      rmSync(VUOTO, { recursive: true, force: true });
    }
  });

  /**
   * Il piede regge lo SPAZIO STRETTO senza tagliarsi.
   *
   * Tre correzioni di fila hanno sbagliato perche' ognuna guardava UNA misura:
   *  - il padding sotto (ma sopra restava meta');
   *  - il ritmo delle righe (ma a pannello stretto la sezione si accartocciava
   *    a 1px sui 33 naturali, con l'intestazione tagliata);
   *  - il piede reso incomprimibile (e allora sforava il fondo di 36px con la
   *    cronologia aperta).
   *
   * Qui le tre misure si guardano INSIEME, a due altezze e in due stati.
   */
});
