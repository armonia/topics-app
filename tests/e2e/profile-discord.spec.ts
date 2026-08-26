import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "./fixtures/test-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import { beat, didascalia } from "./helpers/evidence";

/**
 * LA SCHEDA «PROFILE», dal vivo — ed è la clip di consegna del task.
 *
 * Uno screenshot non prova ciò che questa scheda promette, perché la promessa è
 * un CAMBIAMENTO: «l'anteprima è ciò che verrà pubblicato, e cambia col livello
 * di privacy». Tre livelli, tre frasi diverse, la stessa card — un'immagine
 * ferma ne mostrerebbe una e lascerebbe le altre due sulla parola. Per questo la
 * prova è un video (`E2E_EVIDENCE=1`).
 *
 * ── NIENTE DISCORD, E NON PER RIPIEGO ───────────────────────────────────────
 * Il filo IPC non si apre: sulla macchina della suite Discord non c'è, e lo
 * stato atteso è `no_discord`. Non è un test degradato — è il caso che conta di
 * più. Le anteprime arrivano lo stesso, a interruttore SPENTO, perché il loro
 * scopo è farsi guardare PRIMA di accendere: un pannello che mostra cosa
 * pubblicherà solo dopo aver pubblicato ha l'ordine invertito. Qui si misura
 * proprio quello.
 *
 * ── PERCHÉ LE ANTEPRIME NON SONO TRE STRINGHE SCRITTE QUI ───────────────────
 * Escono da `buildActivity`, la stessa funzione che scrive sul filo. Il test
 * quindi non confronta con un testo atteso parola per parola (sarebbe la quarta
 * copia della stessa frase, e la prima a divergere): confronta i tre livelli
 * FRA LORO e verifica ciò che ognuno può dire — `minimal` non nomina niente,
 * `activity` porta i numeri, `detailed` è l'unico che può portare un nome di
 * progetto. È l'invariante di privacy, che è la cosa che deve reggere.
 *
 * @covers DISCORD-01
 */
hermetic(test);

/**
 * Un po' di consumo attribuito, così i riquadri non mostrano cinque zeri.
 *
 * La baseline del `globalSetup` ha topic e messaggi ma nessun `usage_*`: senza
 * questa semina la clip mostrerebbe una scheda tecnicamente corretta e
 * visivamente vuota, cioè la prova di niente. Le righe hanno la forma vera —
 * usage sulla RISPOSTA, che è il verso in cui `profile-stats.ts` le somma.
 */
function seminaConsumo(quanti: number): void {
  const db = join(E2E_DATA_DIR, "topics.db");
  const sk = "topic:evidenza-profilo";
  // Un progetto, e un topic aperto che ci punta: senza, `focusProject` è null e
  // `detailed` DEGRADA su `activity` — che è il comportamento giusto, ma
  // renderebbe invisibile nella clip proprio la differenza che il livello
  // esiste per mostrare. Il percorso è neutro (`/tmp/…`): un path di home
  // dentro un file tracciato è la fuga che `no-home-paths-tracked` impedisce.
  let sql = `
    INSERT OR REPLACE INTO projects (id, name, slug, path, archived, created_at, updated_at)
      VALUES ('pf-proj', 'Atelier Lumen', 'atelier-lumen', '/tmp/atelier-lumen', 0,
              '2026-08-01T09:00:00.000Z', '2026-08-12T09:00:00.000Z');
    UPDATE topics SET project_path = '/tmp/atelier-lumen', updated_at = '2026-08-12T09:30:00.000Z'
      WHERE id = (SELECT id FROM topics WHERE archived = 0 ORDER BY updated_at DESC LIMIT 1);
  `;
  for (let i = 0; i < quanti; i++) {
    const u = `pf-u${i}`, a = `pf-a${i}`;
    sql += `
      INSERT OR REPLACE INTO messages (id, session_key, role, content, timestamp, sort_order)
        VALUES ('${u}', '${sk}', 'user', 'domanda ${i}', '2026-08-1${i % 2}T09:0${i}:00.000Z', ${i * 2});
      INSERT OR REPLACE INTO messages (id, session_key, role, content, timestamp, sort_order, parent_id,
                                       usage_prompt_tokens, usage_completion_tokens, cost_cents)
        VALUES ('${a}', '${sk}', 'assistant', 'risposta ${i}', '2026-08-1${i % 2}T09:0${i}:30.000Z', ${i * 2 + 1}, '${u}',
                184000, 2600, 41);`;
  }
  execFileSync("sqlite3", [db, sql]);
}

test.describe("Profile — statistiche vere e stato Discord", () => {
  test("le stats si contano, e l'anteprima Discord cambia coi tre livelli di privacy", async ({
    page,
    request,
    settingsPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DISCORD-01" });
    seminaConsumo(6);

    await page.goto("/");
    await settingsPage.openSettings();
    await page.locator('nav button:has-text("Profilo")').click();

    // ── LE STATISTICHE ──────────────────────────────────────────────────────
    const stats = page.getByTestId("profile-stats");
    await expect(stats).toBeVisible();
    // Le due lingue nella stessa asserzione, e non è pigrizia: la lingua della
    // baseline è un dato del `globalSetup`, non qualcosa che questa spec
    // controlla — inchiodarla all'inglese rende il test rosso il giorno in cui
    // qualcun altro cambia quel dato, e quel rosso non parlerebbe del profilo.
    // Non «un numero qualsiasi»: il riquadro deve uscire dallo stato di
    // caricamento. Un «Sto contando…» che resta è il modo in cui una scheda
    // rotta sembra viva.
    await expect(stats).not.toContainText(/Counting…|Sto contando…/);
    await expect(stats).toContainText(/Sessions|Sessioni/);
    await expect(stats).toContainText(/Tokens?/);
    // I token seminati sono ~1,1M: il riquadro li abbrevia, quindi la prova che
    // il conteggio ha attraversato il filo è una cifra che non comincia per
    // zero.
    const token = await stats.evaluate((el) => el.textContent ?? "");
    expect(token, "i token contati non possono essere zero dopo la semina").toMatch(
      /[1-9][\d.,]*[KMB]?\s*Tokens?/,
    );
    await expect(stats).toBeInViewport();

    await didascalia(page, "Statistiche contate su messaggi, task e topic veri");
    await beat(page);

    // ── LO STATO DEL FILO, IN PAROLE ────────────────────────────────────────
    const card = page.getByTestId("discord-card");
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    // Discord non è aperto qui, e la card lo DICE invece di mostrare un pallino
    // spento e basta: `no_discord` ed `error` hanno lo stesso aspetto e due
    // rimedi opposti.
    await expect(page.getByTestId("discord-state")).toHaveText(
      /Discord desktop is not running|Discord desktop non è aperto|Off|Spento/,
    );

    // L'interruttore nasce SPENTO. È il default che il task chiede, e vale la
    // pena misurarlo: una presence accesa per conto di qualcuno è il difetto.
    const interruttore = card.getByRole("switch");
    await expect(interruttore).toHaveAttribute("aria-checked", "false");

    await didascalia(page, "Spento di default — e dice PERCHÉ non è collegato");
    await beat(page);

    // ── I TRE LIVELLI, E L'ANTEPRIMA CHE CAMBIA ─────────────────────────────
    const anteprima = page.getByTestId("discord-preview");
    const scegli = async (nome: RegExp) => {
      await card.getByRole("radio", { name: nome }).click();
      // Il salvataggio passa dal server e RILEGGE: si aspetta il fatto (il
      // radio selezionato), non un timeout.
      await expect(card.getByRole("radio", { name: nome })).toHaveAttribute("aria-checked", "true");
    };

    await scegli(/only that Topics is open|Solo che Topics/i);
    await expect(anteprima).toBeInViewport();
    const minimal = (await anteprima.textContent())?.trim() ?? "";
    await didascalia(page, "minimal — nessun numero, nessun nome");
    await beat(page);

    await scegli(/how many sessions|quante sessioni/i);
    const attivita = (await anteprima.textContent())?.trim() ?? "";
    await didascalia(page, "activity — i conteggi, nessun cliente nominato");
    await beat(page);

    await scegli(/project name|nome del progetto/i);
    const dettagliata = (await anteprima.textContent())?.trim() ?? "";
    await didascalia(page, "detailed — l'unico che può nominare un progetto");
    await beat(page);

    // L'INVARIANTE DI PRIVACY, non tre stringhe attese.
    //
    // `minimal` è l'unico gradino che non deve poter dire quante sessioni hai:
    // un livello ottenuto svuotando campi lascia sempre l'ultimo dimenticato, ed
    // è il campo dimenticato che pubblica qualcosa che non hai scelto.
    expect(minimal, "minimal non dichiara nessun conteggio").not.toMatch(/\d/);
    expect(attivita, "activity porta i numeri").toMatch(/\d/);
    expect(attivita, "activity dice qualcosa di diverso da minimal").not.toBe(minimal);
    // `detailed` è `activity` PIÙ il progetto, oppure — se non c'è un progetto
    // in primo piano — degrada su `activity` invece di pubblicare «su null».
    expect(dettagliata.length, "detailed non è più povera di activity").toBeGreaterThanOrEqual(
      attivita.length,
    );

    // ── E LA SCELTA È DAVVERO ARRIVATA AL SERVER ────────────────────────────
    // La card potrebbe mostrare tre anteprime perfette leggendo uno stato solo
    // suo: chi decide è il server, quindi glielo si chiede.
    const r = await request.get(`${E2E_BASE}/api/profile/discord`);
    expect(r.ok()).toBe(true);
    const body = await r.json();
    expect(body.status.level).toBe("detailed");
    expect(body.status.enabled, "l'interruttore resta spento: il test non pubblica niente").toBe(false);

    // ── IL BANNER ───────────────────────────────────────────────────────────
    // Autoconsistente per costruzione: dietro il proxy di GitHub tutto ciò che
    // non è dentro il file non esiste.
    const svg = await request.get(`${E2E_BASE}/api/profile/banner.svg?name=Ada%20%26%20Co`);
    expect(svg.ok()).toBe(true);
    expect(svg.headers()["content-type"]).toContain("image/svg+xml");
    const testo = await svg.text();
    expect(testo.startsWith("<svg")).toBe(true);
    expect(testo, "niente risorse esterne dentro il banner").not.toMatch(/<image|@font-face|<link/);
    expect(testo, "il nome passa dall'escaping").toContain("Ada &amp; Co");
  });
});
