/**
 * @covers GATE-07
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { userInfo } from "os";
import { resolve, join } from "path";
import { personalTerms as elencoTerzi, personalTermsPath } from "../../scripts/personal-terms.ts";
import { execFileSync } from "child_process";

/**
 * No tracked file carries a THIRD PARTY's personal data.
 *
 * -- WHY IT EXISTS -----------------------------------------------------------
 * `armonia/topics-app` is PUBLIC. It was published on 2026-06-02 after an audit
 * that removed `.planning/` (299 internal documents). On 2026-08-13, on the eve
 * of the first push of the 723 commits that followed, an audit found personal
 * data back in **136 tracked files and 370 lines**, nearly always as the
 * attribution of a design decision or as a fixture value in a test. Cleaning
 * those does not stop the hundred-and-thirty-seventh from coming back tomorrow,
 * and it already came back once. This is the gate.
 *
 * -- THE PREMISE THAT WAS FALSE, AND THE NEW RULE (2026-09-02) ---------------
 * Until today this gate also looked for the name of the repo's AUTHOR, and the
 * reason written here was: "the commits are signed by a deliberately ANONYMOUS
 * author (`j <j@l>`), so the name in the comments is a contradiction - an
 * anonymous signature is worth nothing if the name sits in the sources".
 *
 * That premise no longer describes this repo, and it was MEASURED on
 * 2026-09-02: over `git log -400 --format=%an` the author is the real person in
 * **310 commits out of 400**, full name and email address, and those commits
 * are on `origin/main`, i.e. already published. The signature is not anonymous:
 * it IS that identity, on every line of `git log` anyone can read.
 *
 * Hence the new rule, and why:
 *
 *   - **the repo author's name is NOT data to redact.** A gate that protects
 *     something already public protects nothing: taking it out of the comments
 *     does not take it out of the SHAs, out of GitHub, or off the contributors
 *     page. It only produces red in CI - and a red that matches no risk is the
 *     fastest way for a proactive gate to be switched off by the people who
 *     live under it.
 *   - **third-party personal data stays in:** clients, company names, people
 *     who never chose to appear here. None of that is in any commit signature,
 *     so a tracked file carrying it is a NEW exposure - the only one this gate
 *     can actually prevent.
 *
 * What the gate does NOT stop watching: the machine's home directory and user
 * name stay forbidden, and the twin `no-home-paths-tracked.test.ts` measures
 * them. A `/Users/<user>/...` path is not an identity published by a signature,
 * it is the shape of the machine somebody works on, and it still must not be
 * here.
 *
 * -- WHERE THE LIST LIVES, AND WHY NOT HERE ----------------------------------
 * In `.personal-terms`, deliberately NOT tracked: a list of what must stay
 * hidden, inside the repo it must stay hidden from, is the very leak it claims
 * to close. `scripts/personal-terms.ts` reads it - one module for all three
 * gates that need it (this one, `check-push-clean.ts`, `scrub-history.ts`):
 * three hand-rolled parsers of the same file become three gates that diverge at
 * the first syntax change, and one that diverges silently is blind.
 *
 * A direct consequence of the new rule: terms are no longer DERIVED from
 * `id -F` / `git config user.name` / `user.email`. That derivation existed to
 * search for the author without writing the name down, and the author is no
 * longer what we search for. What remains is a declared list of third parties,
 * and an empty list means "nothing to look for here", NEVER "clean".
 *
 * -- THE FOUR-CHARACTER THRESHOLD --------------------------------------------
 * A short term produces nothing but false positives: searching "j" or "io" in
 * every tracked file would make the gate useless and noisy at the same time.
 * Below four characters a term is dropped, and the test DECLARES it instead of
 * ignoring it in silence. `filtraTermini` is exported so that the twin gates
 * (`no-home-paths-tracked`, `check-security.test`) apply THE SAME rule instead
 * of a copy.
 */

const ROOT = resolve(import.meta.dir, "..", "..");

/** Solo file che un umano scrive o che un attrezzo genera come testo. */
const TESTABILE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|sql|sh|yml|yaml|toml|css|html|rs|plist|txt)$/;

/**
 * Esenzioni, ognuna con la sua ragione. Un'esenzione senza ragione scritta è
 * un buco che nessuno saprà più valutare.
 *
 * `tests/unit/no-personal-data-debito.ts` STAVA QUI e non c'è più: era
 * l'elenco dei 119 file che portavano il nome dell'AUTORE, cioè il conto
 * aperto di una pulizia che la regola del 02/09 dichiara non dovuta. Un debito
 * che non è più un debito non si tiene «per sicurezza»: si chiude, altrimenti
 * resta un'allowlist permanente che nessuno rilegge.
 */
const ESENTI = new Map<string, string>([
  [
    "tests/unit/no-personal-data-tracked.test.ts",
    "Il cancello stesso: qui si discute la FORMA di un termine (soglia, grafie, " +
      "derivazione), e discutere la regola non deve poter far scattare la regola.",
  ],
]);

/**
 * Gli account che NON sono il nome di nessuno.
 *
 * Su un runner di CI l'utente della macchina di build si chiama `runner`
 * (ubuntu-latest), e la parola compare in 74 file tracciati (ci.yml,
 * CONTRIBUTING.md, CHANGELOG.md…). Senza questo filtro il cancello gemello
 * diventerebbe rosso per come si chiama l'utente della macchina di build, non
 * per una fuga.
 *
 * Non sono esenzioni sul CONTENUTO — nessun file viene perdonato. È il
 * riconoscimento che questi nomi non appartengono a una persona, quindi non
 * c'è niente da proteggere.
 */
const ACCOUNT_OF_SERVICE = new Set([
  "runner", "ubuntu", "root", "admin", "build", "builder", "jenkins",
  "circleci", "travis", "vsts", "vagrant", "docker", "codespace", "gitpod",
  "github-actions", "actions", "nobody", "user", "test",
]);

/** Soglia, minuscolo, dedup e account di servizio: la regola in un posto solo. */
export function filtraTermini(grezzi: string[]): string[] {
  return [...new Set(grezzi.map((t) => t.trim().toLowerCase()))]
    .filter((t) => t.length >= 4 && !ACCOUNT_OF_SERVICE.has(t));
}

/**
 * I termini da cercare: SOLO i dati di terzi dichiarati in `.personal-terms`.
 *
 * Nessuna derivazione dall'identità di chi committa — vedi la regola del
 * 02/09 in testa al file: quella identità è pubblica in 310 degli ultimi 400
 * commit, e cercarla nei sorgenti non toglie niente a nessuno.
 */
export function personalTerms(): string[] {
  return filtraTermini(elencoTerzi(ROOT));
}

function tracciati(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((p) => p.length > 0 && TESTABILE.test(p) && !ESENTI.has(p));
}

/** I file tracciati che contengono almeno un termine personale. */
function colpevoli(files: string[], termini: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    let testo: string;
    try {
      testo = readFileSync(join(ROOT, f), "utf8").toLowerCase();
    } catch {
      continue; // file cancellato fra `ls-files` e la lettura, o binario travestito
    }
    if (termini.some((t) => testo.includes(t))) out.push(f);
  }
  return out;
}

describe("nessun dato personale in un file tracciato", () => {
  const termini = personalTerms();
  const files = tracciati();

  test("l'elenco dei file tracciati non è vuoto (guardia contro un verde a vuoto)", () => {
    // Se `git ls-files` fallisse o il filtro non prendesse più niente, il test
    // sotto passerebbe misurando zero file: il modo più comune in cui un
    // cancello smette di guardare senza che nessuno se ne accorga.
    expect(files.length).toBeGreaterThan(100);
  });

  test("il cancello sa ancora diventare rosso", () => {
    // QUESTA È LA GUARDIA CHE HA SOSTITUITO «i termini si derivano davvero».
    //
    // Finché i termini si derivavano dalla macchina, «almeno un termine» era la
    // prova che la derivazione funzionasse. Adesso l'elenco è un file locale e
    // non esistere è una risposta LEGITTIMA (fresh clone, CI): «zero termini»
    // non è più un guasto, quindi non può più essere l'asserzione.
    //
    // Ciò che resta da dimostrare è che il confronto morda: si dà a `colpevoli`
    // un termine inventato che sta di sicuro dentro un file tracciato noto. Se
    // un giorno il matcher smettesse di leggere i file, di abbassare a
    // minuscolo o di confrontare, questo diventerebbe rosso qui — invece di
    // stampare verde su un albero che nessuno sta più guardando.
    expect(colpevoli(["CHANGELOG.md"], ["changelog"])).toEqual(["CHANGELOG.md"]);
    expect(colpevoli(["CHANGELOG.md"], ["CHANGELOG"])).toEqual([]); // i termini arrivano già minuscoli
    expect(colpevoli(["CHANGELOG.md"], ["termine-che-non-esiste-da-nessuna-parte"])).toEqual([]);
  });

  test("l'utente di una macchina di build non è il nome di nessuno", () => {
    // Senza questo filtro `runner` sarebbe un termine personale e i 74 file
    // tracciati che contengono la parola renderebbero rosso `bun test:unit` in
    // ci.yml. Non se ne era accorto nessuno perché ci.yml non gira da settimane.
    expect(filtraTermini(["runner"])).toEqual([]);
    expect(filtraTermini(["Runner", "UBUNTU", "jenkins"])).toEqual([]);
    // E il filtro non deve mangiarsi una persona che si chiama davvero così:
    // resta una lista di account, non un elenco di parole vietate.
    expect(filtraTermini(["runnerson"])).toEqual(["runnerson"]);
  });

  test("l'identità dell'autore del repo NON è un termine da cercare", () => {
    // La regola del 02/09, scritta come test invece che come solo commento: se
    // qualcuno rimettesse la derivazione da `git config`, il nome dell'autore
    // tornerebbe fra i termini e questo diventerebbe rosso.
    //
    // Si confronta con ciò che la macchina sa dell'autore SENZA scriverlo qui:
    // il termine si legge da git al volo e non finisce mai in un file.
    const repoAuthor = (() => {
      try {
        return execFileSync("git", ["config", "user.name"], { cwd: ROOT, encoding: "utf8" }).trim().toLowerCase();
      } catch {
        return "";
      }
    })();
    if (!repoAuthor) return; // niente identità git configurata: niente da dimostrare
    expect(termini).not.toContain(repoAuthor);
    for (const word of repoAuthor.split(/\s+/)) {
      if (word.length >= 4) expect(termini).not.toContain(word);
    }
  });

  test("nessun file tracciato porta un dato personale di terzi", () => {
    // Nessun debito, nessuna allowlist: sotto la regola nuova l'elenco dei
    // colpevoli è VUOTO, e deve restare tale. I 119 file che stavano nel debito
    // ci stavano per il nome dell'autore, che non è più ciò che si cerca.
    //
    // Se questo diventa rosso, il file va corretto — non aggiunto a un elenco.
    // Un dato di terzi non ha un «debito»: o non c'è, o è una fuga.
    expect(colpevoli(files, termini)).toEqual([]);
  });

  test("un elenco vuoto è dichiarato inerte, non spacciato per verde", () => {
    // `.personal-terms` non è tracciato: su un clone fresco e in CI non esiste,
    // e lì questo cancello non misura niente. Non è un guasto — è il motivo per
    // cui in `ci.yml` gira `--only=secrets,dependencies` e questo pezzo morde
    // sulla postazione, dove il commit nasce. Ciò che NON deve succedere è che
    // il vuoto passi per una misura: qui lo si dice ad alta voce.
    if (termini.length === 0) {
      expect(personalTermsPath(ROOT)).toContain(".personal-terms");
      return;
    }
    // E dove l'elenco c'è, deve essere fatto di termini utilizzabili.
    expect(termini.every((t) => t.length >= 4)).toBe(true);
  });

  test("ogni esenzione porta scritta la sua ragione", () => {
    // Un'esenzione senza ragione è un buco che fra sei mesi nessuno sa più
    // valutare: si eredita e si allarga. La soglia è grossolana di proposito —
    // non misura la qualità della spiegazione, impedisce che non ce ne sia una.
    const mute = [...ESENTI].filter(([, ragione]) => ragione.trim().length < 40).map(([f]) => f);
    expect(mute).toEqual([]);
  });

  test("il nome utente della macchina resta vietato: lo misura il gemello", () => {
    // Il confine della regola nuova, in una riga eseguibile: qui l'identità
    // dell'autore è uscita dai termini, ma `no-home-paths-tracked.test.ts`
    // continua a vietare `/Users/<utente>/…` e l'utente stesso. Se quel file
    // sparisse — o smettesse di derivare l'utente dalla macchina — questa riga
    // direbbe che metà del cancello se n'è andata con lui.
    const twin = readFileSync(join(ROOT, "tests/unit/no-home-paths-tracked.test.ts"), "utf8");
    expect(twin).toContain("homedir()");
    // …e che l'utente lo ricavi ancora da lì, che è la metà «identità» del
    // controllo: la home dice come si chiama chi lavora, e quella resta vietata.
    expect(twin).toContain('HOME.split("/")');
  });
});
