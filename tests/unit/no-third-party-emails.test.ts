/**
 * NESSUN INDIRIZZO EMAIL DI UNA PERSONA IN UN FILE TRACCIATO.
 *
 * ── Il guasto che lo fa nascere ─────────────────────────────────────────────
 * `server/db/migrations/20260818152057-armonia-bootstrap.sql` conteneva
 * `UPDATE people SET email = '<indirizzo gmail di una persona reale>' WHERE
 * email IS NULL`. Il repo e' PUBBLICO, quindi quell'indirizzo era leggibile da
 * chiunque; e su ogni installazione NUOVA — dove il proprietario nasce senza
 * email — veniva stampato addosso a un utente che non c'entra niente.
 *
 * Su questa macchina non e' successo, per caso: l'email c'era gia' e il `WHERE`
 * ha protetto la riga. L'ha scoperto la suite E2E il 19/08/2026, dove il
 * database nasce vuoto: `friend-profiles.spec.ts` si aspettava «nessun profilo
 * GitHub» e leggeva l'indirizzo di un estraneo.
 *
 * ── Perche' `no-personal-data-tracked` non poteva vederlo ───────────────────
 * Quel cancello protegge l'identita' di CHI COMMITTA, e i termini li DERIVA a
 * runtime (`id -F`, `git config user.name`, `.personal-terms`) proprio per non
 * doverli scrivere in un repo pubblico. Un TERZO non e' derivabile da nessuna
 * di quelle fonti: nessuna quantita' di cura su quel cancello lo avrebbe preso.
 * Serve una domanda diversa — non «e' il tuo nome?» ma «e' l'indirizzo di
 * qualcuno?» — ed e' questo file.
 *
 * ── La forma della regola ───────────────────────────────────────────────────
 * Vietare ogni `@` sarebbe rumore: un repo ha bisogno di indirizzi di RUOLO
 * (`security@`, `hi@`) e di SEGNAPOSTO (`example.com`). Quelli sono ammessi per
 * FORMA, non per elenco di file: un'esenzione per file invecchia e nessuno la
 * rilegge, mentre un dominio segnaposto resta segnaposto per sempre.
 *
 * Cio' che resta vietato e' l'indirizzo personale su un dominio di posta
 * pubblico — gmail, outlook, icloud e compagnia — che e' esattamente la forma
 * dell'unico che era passato.
  * @covers GATE-07
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const RADICE = resolve(import.meta.dir, "..", "..");

/** Solo cio' che un umano scrive o che un attrezzo genera come TESTO. */
const TESTABILE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|sql|sh|yml|yaml|toml|css|html|rs|plist|txt|astro)$/;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * I domini di posta PUBBLICA: un indirizzo qui sopra e' di una persona, non di
 * un ruolo. E' la lista corta apposta — allungarla richiede un caso vero.
 */
const POSTA_PERSONALE = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "icloud.com", "me.com", "yahoo.com", "yahoo.it", "libero.it", "tiscali.it",
  "virgilio.it", "alice.it", "protonmail.com", "proton.me", "pec.it",
];

function fileTracciati(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: RADICE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter((p) => p && TESTABILE.test(p));
}

function indirizziPersonali(rel: string): string[] {
  const abs = join(RADICE, rel);
  try {
    // I file enormi (fixture, bundle) non si leggono: un indirizzo di persona
    // non ci finisce a mano, e leggerli tutti costerebbe la passata.
    if (statSync(abs).size > 2 * 1024 * 1024) return [];
    const testo = readFileSync(abs, "utf8");
    const trovati = testo.match(EMAIL) ?? [];
    return [...new Set(trovati.filter((a) => POSTA_PERSONALE.some((d) => a.toLowerCase().endsWith("@" + d))))];
  } catch {
    return []; // binario o illeggibile: non e' un file che scrive un umano
  }
}

describe("nessun indirizzo personale nei file tracciati", () => {
  const tracciati = fileTracciati();

  test("l'elenco dei file tracciati non e' vuoto (guardia contro un verde a vuoto)", () => {
    // Senza, un `git ls-files` che fallisce renderebbe verde il caso sotto
    // misurando zero file: il modo piu' comune in cui un cancello smette di
    // guardare.
    expect(tracciati.length).toBeGreaterThan(500);
  });

  test("nessun file tracciato contiene un indirizzo su un dominio di posta personale", () => {
    const colpevoli: string[] = [];
    for (const f of tracciati) {
      const trovati = indirizziPersonali(f);
      // L'indirizzo NON si stampa per intero: dirlo qui sarebbe la fuga che
      // questo test impedisce, in un messaggio d'errore. Basta il dominio e il
      // file per andarlo a togliere.
      if (trovati.length) colpevoli.push(`${f} (${trovati.map((a) => "…@" + a.split("@")[1]).join(", ")})`);
    }
    expect(
      colpevoli,
      "un indirizzo personale in un repo pubblico e' leggibile da chiunque, e se finisce in una " +
        "migration viene anche scritto nel database di ogni installazione nuova",
    ).toEqual([]);
  });

  test("IL PREDICATO MORDE: un indirizzo gmail verrebbe preso, uno di ruolo no", () => {
    // Senza questo caso il precedente resterebbe verde anche se la regex si
    // rompesse, e nessuno lo saprebbe finche' non ricapita.
    // L'indirizzo di prova si COMPONE, non si scrive: scritto per intero
    // sarebbe un indirizzo su dominio personale dentro un file tracciato, cioe'
    // esattamente cio' che il caso qui sopra vieta — e il cancello prendeva se
    // stesso. La chiocciola la mette il join, quindi nel sorgente non c'e'
    // nessun indirizzo da prendere.
    const personale = ["mario.rossi", "gmail.com"].join("@");
    const prova = `scrivi a ${personale} oppure a security@armonia.io o admin@example.com`;
    const trovati = (prova.match(EMAIL) ?? []).filter((a) =>
      POSTA_PERSONALE.some((d) => a.toLowerCase().endsWith("@" + d)),
    );
    expect(trovati.length, "il dominio personale deve essere l'unico preso").toBe(1);
    expect(trovati[0]!.endsWith("@gmail.com")).toBe(true);
  });
});
