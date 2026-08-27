/**
 * @covers GATE-06
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, copyFileSync, existsSync, rmSync } from "fs";
import { tmpdir, homedir, userInfo } from "os";
import { join, resolve } from "path";
import { filtraTermini } from "../tests/unit/no-personal-data-tracked.test";

/**
 * Il banco che falsifica `check:security`, un pezzo alla volta.
 *
 * UN CANCELLO SI CREDE SOLO SE LO SI E' VISTO ROSSO. Un controllo che non e'
 * mai fallito non e' un controllo dimostrato: e' un controllo di cui nessuno ha
 * ancora scoperto che guarda dalla parte sbagliata. Questo file introduce, uno
 * per uno, i quattro guasti che `scripts/check-security.ts` esiste per
 * fermare, e pretende di vedere esito 1 quattro volte.
 *
 * MAI SUL CHECKOUT VIVO, ed e' il motivo per cui il comando ha `--root`. Ogni
 * caso lavora su una COPIA: una copia dell'albero tracciato in una cartella
 * temporanea per i pezzi che hanno bisogno dell'albero vero (i due cancelli delegati
 * misurano piu' di 100 e piu' di 500 file tracciati, quindi un repo finto li
 * farebbe rossi per il motivo sbagliato), e un repo git minimo costruito qui
 * per il pezzo dei segreti, che invece si dimostra meglio su tre file che su
 * duemilasettecento.
 *
 * PERCHE' I SEGRETI FINTI SI COSTRUISCONO A RUNTIME. Scrivere una chiave di
 * forma completa dentro questo file la renderebbe un segreto in chiaro in un
 * file tracciato: il cancello si denuncerebbe da solo, e la via d'uscita
 * sarebbe un'esenzione che copre proprio il file dove i finti segreti vivono.
 * Concatenate a runtime, nel sorgente non esiste nessuna stringa di quella
 * forma, e l'esenzione di `scripts/check-security.test.ts` resta la deroga
 * stretta che e' scritta accanto ad essa.
 *
 * PERCHE' LA CARTELLA TEMPORANEA NON E' UN PERCORSO FISSO. Due corse in
 * parallelo su `/tmp/prova-sicurezza` si distruggono a vicenda, e il rosso che
 * ne esce non ha niente a che vedere col codice: `mkdtemp` da' a ognuna la sua.
 */

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts/check-security.ts");

/** Il comando sotto esame, puntato su una copia. Torna esito piu' referto. */
function esegui(root: string, ...args: string[]): { code: number; out: string } {
  const res = spawnSync("bun", ["run", SCRIPT, `--root=${root}`, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${res.stderr}`);
}

// ---------------------------------------------------------------------------
// Pezzo 3: segreti, su un repo minimo
// ---------------------------------------------------------------------------

/** Un repo git di tre file, con dentro cio' che il caso vuole. */
function minimumRepo(file: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "security-min-"));
  git(dir, "init", "--quiet");
  for (const [rel, contenuto] of Object.entries(file)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, contenuto);
  }
  git(dir, "add", "-A");
  return dir;
}

describe("check:security - il pezzo dei segreti", () => {
  const temporanee: string[] = [];
  afterAll(() => {
    for (const d of temporanee) rmSync(d, { recursive: true, force: true });
  });

  function conRepo(file: Record<string, string>): string {
    const d = minimumRepo(file);
    temporanee.push(d);
    return d;
  }

  test("un albero pulito esce zero", () => {
    const dir = conRepo({ "src/a.ts": 'export const saluto = "ciao";\n' });
    const { code, out } = esegui(dir, "--only=secrets");
    expect(out).toContain("nessun segreto in chiaro");
    expect(code).toBe(0);
  });

  test("una chiave Anthropic in un file tracciato fa ROSSO", () => {
    // Costruita a pezzi: nel sorgente di questo file non esiste la stringa
    // intera, quindi il cancello non ha niente da trovare qui.
    const chiave = `sk-${"ant"}-api03-${"Q7wR2xL9pKm4TvB8nZc1JdF6hY3sG5uA"}`;
    const dir = conRepo({ "src/a.ts": `const client = { apiKey: "${chiave}" };\n` });
    const { code, out } = esegui(dir, "--only=secrets");
    expect(out).toContain("chiave Anthropic");
    expect(out).toContain("src/a.ts:1");
    // Il referto finisce nei log della CI: mostra la testa, non la chiave.
    expect(out).not.toContain(chiave);
    expect(code).toBe(1);
  });

  test("una chiave privata PEM fa ROSSO", () => {
    const pem = `-----${"BEGIN"} RSA PRIVATE KEY-----`;
    const dir = conRepo({ "deploy/id_rsa.txt": `${pem}\nMIIEow...\n` });
    const { code, out } = esegui(dir, "--only=secrets");
    expect(out).toContain("chiave privata PEM");
    expect(code).toBe(1);
  });

  test("una password ad alta entropia dentro una URL fa ROSSO", () => {
    const url = `postgres://utente:${"Xk7$"}${"vQ2mNp9Lr4Ts"}@db.example.com:5432/topics`;
    const dir = conRepo({ "config/db.yml": `url: "${url}"\n` });
    const { code, out } = esegui(dir, "--only=secrets");
    expect(out).toContain("credenziale dentro una URL");
    expect(code).toBe(1);
  });

  test("un valore ad alta entropia assegnato a `secret` fa ROSSO, un segnaposto no", () => {
    const vero = `${"9fK2"}${"pQ7xL4vN"}${"8mZ3rT6yB1"}${"cW5jH0sD"}`;
    const sporco = conRepo({ "src/conf.ts": `export const secret = "${vero}";\n` });
    expect(esegui(sporco, "--only=secrets").code).toBe(1);

    // La stessa riga con un segnaposto resta verde. Senza questo il cancello
    // sarebbe rumoroso su ogni `.env.example` del mondo, e un cancello che
    // grida sempre e' un cancello che si impara a saltare.
    const pulito = conRepo({ "src/conf.ts": 'export const secret = "your-secret-goes-here";\n' });
    expect(esegui(pulito, "--only=secrets").code).toBe(0);
  });

  test("un file .env TRACCIATO fa ROSSO anche se dentro non c'e' niente", () => {
    const dir = conRepo({ ".env": "# vuoto\n", "src/a.ts": "export const x = 1;\n" });
    const { code, out } = esegui(dir, "--only=secrets");
    expect(out).toContain(".env TRACCIATO");
    expect(code).toBe(1);
    // Ma `.env.example` e' fatto apposta per essere tracciato.
    const ok = conRepo({ ".env.example": "ANTHROPIC_API_KEY=\n", "src/a.ts": "export const x = 1;\n" });
    expect(esegui(ok, "--only=secrets").code).toBe(0);
  });

  test("`allow-secret:` con una ragione spegne la riga, senza ragione no", () => {
    const chiave = `sk-${"ant"}-api03-${"Q7wR2xL9pKm4TvB8nZc1JdF6hY3sG5uA"}`;
    const withReason = conRepo({
      "docs/esempio.md": `Esempio: \`${chiave}\` allow-secret: chiave finta di documentazione\n`,
    });
    expect(esegui(withReason, "--only=secrets").code).toBe(0);

    // Una deroga senza ragione non e' una deroga: e' un interruttore.
    const muta = conRepo({ "docs/esempio.md": `Esempio: \`${chiave}\` allow-secret: x\n` });
    expect(esegui(muta, "--only=secrets").code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pezzi 1, 2 e 4: sulla copia dell'albero vero
// ---------------------------------------------------------------------------

/**
 * Una copia dell'albero TRACCIATO com'e' adesso, non com'e' l'ultimo commit.
 *
 * PERCHE' NON `git clone`. Un clone porta HEAD, e il lavoro in corso non e'
 * ancora li' dentro: il banco misurerebbe la versione precedente del cancello e
 * si direbbe verde su una modifica che non ha nemmeno guardato. E' lo stesso
 * inganno del verde su albero sporco, e in un banco di falsificazione e'
 * peggio, perche' la sua unica ragione di esistere e' dire la verita' sul rosso.
 *
 * I file arrivano da `git ls-files`, quindi la copia contiene esattamente cio'
 * che il cancello considera «tracciato»; `git add -A` alla fine le da' un
 * indice, che e' cio' che `git ls-files` legge dentro la copia.
 */
function copiaAlbero(da: string, a: string): void {
  const elenco = spawnSync("git", ["-C", da, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (elenco.status !== 0) throw new Error(`git ls-files in ${da}: ${elenco.stderr}`);
  const rel = elenco.stdout.split("\0").filter(Boolean);
  // Il banco gira anche prima di `git add`. La baseline e' parte del contratto
  // del comando, ma in quel momento puo' essere un file nuovo e quindi non
  // comparire ancora in `git ls-files`. La copiamo esplicitamente invece di
  // portare tutti gli untracked, che includerebbero materiale locale estraneo.
  const baseline = "scripts/security-baseline.json";
  if (!rel.includes(baseline)) {
    if (!existsSync(join(da, baseline))) throw new Error(`manca ${baseline}: il banco non puo' verificare le dipendenze`);
    rel.push(baseline);
  }
  if (rel.length < 500) throw new Error(`la copia sarebbe di ${rel.length} file: l'albero non e' quello che credo`);
  for (const p of rel) {
    const dest = join(a, p);
    mkdirSync(join(dest, ".."), { recursive: true });
    try {
      copyFileSync(join(da, p), dest);
    } catch {
      // tracciato ma assente dal disco: la copia lo omette come farebbe git
    }
  }
  git(a, "init", "--quiet");
  // `--force`, e non e' un dettaglio. La copia deve avere lo STESSO insieme
  // tracciato del sorgente, ma `git add -A` riapplica `.gitignore` da zero: gli
  // 11 file che il repo traccia PUR combaciando con una regola (i `docs/*`
  // entrati prima dell'allowlist) sparirebbero dall'indice della copia. Il
  // banco poi misura un albero piu' piccolo di quello vero e accusa il
  // cancello sbagliato: il 18/08 `no-personal-data-tracked` dichiarava stantia
  // `docs/archive/PORTING-PLAN.md` — un file che nella copia non esisteva.
  git(a, "add", "-A", "--force");
}

describe("check:security - i pezzi che vogliono l'albero vero", () => {
  let copia = "";
  let temporanea = "";

  beforeAll(() => {
    temporanea = mkdtempSync(join(tmpdir(), "security-copy-"));
    copia = join(temporanea, "copia");
    copiaAlbero(ROOT, copia);
  });

  afterAll(() => {
    if (temporanea) rmSync(temporanea, { recursive: true, force: true });
  });

  /** Rimette la copia com'era, cosi' un caso non eredita il guasto del precedente. */
  function ripristina(): void {
    git(copia, "checkout", "--", ".");
    git(copia, "clean", "-fdq");
  }

  test("la copia parte verde su tutti e quattro i pezzi", () => {
    const { code, out } = esegui(copia);
    expect(out).toContain("pubblicabile");
    expect(code).toBe(0);
  }, 120_000);

  test("PEZZO data: un nome personale in un file tracciato fa ROSSO", () => {
    // Il termine si DERIVA come fa il cancello, mai scritto: scriverlo qui
    // sarebbe esattamente la fuga che il cancello impedisce. Le fonti sono le
    // sue, nello stesso ordine, e la prima che da' un termine di almeno quattro
    // caratteri vince. `git config user.name` da solo non basta: in questo repo
    // l'autore e' anonimo di proposito (una lettera), ed e' sotto la soglia.
    const fonti = [
      () => spawnSync("id", ["-F"], { encoding: "utf8" }).stdout ?? "",
      () => spawnSync("git", ["config", "user.name"], { encoding: "utf8" }).stdout ?? "",
      () => userInfo().username,
    ];
    let termine = "";
    for (const f of fonti) {
      termine = (f() ?? "").trim().split(/\s+/).find((t) => t.length >= 4) ?? "";
      if (termine) break;
    }
    if (termine.length < 4) {
      // Su una macchina senza identita' il caso non e' costruibile: lo dice
      // invece di passare in silenzio, che sarebbe un verde non guadagnato.
      throw new Error("nessuna fonte da' un termine personale di almeno 4 caratteri: il caso non e' costruibile");
    }
    // Il termine c'e', ma il cancello lo IGNORA: e' un account di servizio.
    //
    // Le tre fonti qui sopra sono quelle del cancello, ma non passavano dal suo
    // filtro, e su un runner GitHub le due cose divergono: `userInfo().username`
    // da' «runner», che ha sei caratteri e supera la soglia, mentre
    // `filtraTermini` lo toglie perche' non e' il nome di nessuno. Il test
    // piantava quindi nel README un termine che il cancello ha l'ordine di non
    // cercare, e pretendeva che diventasse rosso: rosso in CI, per costruzione.
    //
    // Qui non si esce in silenzio e non si throwa: si distinguono i due casi.
    // Nessun termine affatto = la derivazione e' rotta, ed e' un guasto (sopra).
    // Termine presente ma di servizio = su questa macchina non c'e' nessuna
    // identita' da proteggere, quindi il caso da falsificare non ESISTE. Il
    // pezzo `data` e' locale per natura — in ci.yml gira `--only=secrets,
    // dependencies` per questa identica ragione — e la sua falsificazione vive
    // dove vive lui.
    if (filtraTermini([termine]).length === 0) {
      console.log(`[check-security.test] PEZZO data: saltato, «${termine}» e' un account di servizio e il cancello lo ignora per progetto.`);
      return;
    }
    appendFileSync(join(copia, "README.md"), `\n<!-- deciso da ${termine} -->\n`);
    const { code, out } = esegui(copia, "--only=data");
    expect(out).toContain("ROSSO");
    expect(code).toBe(1);
    ripristina();
  }, 120_000);

  test("PEZZO home: il percorso della home in un file tracciato fa ROSSO", () => {
    appendFileSync(join(copia, "README.md"), `\nlog in ${homedir()}/prova.log\n`);
    const { code, out } = esegui(copia, "--only=home");
    expect(out).toContain("ROSSO");
    expect(code).toBe(1);
    ripristina();
  }, 120_000);

  test("PEZZO secrets: una chiave nell'albero vero fa ROSSO", () => {
    const chiave = `${"AKIA"}${"Q7WR2XL9PKM4TVB8"}`;
    appendFileSync(join(copia, "README.md"), `\nAWS: ${chiave}\n`);
    const { code, out } = esegui(copia, "--only=secrets");
    expect(out).toContain("chiave AWS");
    expect(out).toContain("README.md");
    expect(code).toBe(1);
    ripristina();
  }, 120_000);

  test("PEZZO dependencies: un avviso NON dichiarato nella baseline fa ROSSO", () => {
    // La leva onesta. Il cancello osserva UNA cosa: c'e' un avviso che la
    // baseline non elenca? Togliere una voce dalla baseline e installare un
    // pacchetto vulnerabile producono per lui lo stesso stato, e il primo non
    // ha bisogno della rete per scaricare mezzo registro.
    const path = join(copia, "scripts/security-baseline.json");
    const base = JSON.parse(readFileSync(path, "utf8")) as { advisories: Record<string, unknown[]> };
    const withAdvisories = Object.keys(base.advisories).filter((d) => (base.advisories[d] ?? []).length > 0);
    expect(withAdvisories.length).toBeGreaterThan(0);
    base.advisories[withAdvisories[0]!] = [];
    writeFileSync(path, `${JSON.stringify(base, null, 2)}\n`);

    const { code, out } = esegui(copia, "--only=dependencies");
    if (out.includes("bun audit non ha risposto")) {
      throw new Error("questo caso interroga il registro degli avvisi: senza rete non si puo' dimostrare, e non si finge");
    }
    expect(out).toContain("NUOVO");
    expect(code).toBe(1);
    ripristina();
  }, 120_000);

  test("un pezzo che non sa misurare NON stampa verde: esce 2", () => {
    // Il guasto che uccide i cancelli in silenzio e' il verde a vuoto. Qui il
    // test delegato sparisce dalla copia: l'esito giusto non e' 0 e non e' 1.
    rmSync(join(copia, "tests/unit/no-home-paths-tracked.test.ts"));
    const { code, out } = esegui(copia, "--only=home");
    expect(out).toContain("MUTO");
    expect(code).toBe(2);
    ripristina();
  }, 120_000);
});
