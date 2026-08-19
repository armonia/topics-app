import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { userInfo } from "os";
import { resolve, join } from "path";
import { DEBITO_NOME_PROPRIETARIO } from "./no-personal-data-debito";

/**
 * Nessun file tracciato porta il nome di chi lavora al repo.
 *
 * ── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * `armonia/topics-app` è PUBBLICO. Il 2026-06-02 è stato pubblicato dopo un
 * audit che ha tolto `.planning/` (299 documenti interni). Il 2026-08-13, alla
 * vigilia del primo push dei 723 commit successivi, un audit ha trovato che il
 * nome proprio del proprietario era rientrato in **136 file tracciati e 370
 * righe**, quasi sempre come attribuzione di una decisione di design («(Nome,
 * 09/08)») o come valore di prova nei test (`by: "nome"`).
 *
 * Non è una credenziale. È un dato personale che finisce indicizzato, e in un
 * repo dove i commit sono firmati da un autore ANONIMO di proposito (`j <j@l>`)
 * è anche una contraddizione: l'anonimato della firma non serve a niente se il
 * nome sta nei commenti.
 *
 * Ripulire i 136 file non impedisce al centotrentasettesimo di rientrare
 * domani, ed è rientrato già una volta. Questo è il cancello.
 *
 * ── PERCHÉ IL NOME NON È SCRITTO QUI ────────────────────────────────────────
 * Stessa ragione di `no-home-paths-tracked.test.ts`, ed è la parte che rende
 * il cancello onesto: scrivere il nome dentro un test del repo pubblico sarebbe
 * la fuga che il test vuole impedire, in un file in più. I termini si
 * DERIVANO a runtime da chi esegue:
 *   • `id -F` — il nome completo dell'account macOS;
 *   • `userInfo().username` — il nome utente;
 *   • `git config user.name` / `user.email`;
 *   • `.personal-terms` — file NON tracciato, una riga per termine, per ciò che
 *     il sistema non sa dedurre (ragione sociale, nomi di clienti).
 * Come effetto secondario il cancello vale per CHIUNQUE committi: protegge il
 * nome di chi ci lavora, quale che sia.
 *
 * ── LA SOGLIA DI QUATTRO CARATTERI ──────────────────────────────────────────
 * Un termine corto produce solo falsi positivi: l'autore git di questo repo è
 * `j <j@l>`, e cercare «j» in ogni file tracciato renderebbe il cancello
 * inutile e rumoroso allo stesso tempo. Sotto i quattro caratteri il termine si
 * scarta, e il test lo DICHIARA invece di ignorarlo in silenzio.
 */

const ROOT = resolve(import.meta.dir, "..", "..");

/** Solo file che un umano scrive o che un attrezzo genera come testo. */
const TESTABILE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|sql|sh|yml|yaml|toml|css|html|rs|plist|txt)$/;

/**
 * Esenzioni, ognuna con la sua ragione. Un'esenzione senza ragione scritta è
 * un buco che nessuno saprà più valutare.
 */
const ESENTI = new Map<string, string>([
  // `desktop-tauri/SIGNING.md` e `scripts/apple-signing-setup.sh` STAVANO QUI,
  // e non ci sono piu'. L'esenzione diceva: «l'identità legale serve alla FIRMA
  // del binario, e chi ricostruisce l'app deve sapere chi è — decisa dal
  // proprietario il 2026-08-13, esplicitamente e solo per questo».
  //
  // Poi quei due file sono stati REDATTI: la ragione sociale è diventata «the
  // company», il D-U-N-S è sparito. L'esenzione è sopravvissuta alla ragione che
  // la reggeva, e da quel momento era un BUCO — non copriva più un fatto voluto,
  // copriva soltanto quei due percorsi, qualunque cosa ci finisse dentro.
  //
  // Il 18/08 un agente della board ci ha rimesso la ragione sociale per esteso,
  // il codice D-U-N-S e il nome del proprietario, in un repo PUBBLICO, e questo
  // cancello non avrebbe detto niente: l'ho visto rivedendo il diff a mano.
  // Adesso lo direbbe. (E il dato NON si cita qui: un cancello che nomina cio'
  // che vieta e' la fuga che stava impedendo.)
  //
  // Se un giorno l'identità legale dovrà tornare in quei file, l'esenzione si
  // riscrive — con la data e la ragione nuove. Un'esenzione che sopravvive al
  // suo motivo non protegge: nasconde.
  [
    "tests/unit/no-personal-data-tracked.test.ts",
    "Questo file: nomina i termini come CODICE che li deriva, mai come dato.",
  ],
  [
    "tests/unit/no-personal-data-debito.ts",
    "L'elenco del debito: contiene percorsi, non nomi.",
  ],
]);

/** Un comando che può non esserci: il cancello non deve morire per questo. */
function prova(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Gli account che NON sono il nome di nessuno.
 *
 * Su un runner di CI l'utente della macchina di build si chiama `runner`
 * (ubuntu-latest), e nessuna delle altre fonti risponde: `id -F` è un'opzione
 * BSD e su Linux fallisce, e `git config user.name` non lo imposta
 * `actions/checkout`. Resta quindi «runner» come unico termine — sei caratteri,
 * sopra la soglia — e la parola compare in 74 file tracciati (ci.yml,
 * CONTRIBUTING.md, CHANGELOG.md…). Il cancello sarebbe diventato rosso per come
 * si chiama l'utente della macchina di build, non per una fuga: il modo più
 * rapido in cui un cancello proattivo viene disattivato da chi lo subisce.
 *
 * Non sono esenzioni sul CONTENUTO — nessun file viene perdonato. È il
 * riconoscimento che questi nomi non appartengono a una persona, quindi non
 * c'è niente da proteggere.
 */
const ACCOUNT_DI_SERVIZIO = new Set([
  "runner", "ubuntu", "root", "admin", "build", "builder", "jenkins",
  "circleci", "travis", "vsts", "vagrant", "docker", "codespace", "gitpod",
  "github-actions", "actions", "nobody", "user", "test",
]);

/** Soglia, minuscolo, dedup e account di servizio: la regola in un posto solo. */
export function filtraTermini(grezzi: string[]): string[] {
  return [...new Set(grezzi.map((t) => t.trim().toLowerCase()))]
    .filter((t) => t.length >= 4 && !ACCOUNT_DI_SERVIZIO.has(t));
}

/**
 * I termini da cercare, derivati a runtime. Mai scritti nel repo.
 *
 * Il nome completo si spezza anche nelle sue parti: «Nome Cognome» compare
 * quasi sempre come solo nome, ed è quella la forma che rientra.
 */
export function terminiPersonali(): string[] {
  const grezzi: string[] = [];

  const nomeCompleto = prova("id", ["-F"]);
  if (nomeCompleto) {
    grezzi.push(nomeCompleto, ...nomeCompleto.split(/\s+/));
  }
  grezzi.push(userInfo().username);
  grezzi.push(prova("git", ["config", "user.name"]));
  const email = prova("git", ["config", "user.email"]);
  if (email) {
    grezzi.push(email);
    // Anche la parte locale: `nome@dominio` rientra spesso come solo `nome`.
    const locale = email.split("@")[0];
    if (locale) grezzi.push(locale);
  }

  // Ciò che la macchina non sa dedurre: ragione sociale, clienti, alias. Il
  // file NON è tracciato di proposito (è in `.gitignore`), così l'elenco dei
  // termini vietati non diventa esso stesso la fuga.
  const extra = join(ROOT, ".personal-terms");
  if (existsSync(extra)) {
    for (const riga of readFileSync(extra, "utf8").split("\n")) {
      const t = riga.split("#")[0].trim();
      if (t) grezzi.push(t);
    }
  }

  // Dedup, soglia, minuscolo: il confronto è insensibile alle maiuscole perché
  // il nome rientra tanto in prosa («Nome ha chiesto») quanto come valore di
  // test (`by: "nome"`).
  return filtraTermini(grezzi);
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
  const termini = terminiPersonali();
  const files = tracciati();

  test("i termini si derivano davvero: almeno uno, e nessuno è scritto nel repo", () => {
    // Un cancello che non sa cosa cercare passa sempre. Questa è la guardia che
    // lo impedisce: su una macchina senza `id -F` e senza `.personal-terms` il
    // test diventa rosso qui, non verde a vuoto altrove.
    //
    // L'ECCEZIONE è una macchina di build, e non è un'attenuante: su un runner
    // non c'è NESSUNA persona la cui identità vada protetta, quindi «zero
    // termini» è la risposta giusta e non un guasto della derivazione. Il
    // cancello sull'identità è locale per natura — vive dove il commit nasce —
    // e lì la guardia resta durissima.
    if (process.env.CI && termini.length === 0) {
      expect(ACCOUNT_DI_SERVIZIO.has(userInfo().username.toLowerCase())).toBe(true);
      return;
    }
    expect(termini.length).toBeGreaterThan(0);
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

  test("l'elenco dei file tracciati non è vuoto (guardia contro un verde a vuoto)", () => {
    // Se `git ls-files` fallisse o il filtro non prendesse più niente, il test
    // sotto passerebbe misurando zero file: il modo più comune in cui un
    // cancello smette di guardare senza che nessuno se ne accorga.
    expect(files.length).toBeGreaterThan(100);
  });

  test("nessun file NUOVO porta un termine personale", () => {
    // Il debito esistente è dichiarato in `no-personal-data-debito.ts` e si
    // chiude con la riscrittura della storia (filter-repo), non a mano: quei
    // file sono anche negli SHA dei 723 commit, quindi ripulirli qui non li
    // toglierebbe dal pubblico. Ciò che questo test impedisce è che l'elenco
    // CRESCA.
    const nuovi = colpevoli(files, termini).filter((f) => !DEBITO_NOME_PROPRIETARIO.includes(f));
    expect(nuovi).toEqual([]);
  });

  test("il debito si può solo RIDURRE: nessuna voce stantia", () => {
    // Un elenco di debito che tiene dentro file già puliti smette di misurare
    // il debito e diventa un'allowlist permanente. Ogni voce deve essere ancora
    // colpevole; quando smette di esserlo, si toglie da lì.
    //
    // SENZA TERMINI non si misura niente, e «niente» qui vorrebbe dire «tutte
    // le voci sono stantie»: su un runner, dove `filtraTermini` giustamente
    // svuota la lista perché nessuna identità va protetta, questo test dichiarava
    // stantie tutte e 127. È lo stesso motivo della guardia più su, applicato
    // all'altro verso: senza un termine da cercare, «ancora colpevole» non è una
    // domanda a cui si possa rispondere.
    if (termini.length === 0) return;
    const ancoraColpevoli = new Set(colpevoli(files, termini));
    const stantie = DEBITO_NOME_PROPRIETARIO.filter((f) => !ancoraColpevoli.has(f));
    expect(stantie).toEqual([]);
  });

  test("ogni esenzione porta scritta la sua ragione", () => {
    // Un'esenzione senza ragione è un buco che fra sei mesi nessuno sa più
    // valutare: si eredita e si allarga. La soglia è grossolana di proposito —
    // non misura la qualità della spiegazione, impedisce che non ce ne sia una.
    const mute = [...ESENTI].filter(([, ragione]) => ragione.trim().length < 40).map(([f]) => f);
    expect(mute).toEqual([]);
  });
});
