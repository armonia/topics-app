import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "./fixtures/test-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";

/**
 * I PROFILI DEGLI AMICI, dal vivo — ed è la clip di consegna del task.
 *
 * Uno screenshot non prova un COMPORTAMENTO, e qui ce ne sono due: la riga di
 * una persona che si APRE mostrando profilo e numeri, e il login GitHub che si
 * SCRIVE e fa comparire la faccia. Per questo la prova è un video
 * (`E2E_EVIDENCE=1`), non un'immagine.
 *
 * NESSUNA RETE VERSO GITHUB, e il modo per ottenerlo NON è `page.route`: la
 * chiamata la fa il SERVER, non il browser, quindi intercettarla nella pagina
 * non intercetta niente (provato: la prima passata è tornata con la bio vera di
 * un profilo reale). Si semina invece la CACHE `github_profiles` con
 * `fetched_at` fresco, che è la stessa porta da cui passa la produzione: il
 * server la trova valida e non esce. La quota pubblica è di 60 richieste
 * all'ora — un test che la consuma diventa rosso il giorno in cui qualcun altro
 * l'ha finita, e quel rosso non parla del prodotto.
 *
 * PERCHÉ LA PERSONA È IL PROPRIETARIO E NON UN AMICO IN PIÙ. Aggiungere un
 * secondo membro passa dalla licenza, e il server di test ha UN posto:
 * `POST /orgs/:id/members` risponde `no_seats_left`. La riga del proprietario
 * esercita esattamente lo stesso codice — la rubrica, l'aggancio del login, il
 * profilo, i conteggi — senza inventare una licenza che in produzione non
 * esiste.
 */
hermetic(test);

/** Una faccia servita da QUESTO server: la clip mostra un avatar vero senza
 *  che il browser esca di casa. */
const AVATAR = `${E2E_BASE}/icons/icon-192.png`;

/**
 * Qualche turno ATTRIBUITO nell'archivio di prova.
 *
 * La baseline del `globalSetup` non ha nessun messaggio utente, quindi senza
 * questa semina i conteggi sarebbero zero e la clip mostrerebbe due trattini
 * invece della cosa che il task chiede di far vedere. Le righe hanno la forma
 * vera: l'autore sul PROMPT (colonna della 095) e l'usage sulla RISPOSTA appesa
 * a quel prompt — che è esattamente il verso in cui `person-stats.ts` li somma.
 */
function seminaTurni(personId: string, quanti: number): void {
  const db = join(E2E_DATA_DIR, "topics.db");
  const sk = "topic:evidenza-profili";
  let sql = "";
  for (let i = 0; i < quanti; i++) {
    const u = `ev-u${i}`, a = `ev-a${i}`;
    sql += `
      INSERT OR REPLACE INTO messages (id, session_key, role, content, timestamp, sort_order, author_person_id)
        VALUES ('${u}', '${sk}', 'user', 'domanda ${i}', '2026-08-10T09:0${i}:00.000Z', ${i * 2}, '${personId}');
      INSERT OR REPLACE INTO messages (id, session_key, role, content, timestamp, sort_order, parent_id,
                                       usage_prompt_tokens, usage_completion_tokens, cost_cents)
        VALUES ('${a}', '${sk}', 'assistant', 'risposta ${i}', '2026-08-10T09:0${i}:30.000Z', ${i * 2 + 1}, '${u}',
                12400, 830, 9);`;
  }
  execFileSync("sqlite3", [db, sql]);
}

/**
 * La cache del profilo, già fresca. È il modo giusto di tenere GitHub fuori da
 * questo test: il server legge `github_profiles` PRIMA di decidere se uscire, e
 * una riga con `fetched_at` di adesso gli dice che non serve.
 */
function seminaProfiloInCache(): void {
  const db = join(E2E_DATA_DIR, "topics.db");
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO github_profiles
       (login, name, avatar_url, html_url, bio, company, location, public_repos, followers,
        fetched_at, failed_at, status)
     VALUES ('octocat', 'Mona Octocat', '${AVATAR}', 'https://github.com/octocat',
             'CTO di Armonia. Scrive cose che non devono cadere.', 'Armonia', 'Salerno',
             31, 12, ${Date.now()}, NULL, 200);`,
  ]);
}

test.describe("Profili degli amici", () => {
  test("una persona si apre, mostra prompt e token, e prende la faccia da GitHub", async ({
    page,
    request,
    settingsPage,
  }) => {
    const me = await (await request.get(`${E2E_BASE}/api/auth/me`)).json();
    const personId = me?.person?.id as string;
    const nome = me?.person?.name as string;
    expect(personId, "l'installazione deve avere una persona (migration 084)").toBeTruthy();
    seminaTurni(personId, 7);

    seminaProfiloInCache();

    await page.goto("/");
    await settingsPage.openSettings();
    await page.locator('nav button:has-text("Profilo")').click();

    const sezione = page.getByTestId("friends-section");
    await expect(sezione).toBeVisible();

    // La riga si aggancia all'ID, non al NOME: appena il profilo GitHub arriva
    // il nome mostrato diventa quello di GitHub, e un locator per nome
    // perderebbe la riga proprio nell'istante in cui la funzione ha funzionato.
    const riga = sezione.locator("li").filter({ has: page.getByTestId(`friend-row-${personId}`) });
    expect(nome, "il proprietario ha un nome").toBeTruthy();
    await expect(riga).toBeVisible();
    // Senza login la riga non promette nessuna faccia…
    await expect(riga).toContainText("nessun profilo GitHub");
    // …ma i prompt attribuiti si contano già.
    await expect(riga).toContainText("prompt");

    // ── COMPORTAMENTO 1: la riga si apre e mostra i numeri per esteso.
    await riga.locator("button").first().click();
    await expect(riga.getByPlaceholder("login GitHub")).toBeVisible();
    await expect(riga).toContainText("Token in");
    await expect(riga).toContainText("Token out");

    // ── COMPORTAMENTO 2: si scrive il login e compare il profilo.
    await riga.getByPlaceholder("login GitHub").fill("octocat");
    await riga.getByRole("button", { name: "Salva" }).click();

    await expect(riga).toContainText("Mona Octocat");
    await expect(riga).toContainText("@octocat");
    await expect(riga).toContainText("CTO di Armonia");
    await expect(riga).toContainText("Armonia · Salerno");
    await expect(riga.locator("img")).toBeVisible();

    // ── E LA CLIP DEVE MOSTRARLO DAVVERO.
    //
    // `toBeVisible()` dice «sta nel DOM e ha un rettangolo», non «si vede sullo
    // schermo»: una riga scrollata sotto il bordo del pannello lo soddisfa in
    // pieno. Siccome questo test È l'evidenza di consegna, il video girerebbe
    // verde su un pezzo di interfaccia che nel filmato non compare — che è il
    // modo esatto in cui una prova smette di provare qualcosa.
    await expect(riga).toBeInViewport();
    await expect(riga.locator("img")).toBeInViewport();
  });
});
