/**
 * IL DOCUMENTO DELLE DESTINAZIONI DEVE DIRE LA VERITÀ SUL REPO.
 *
 * `docs/destinazioni.md` risponde a «alla approvazione dovremmo fare
 * direttamente deploy… potremmo avere locale e remoto, dev/stage/prod» con un
 * fatto invece che con un'architettura: le destinazioni sono DUE (l'app, che
 * esce da sola a ogni push su main; la landing, che si pubblica a mano) e
 * `dev`/`stage`/`prod` non esistono da nessuna parte.
 *
 * Un documento del genere è vero il giorno che si scrive e diventa una
 * fotografia di com'era il giorno dopo. Questo cancello lo tiene attaccato al
 * repo nei due versi:
 *
 *   - ciò che il documento dichiara deve ESISTERE (uno script, un workflow);
 *   - ciò che il repo HA deve essere dichiarato.
 *
 * Il secondo verso è quello che conta: aggiungere un deploy senza scriverlo è
 * esattamente il modo in cui una destinazione nuova arriva senza che nessuno
 * decida chi la sceglie e cosa vede chi approva.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const RADICE = resolve(import.meta.dir, "../..");
const DOC = readFileSync(resolve(RADICE, "docs/destinazioni.md"), "utf8");
const PKG = JSON.parse(readFileSync(resolve(RADICE, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** Gli script che PUBBLICANO qualcosa fuori da questa macchina. */
function scriptDiDeploy(): string[] {
  return Object.keys(PKG.scripts)
    .filter((k) => k.startsWith("deploy:"))
    // La prova a secco non è una destinazione: è il modo di NON pubblicare.
    .filter((k) => !k.endsWith(":dry"));
}

describe("le destinazioni dichiarate sono quelle vere", () => {
  it("ogni script di deploy del repo è nominato nel documento", () => {
    // Il verso che conta: un deploy nuovo che nessuno scrive è una
    // destinazione senza un padrone, senza un cancello e senza una schermata
    // che la dichiari a chi approva.
    const mancanti = scriptDiDeploy().filter((s) => !DOC.includes(s));
    expect(mancanti,
      `script di deploy non dichiarati in docs/destinazioni.md: ${mancanti.join(", ")}`,
    ).toEqual([]);
  });

  it("la catena automatica dell'app è nominata per intero", () => {
    // Le tre parti che portano un push su main fino all'auto-updater. Se una
    // sparisce o cambia nome, il documento sta descrivendo una catena che non
    // c'è più - ed è il caso in cui una descrizione è peggio del silenzio.
    for (const w of ["auto-bump", "tauri-release"]) {
      expect(DOC, `il documento non nomina ${w}`).toContain(w);
      const esiste = readdirSync(resolve(RADICE, ".github/workflows")).some((f) => f.startsWith(w));
      expect(esiste, `${w} è nel documento ma non fra i workflow`).toBe(true);
    }
  });

  it("gli ambienti che il documento NEGA non devono comparire nei workflow", () => {
    // La parte più fragile della decisione: «non abbiamo tre ambienti». Se
    // domani un workflow guadagna un `environment: prod`, questa riga diventa
    // rossa e il documento va riscritto PRIMA che qualcuno ci costruisca sopra
    // una UI di scelta.
    const dir = resolve(RADICE, ".github/workflows");
    const conAmbienti = readdirSync(dir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .filter((f) => /^\s*environment:/m.test(readFileSync(resolve(dir, f), "utf8")));
    expect(conAmbienti,
      `questi workflow dichiarano un environment, ma docs/destinazioni.md dice che non esistono: ${conAmbienti.join(", ")}`,
    ).toEqual([]);
  });

  it("il documento dice chi decide, non solo cosa succede", () => {
    // Una tabella di destinazioni senza la colonna «chi decide» descrive un
    // meccanismo e lascia aperta la domanda della card: chi sceglie dove va
    // una card approvata.
    expect(DOC).toContain("chi decide");
    // E dice che per l'app quel qualcuno è il gesto di pubblicazione, non un
    // automatismo senza nome.
    expect(DOC).toMatch(/Pubblica/);
  });
});
