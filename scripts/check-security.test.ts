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

/**
 * Every case below runs the WHOLE checker on a copy of the tree, and the
 * checker is not fast: 60-100 s on a quiet machine, 350 s on 2026-09-04 with
 * four board agents and their pre-review checks sharing the cores. The old
 * 120 s cap turned a correct verdict into a red `test:unit` for every card of
 * that night, and a gate that goes red with the load is a clock, not a check.
 * The number below is a backstop against a hang, not a performance bar: time
 * is measured by the scripts in `qa-gate.sh`'s excluded list, never here.
 */
const SECURITY_RUN_TIMEOUT_MS = 15 * 60_000;

/**
 * The two cases that need the npm registry run only on request:
 * `TOPICS_NETWORK_TESTS=1 bun test scripts/check-security.test.ts`.
 *
 * `test:unit` is the pre-review check of every board card, and a unit suite
 * that needs a remote service is not a unit suite: on 2026-09-04 the
 * registry's advisory endpoint stopped answering (`bun audit` gave up after
 * 3:30 per directory while `/-/ping` answered in 0.36 s) and every card of
 * the night went red on THIS file, for hours, for nothing they had written.
 * The measure itself is not lost: `bun run check:security` (qa-gate, CI)
 * still runs all four pieces and still refuses to print green when the
 * registry is mute. Here, offline, the three pieces that need no network are
 * asserted for real; the fourth is asserted when the network is asked for.
 */
const REGISTRY_TESTS = process.env.TOPICS_NETWORK_TESTS === "1";
const OFFLINE_PIECES = "--only=data,home,secrets";

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

  test(REGISTRY_TESTS
    ? "la copia parte verde su tutti e quattro i pezzi"
    : "la copia parte verde sui tre pezzi che non chiedono la rete", () => {
    const { code, out } = REGISTRY_TESTS ? esegui(copia) : esegui(copia, OFFLINE_PIECES);
    expect(out).toContain("pubblicabile");
    expect(code).toBe(0);
  }, SECURITY_RUN_TIMEOUT_MS);

  test("PEZZO data: a THIRD PARTY's data in a tracked file goes RED", () => {
    // THE NAME HERE IS INVENTED, and that is new. Until 2026-09-02 this case
    // had to DERIVE the committer's name from the machine (`id -F`, `git config
    // user.name`, `userInfo`) and plant that: the gate looked for the repo's
    // author, so nothing else could have turned it red, and writing a real name
    // in this file would have been the very leak the gate prevents.
    //
    // The rule changed - the author's identity is public in 310 of the last 400
    // commits and is no longer redacted - so what the gate looks for is now a
    // DECLARED list of third parties, and the falsification gets simpler and
    // stronger at the same time: an invented name, handed over through
    // TOPICS_PERSONAL_TERMS, which exists precisely so that a gate whose only
    // input is an untracked file can still be SHOWN to turn red.
    const terzo = "Quintaine Marlowe";
    const elenco = join(temporanea, "terzi-di-prova.txt");
    writeFileSync(elenco, `${terzo}\n`);
    appendFileSync(join(copia, "README.md"), `\n<!-- chiesto da ${terzo} -->\n`);
    process.env.TOPICS_PERSONAL_TERMS = elenco;
    try {
      const { code, out } = esegui(copia, "--only=data");
      expect(out).toContain("ROSSO");
      expect(code).toBe(1);
    } finally {
      delete process.env.TOPICS_PERSONAL_TERMS;
      rmSync(elenco, { force: true });
      ripristina();
    }
  }, SECURITY_RUN_TIMEOUT_MS);

  test("PEZZO data: the repo AUTHOR's name does NOT go red", () => {
    // The other half of the rule, and the half that used to be the opposite:
    // this exact case was RED until 2026-09-02, and it is the reason
    // `bun test:unit` was red on three files whose only sin was naming the
    // person who wrote them. A gate that protects something already published
    // in every commit signature protects nothing; it only teaches people to
    // switch gates off.
    const repoAuthor = (spawnSync("git", ["config", "user.name"], { encoding: "utf8" }).stdout ?? "").trim();
    const termine = repoAuthor.split(/\s+/).find((t) => filtraTermini([t]).length > 0) ?? "";
    if (!termine) return; // no git identity on this machine: nothing to prove
    appendFileSync(join(copia, "README.md"), `\n<!-- deciso da ${repoAuthor} -->\n`);
    const { code, out } = esegui(copia, "--only=data");
    expect(out).toContain("verde");
    expect(code).toBe(0);
    ripristina();
  }, SECURITY_RUN_TIMEOUT_MS);

  test("PEZZO home: il percorso della home in un file tracciato fa ROSSO", () => {
    appendFileSync(join(copia, "README.md"), `\nlog in ${homedir()}/prova.log\n`);
    const { code, out } = esegui(copia, "--only=home");
    expect(out).toContain("ROSSO");
    expect(code).toBe(1);
    ripristina();
  }, SECURITY_RUN_TIMEOUT_MS);

  test("PEZZO secrets: una chiave nell'albero vero fa ROSSO", () => {
    const chiave = `${"AKIA"}${"Q7WR2XL9PKM4TVB8"}`;
    appendFileSync(join(copia, "README.md"), `\nAWS: ${chiave}\n`);
    const { code, out } = esegui(copia, "--only=secrets");
    expect(out).toContain("chiave AWS");
    expect(out).toContain("README.md");
    expect(code).toBe(1);
    ripristina();
  }, SECURITY_RUN_TIMEOUT_MS);

  // Registered only when the network is asked for: see REGISTRY_TESTS.
  if (REGISTRY_TESTS) test("PEZZO dependencies: un avviso NON dichiarato nella baseline fa ROSSO", () => {
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
  }, SECURITY_RUN_TIMEOUT_MS);

  test("un pezzo che non sa misurare NON stampa verde: esce 2", () => {
    // Il guasto che uccide i cancelli in silenzio e' il verde a vuoto. Qui il
    // test delegato sparisce dalla copia: l'esito giusto non e' 0 e non e' 1.
    rmSync(join(copia, "tests/unit/no-home-paths-tracked.test.ts"));
    const { code, out } = esegui(copia, "--only=home");
    expect(out).toContain("MUTO");
    expect(code).toBe(2);
    ripristina();
  }, SECURITY_RUN_TIMEOUT_MS);
});
