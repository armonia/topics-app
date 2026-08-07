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

  test("cronologia e remotes stanno in fondo, attaccati, e le righe sulla stessa griglia", async ({ page, request }) => {
    // Due difetti misurati, non visti a occhio:
    //  1. I remotes stavano DENTRO lo scroller, che e' `flex-1`: da CHIUSI
    //     restava una striscia vuota di 9,5px sotto di loro, e la cronologia
    //     stava piu' giu' ancora, incollata al fondo. Due pie' di pagina a
    //     quote diverse con un vuoto in mezzo.
    //  2. Le righe della cronologia erano alte 24px contro i 25,5 di quelle
    //     delle modifiche (`text-[12px]` contro la misura ereditata): due liste
    //     nella stessa colonna fuori griglia, e l'evidenziazione al passaggio
    //     del mouse lo mostrava riga per riga.
    // Serve un albero SPORCO: con zero modifiche la lista dei file non si monta
    // e con lei non c'e' lo scroller su cui il pie' di pagina deve appoggiarsi.
    writeFileSync(`${PROJ}/README.md`, "riga uno\nriga due\nriga tre\nriga quattro\n");

    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    const storia = await apriStoria(win);
    const pannello = win.locator('[data-testid="git-changes"]');
    // Il file e' stato scritto FUORI dall'app: che arrivi al pannello dipende
    // dal watcher dei file, che ora ricalcola anche lo stato git (senza, non
    // toccando `.git`, non lo notava nessuno fino al poll — 60s col WS attivo).
    await expect(pannello.locator('[title="README.md"]').first()).toBeVisible({ timeout: 10000 });

    const geometria = () => pannello.evaluate((root: HTMLElement) => {
      const bordi = (el: Element | null) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: +b.top.toFixed(1), bot: +b.bottom.toFixed(1), h: +b.height.toFixed(1) };
      };
      const remotes = [...root.querySelectorAll("button")]
        .find(b => /^Remotes|^Add remote/.test(b.textContent || ""))?.closest("div.border-t") ?? null;
      return {
        pannello: bordi(root),
        scroller: bordi(root.querySelector(".overflow-y-auto")),
        remotes: bordi(remotes),
        cronologia: bordi(root.querySelector('[data-testid="commit-history"]')),
      };
    });

    // ── Sezioni CHIUSE: e' lo stato di cui l'utente si e' lamentato ──────────
    const chiuse = await geometria();
    // La lista dei file ha spazio vero: lo scroller non e' schiacciato.
    expect(chiuse.scroller!.h).toBeGreaterThan(20);
    // E ogni pezzo comincia dove finisce quello prima, senza strisce vuote.
    expect(chiuse.remotes!.top).toBeCloseTo(chiuse.scroller!.bot, 0);
    expect(chiuse.cronologia!.top).toBeCloseTo(chiuse.remotes!.bot, 0);
    // L'ultima sezione arriva a filo del pannello: l'aria sotto il suo testo
    // sta DENTRO la riga (`py-2`), non in un rientro del contenitore.
    expect(chiuse.cronologia!.bot).toBeCloseTo(chiuse.pannello!.bot, 0);

    // ── Cronologia APERTA: scorre dentro di se', non sfonda il pannello ──────
    await storia.getByRole("button", { name: /Cronologia/ }).click();
    await expect(storia.locator('[data-testid="commit-row"]').first()).toBeVisible({ timeout: 10000 });
    const aperta = await geometria();
    expect(aperta.cronologia!.bot).toBeLessThanOrEqual(aperta.pannello!.bot + 0.5);

    // ── Stessa griglia: una riga di commit e una riga di modifica ────────────
    const misura = (loc: import("@playwright/test").Locator) =>
      loc.evaluate((el: HTMLElement) => {
        const b = el.getBoundingClientRect();
        return { h: +b.height.toFixed(1), x: +b.x.toFixed(1), padL: getComputedStyle(el).paddingLeft };
      });
    const rigaCommit = await misura(storia.locator('[data-testid="commit-row"]').first());
    const rigaFile = await misura(pannello.locator('[title="README.md"]').first());
    expect(rigaCommit.h).toBe(rigaFile.h);
    expect(rigaCommit.x).toBe(rigaFile.x);
    expect(rigaCommit.padL).toBe(rigaFile.padL);

    git(["checkout", "--", "README.md"]);
  });

  test("con l'albero PULITO il piede resta in fondo, e l'icona git non e' accesa", async ({ page, request }) => {
    // Il caso che il test qui sopra NON copre, perche' quello sporca l'albero
    // apposta per avere lo scroller. Con zero modifiche al posto della lista
    // c'e' un messaggio corto, che non e' `flex-1` e quindi non spinge niente:
    // il pie' di pagina si appoggiava a quel messaggio e tutto lo spazio
    // restante finiva SOTTO la cronologia. Stesso difetto di prima, stato
    // opposto.
    await resetPaneStore(request, []);
    await seedProjectPane(request, PROJ);
    await waitForPaneStoreQuiet(request);

    await goToApp(page);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const win = page.locator(`[data-testid="project-window"][data-project-path="${PROJ}"]`);
    const storia = await apriStoria(win);
    const pannello = win.locator('[data-testid="git-changes"]');

    // Albero pulito: il messaggio c'e', la lista no.
    await expect(pannello.getByText(/Albero di lavoro pulito|Clean working tree/)).toBeVisible({ timeout: 10000 });
    expect(storia).toBeTruthy();

    const g = await pannello.evaluate((root: HTMLElement) => {
      const b = (el: Element | null) => el ? { top: +el.getBoundingClientRect().top.toFixed(1), bot: +el.getBoundingClientRect().bottom.toFixed(1) } : null;
      return { pannello: b(root), cronologia: b(root.querySelector('[data-testid="commit-history"]')) };
    });
    expect(g.cronologia!.bot).toBeCloseTo(g.pannello!.bot, 0);

    // Il RITMO del piede: la cronologia respira come la riga sopra, e in modo
    // SIMMETRICO. E' l'invariante che serviva: la prima correzione aggiunse
    // aria solo SOTTO il testo (8px) e lascio' 4px sopra — mezzo problema
    // risolto, e la riga restava piu' bassa di 9px della sua vicina.
    const ritmo = await pannello.evaluate((root: HTMLElement) => {
      const misura = (riga: Element | null, testo: Element | null) => {
        if (!riga || !testo) return null;
        const r = riga.getBoundingClientRect(), t = testo.getBoundingClientRect();
        return { sopra: +(t.top - r.top).toFixed(1), sotto: +(r.bottom - t.bottom).toFixed(1) };
      };
      const cron = root.querySelector('[data-testid="commit-history"]');
      const addRemote = [...root.querySelectorAll("button")]
        .find(b => /^Add remote|^Remotes/.test(b.textContent || "")) ?? null;
      return {
        cron: misura(cron?.firstElementChild ?? null, cron?.querySelector("button") ?? null),
        vicina: misura(addRemote?.closest("div") ?? null, addRemote),
        fondo: cron?.querySelector("button")
          ? +(root.getBoundingClientRect().bottom
              - cron.querySelector("button")!.getBoundingClientRect().bottom).toFixed(1)
          : null,
      };
    });
    // Simmetrica: tanta aria sopra quanta sotto.
    expect(ritmo.cron!.sopra).toBeCloseTo(ritmo.cron!.sotto, 0);
    // E lo stesso passo della riga che le sta sopra (±1px per il bordo).
    expect(Math.abs(ritmo.cron!.sopra - ritmo.vicina!.sopra)).toBeLessThanOrEqual(1.5);
    // Che e' anche l'aria fino al fondo del pannello.
    expect(ritmo.fondo).toBeCloseTo(8, 0);

    // E l'icona di git non e' colorata: sta accanto alla pastiglia del
    // conteggio e alle frecce ahead/behind, che il colore ce l'hanno per dire
    // qualcosa. Un blu sempre acceso non e uno stato. Le sorelle File e
    // Processi non sono colorate: il confronto e' con loro, non con un valore
    // scritto a mano.
    const colori = await win.evaluate((root: HTMLElement) => {
      const iconaDi = (etichetta: string) => {
        const riga = [...root.querySelectorAll("div")]
          .find(d => d.className.includes("h-8") && (d.textContent || "").trim().startsWith(etichetta));
        const svg = riga?.querySelector("svg");
        return svg ? getComputedStyle(svg).color : null;
      };
      return { git: iconaDi("Git"), file: iconaDi("File"), processi: iconaDi("Processi") };
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

  test("un repo SENZA commit non mostra affatto la sezione Cronologia", async ({ page, request }) => {
    // Un accordion che, aperto, puo' solo dire «Nessun commit» e' un controllo
    // che promette qualcosa e non ha niente da dare. E non serve chiedere la
    // lista per saperlo: `lastCommit.hash` e' vuoto quando `git log -1` esce
    // non-zero, cioe' esattamente quando la storia non c'e'.
    const VUOTO = `/tmp/e2e-storia-vuota-${Date.now()}`;
    mkdirSync(VUOTO, { recursive: true });
    writeFileSync(`${VUOTO}/nuovo.txt`, "mai committato\n");
    execFileSync("git", ["init", "-q", "."], { cwd: VUOTO, stdio: "pipe" });
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
      if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();

      // Il pannello c'e' e funziona: il file non tracciato si vede.
      await expect(pannello.locator('[data-git-file="nuovo.txt"]').first()).toBeVisible({ timeout: 10000 });
      // La cronologia no.
      await expect(pannello.locator('[data-testid="commit-history"]')).toHaveCount(0);
    } finally {
      rmSync(VUOTO, { recursive: true, force: true });
    }
  });
});
