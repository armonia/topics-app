#!/usr/bin/env bun
/**
 * scripts/check-security.ts - UN comando che risponde a UNA domanda: questo
 * checkout si puo' pubblicare?
 *
 * PERCHE' ESISTE. I controlli c'erano gia', ma si ricordavano a mano. Il repo e'
 * PUBBLICO dal 2026-06-02, e la sera del 13/08 un audit ha trovato il nome del
 * proprietario rientrato in 136 file tracciati: da li' sono nati i due test che
 * questo comando ESEGUE invece di riscrivere (`no-personal-data-tracked` e
 * `no-home-paths-tracked`). Funzionano: nella notte fra il 13 e il 14 hanno
 * fermato due tornate. Ma «funzionano» valeva solo per chi si ricordava di
 * lanciarli, e due delle quattro classi di fuga non aveva nessuno che le
 * guardasse. Un cancello che si ricorda a mano e' una consuetudine, e le
 * consuetudini saltano di notte, quando lavorano dodici agenti in parallelo.
 *
 * I QUATTRO PEZZI, e falliscono per ragioni diverse:
 *
 *   data          nome, cognome, email, username di una persona vera in un file
 *                 tracciato. Delegato a `tests/unit/no-personal-data-tracked.test.ts`.
 *   home          il percorso della home di chi committa. Delegato a
 *                 `tests/unit/no-home-paths-tracked.test.ts`.
 *   secrets       NUOVO. Chiavi, token, password e chiavi private in chiaro, piu'
 *                 i file `.env` che non devono nemmeno essere tracciati.
 *   dependencies  NUOVO. `bun audit` sui tre lockfile (radice, client, landing),
 *                 a cricchetto contro una baseline dichiarata.
 *
 * DELEGARE INVECE DI RISCRIVERE. I primi due pezzi lanciano i test che esistono,
 * nel checkout indicato da `--root`. Copiarne la logica qui dentro avrebbe
 * prodotto due copie della stessa regola che divergono al primo fix applicato a
 * una sola delle due: e' esattamente la classe di guasto che `check:bloat`
 * misura. Il prezzo e' un `bun test` per pezzo, cioe' un paio di secondi.
 *
 * PERCHE' NON CERCA I SEGRETI CON `grep`. Su questa postazione `grep` e' una
 * funzione ugrep con `-I --ignore-files`: salta i file che giudica binari e
 * TUTTO cio' che sta nei `.gitignore`, cioe' proprio i `.env` e le cartelle di
 * credenziali. Un cancello che si appoggia a quel `grep` cerca ovunque tranne
 * dove i segreti stanno davvero. Qui i file arrivano da `git ls-files` e si
 * leggono con `fs`: nessuna shell in mezzo, nessuna configurazione della
 * postazione che possa spegnere il controllo in silenzio.
 *
 * DENTRO I GUARD RAILS. Niente bundle, niente server, niente database: solo
 * `git ls-files`, la lettura dei file tracciati, due `bun test` e `bun audit`.
 * Sull'albero intero sono ~3 secondi.
 *
 * IN CI NE GIRANO DUE SU QUATTRO, ed e' una scelta, non una dimenticanza.
 * `data` e `home` cercano il nome e la home di CHI COMMITTA e li DERIVANO dalla
 * macchina, apposta per non doverli scrivere in un repo pubblico. Un runner di
 * GitHub non ha un'identita' da proteggere: il suo account si chiama `runner`,
 * che non e' il nome di nessuno e compare in decine di file tracciati. La'
 * quei due pezzi misurerebbero come si chiama l'utente della macchina di build.
 * Mordono dove il commit nasce davvero: sulla postazione (`bun run
 * check:security`, tutti e quattro) e nei check pre-review, che eseguono
 * `test:unit` nel worktree dell'agente. In `.github/workflows/ci.yml` va la
 * meta' che non dipende da chi e' alla tastiera: `--only=secrets,dependencies`.
 *
 * EXIT CODES
 *   0  il checkout e' pubblicabile
 *   1  almeno un pezzo ha trovato una violazione
 *   2  la misura non si e' potuta prendere (niente git, baseline illeggibile,
 *      `bun audit` che non risponde JSON). Un cancello che non sa guardare non
 *      deve stampare verde: il verde a vuoto e' il modo in cui i cancelli di
 *      questo repo hanno smesso di mordere tre volte.
 *
 * USAGE
 *   bun run check:security                     tutti e quattro i pezzi
 *   bun run check:security --json              stesso esito, leggibile a macchina
 *   bun run check:security --only=secrets      un pezzo solo (data|home|secrets|dependencies)
 *   bun run check:security --root=<dir>        misura un ALTRO checkout
 *   bun run check:security --update-baseline   riscrive la baseline delle dipendenze
 *
 * COME SI FALSIFICA, e mai sul checkout vivo. `--root` esiste per questo: si
 * copia l'albero tracciato in una cartella temporanea, ci si introduce la
 * violazione, si punta il comando li'. Il banco automatico e'
 * `scripts/check-security.test.ts`: introduce i quattro guasti uno per uno e
 * pretende di vedere esito 1 quattro volte, piu' esito 2 quando un pezzo non
 * sa misurare.
 *
 * Il pezzo delle dipendenze e' stato provato anche con una vulnerabilita' VERA,
 * fuori dal banco perche' costa un `bun install`: una cartella con
 * `lodash@4.17.20` e una baseline vuota, e il comando esce 1 elencando i cinque
 * avvisi di quel pacchetto per id e per URL. Nel banco la stessa cosa si
 * ottiene togliendo una voce dalla baseline, che per il cancello e' lo stesso
 * stato osservabile e non costa mezzo registro npm.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_ROOT = resolve(import.meta.dir, "..");

/** I quattro pezzi, nell'ordine in cui si leggono nel referto. */
const PARTS = ["data", "home", "secrets", "dependencies"] as const;
type Part = (typeof PARTS)[number];

interface Outcome {
  part: Part;
  /** ok = niente da dire; red = violazione; mute = non si e' potuto misurare. */
  status: "ok" | "red" | "mute";
  summary: string;
  details: string[];
}

// ---------------------------------------------------------------------------
// Pezzi 1 e 2: i due cancelli che gia' esistono
// ---------------------------------------------------------------------------

/**
 * Un test del repo, eseguito nel checkout misurato.
 *
 * Nessuno dei due file importa qualcosa da `node_modules` (solo `bun:test`,
 * `fs`, `path`, `os`, `child_process` e il modulo del debito qui accanto),
 * quindi girano anche su un clone appena fatto e senza `bun install`. Se un
 * domani uno dei due prendesse una dipendenza, il banco di falsificazione lo
 * scopre subito: la copia che costruisce non ha `node_modules`.
 */
function runDelegatedTest(part: Part, root: string, file: string): Outcome {
  if (!existsSync(join(root, file))) {
    return {
      part,
      status: "mute",
      summary: `${file} non esiste sotto ${root}`,
      details: [
        "Il cancello che questo pezzo doveva eseguire non c'e' piu'. O e' stato",
        "rinominato (aggiorna il percorso qui in check-security.ts), o e' stato",
        "tolto, e allora la domanda da farsi e' chi guarda quella classe di fuga.",
      ],
    };
  }
  const res = spawnSync("bun", ["test", file], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  if (res.error) {
    return { part, status: "mute", summary: `bun test non e' partito: ${String(res.error)}`, details: [] };
  }
  // bun scrive il referto dei test su stderr.
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  if (res.status === 0) {
    return { part, status: "ok", summary: `${file}: verde`, details: [] };
  }
  return {
    part,
    status: "red",
    summary: `${file}: rosso (bun test e' uscito ${res.status})`,
    details: out.split("\n").slice(-40),
  };
}

// ---------------------------------------------------------------------------
// Pezzo 3: segreti in chiaro
// ---------------------------------------------------------------------------

/**
 * Solo testo che un umano scrive o che un attrezzo genera. I binari non si
 * leggono come stringhe, e un lockfile e' pieno di hash che somigliano a
 * chiavi senza esserlo.
 */
const SCANNABLE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|sql|sh|yml|yaml|toml|css|html|rs|plist|txt|env|example)$/;

/** File senza estensione che vanno guardati lo stesso: sono quasi tutti config. */
const EXTENSIONLESS = /(?:^|\/)(?:\.env[^/]*|Dockerfile|Procfile|\.npmrc|\.netrc)$/;

/**
 * Le firme. Sono TUTTE di forma, mai di parola: cercano come e' fatta una
 * chiave, non come si chiama la variabile che la contiene.
 *
 * PERCHE' NON UNA REGOLA GENERICA `password = "..."`. E' stata provata per
 * prima, ed e' la ragione per cui la maggior parte degli scanner di segreti
 * viene spenta: su questo albero produceva decine di righe, tutte finte
 * (fixture dei test, valori di esempio nei .md, chiavi di localStorage). Un
 * cancello che grida sempre e' un cancello che si impara a saltare. La regola
 * generica resta, ma solo con un valore ad ALTA ENTROPIA (vedi `entropy`):
 * quello che distingue una chiave vera da un segnaposto non e' il nome, e' che
 * una chiave vera e' casuale.
 */
const SIGNATURES: { name: string; re: RegExp }[] = [
  { name: "chiave Anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{24,}/g },
  { name: "chiave OpenAI", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { name: "token GitHub", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { name: "chiave AWS", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "chiave Google", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "token Slack", re: /\bxox[baprse]-[0-9A-Za-z-]{12,}/g },
  { name: "chiave Stripe di produzione", re: /\b[sr]k_live_[0-9A-Za-z]{20,}/g },
  { name: "token ElevenLabs", re: /\bsk_[0-9a-f]{40,}\b/g },
  { name: "chiave privata PEM", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: "credenziale dentro una URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"']+:[^/\s:@"']{8,}@[^\s"']+/gi },
  { name: "JSON Web Token firmato", re: /\beyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
];

/** La regola generica, tenuta a bada dall'entropia del VALORE. */
const ASSIGNMENT =
  /\b(?:password|passwd|secret|client_secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key)\b["']?\s*[:=]\s*["`']([^"`'\s$]{20,})["`']/gi;

/**
 * Entropia di Shannon per carattere. Una chiave vera sta sopra 3.5 bit; una
 * frase inglese sta sotto 3, e un segnaposto come `changeme-please-really`
 * anche. La soglia e' bassa di proposito: sbagliare verso il falso allarme si
 * corregge con una riga di esenzione motivata, sbagliare verso il silenzio si
 * scopre quando la chiave e' gia' pubblica.
 */
function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** I valori che NON sono segreti per costruzione, e non serve misurarli. */
const PLACEHOLDER =
  /^(?:your|my|the|a|some|test|fake|dummy|example|sample|placeholder|changeme|redacted|hidden|xxx+|\.\.\.|<|\{|\$|process\.env|import\.meta)/i;

/**
 * La via d'uscita quando il carattere E' il dato: la riga finisce con
 * `allow-secret: <ragione>`. Come `allow-emdash`, e per la stessa ragione: un
 * cancello senza sfogo motivato si spegne del tutto alla prima riga legittima.
 */
const ESCAPE_HATCH = /\ballow-secret:\s*(\S.*)$/;

/**
 * Esenzioni per file, ognuna con la sua ragione. Un'esenzione senza ragione
 * scritta e' un buco che fra sei mesi nessuno sa piu' valutare.
 *
 * LE CHIAVI SONO PERCORSI, quindi vivono e muoiono con il nome del file: al
 * rinomino da `check-sicurezza` a `check-security` queste due righe vanno
 * spostate nello STESSO edit, o il cancello denuncia il proprio sorgente.
 */
const EXEMPT = new Map<string, string>([
  [
    "scripts/check-security.ts",
    "Questo file: contiene le FIRME dei segreti come codice che li cerca, mai un segreto come dato.",
  ],
  [
    "scripts/check-security.test.ts",
    "Il banco che falsifica questo cancello: costruisce i finti segreti a runtime, pezzo per pezzo, proprio per non scriverli qui.",
  ],
]);

/** Un `.env` tracciato e' una fuga a prescindere da cosa c'e' dentro. */
const ENV_TRACKED = /(?:^|\/)\.env(?:\.[^/]*)?$/;
const ENV_ALLOWED = /(?:^|\/)\.env\.(?:example|sample|template)$/;

function trackedFiles(root: string): string[] {
  const res = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    console.error(`[check-security] non riesco a elencare i file tracciati sotto ${root}: git e' uscito ${res.status}`);
    process.exit(2);
  }
  return res.stdout.toString("utf8").split("\0").filter(Boolean);
}

function scanSecrets(root: string): Outcome {
  const tracked = trackedFiles(root);
  if (tracked.length === 0) {
    return { part: "secrets", status: "mute", summary: `nessun file tracciato sotto ${root}`, details: [] };
  }

  const found: string[] = [];

  for (const rel of tracked) {
    if (ENV_TRACKED.test(rel) && !ENV_ALLOWED.test(rel)) {
      found.push(
        `${rel}  e' un file .env TRACCIATO. Non e' una questione di cosa contiene oggi: ` +
          `togli il file dall'indice (\`git rm --cached\`) e mettilo in .gitignore.`,
      );
      continue;
    }
    if (EXEMPT.has(rel)) continue;
    if (!SCANNABLE.test(rel) && !EXTENSIONLESS.test(rel)) continue;

    const abs = join(root, rel);
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
    } catch {
      continue; // tracciato ma assente dal disco
    }
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue; // binario travestito da testo
    }

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const escape = ESCAPE_HATCH.exec(line);
      if (escape && escape[1]!.trim().length >= 8) continue;

      for (const signature of SIGNATURES) {
        signature.re.lastIndex = 0;
        const m = signature.re.exec(line);
        if (m) found.push(`${rel}:${i + 1}  ${signature.name} (${preview(m[0])})`);
      }

      ASSIGNMENT.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = ASSIGNMENT.exec(line)) !== null) {
        const value = a[1]!;
        if (PLACEHOLDER.test(value)) continue;
        if (entropy(value) < 3.5) continue;
        found.push(`${rel}:${i + 1}  valore ad alta entropia assegnato a un nome che sa di credenziale (${preview(value)})`);
      }
    }
  }

  if (found.length === 0) {
    return { part: "secrets", status: "ok", summary: `${tracked.length} file tracciati, nessun segreto in chiaro`, details: [] };
  }
  return {
    part: "secrets",
    status: "red",
    summary: `${found.length} segreto/i in chiaro in file TRACCIATI`,
    details: [
      ...found.slice(0, 40),
      ...(found.length > 40 ? [`... e altri ${found.length - 40}`] : []),
      "",
      "Un segreto in un file tracciato e' gia' pubblico dal commit che lo ha aggiunto:",
      "toglierlo dal file NON lo toglie dalla storia. Prima REVOCA la chiave, poi",
      "spostala nel Keychain (`security add-generic-password -s <servizio> -a <uso>`),",
      "poi togli la riga. Se il carattere E' il dato (una fixture, un esempio nella",
      "documentazione), la riga finisce con `allow-secret: <ragione>`.",
    ],
  };
}

/** Mai stampare il segreto intero: il referto finisce nei log della CI. */
function preview(s: string): string {
  const head = s.slice(0, 8);
  return `${head}... ${s.length} caratteri`;
}

// ---------------------------------------------------------------------------
// Pezzo 4: dipendenze
// ---------------------------------------------------------------------------

interface Advisory {
  package: string;
  id: number;
  severity: string;
  title: string;
  url: string;
}

interface Baseline {
  $schema: string;
  _comment: string[];
  updated: string;
  /** cartella (relativa alla radice) -> avvisi noti e accettati quel giorno. */
  advisories: Record<string, Advisory[]>;
}

/** Le cartelle con un lockfile proprio. `bun audit` guarda una cartella sola. */
const LOCKFILE_DIRS = [".", "client", "landing"];

const BASELINE_REL = "scripts/security-baseline.json";

function auditDir(root: string, dir: string): { advisories: Advisory[]; error: string | null } {
  const cwd = dir === "." ? root : join(root, dir);
  if (!existsSync(join(cwd, "bun.lock"))) return { advisories: [], error: null };
  const res = spawnSync("bun", ["audit", "--json"], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (res.error) return { advisories: [], error: `bun audit non e' partito in ${dir}: ${String(res.error)}` };
  const raw = (res.stdout ?? "").trim();
  if (raw.length === 0) {
    // Nessun avviso: bun stampa il banner su stderr e niente su stdout.
    if (res.status === 0) return { advisories: [], error: null };
    return { advisories: [], error: `bun audit in ${dir} e' uscito ${res.status} senza JSON: ${(res.stderr ?? "").trim().slice(0, 300)}` };
  }
  let parsed: Record<string, { id: number; severity: string; title: string; url: string }[]>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { advisories: [], error: `bun audit in ${dir} non ha risposto JSON: ${raw.slice(0, 300)}` };
  }
  const advisories: Advisory[] = [];
  for (const [pkg, list] of Object.entries(parsed)) {
    for (const a of list ?? []) {
      advisories.push({ package: pkg, id: a.id, severity: a.severity, title: a.title, url: a.url });
    }
  }
  advisories.sort((x, y) => x.package.localeCompare(y.package) || x.id - y.id);
  return { advisories, error: null };
}

function checkDependencies(root: string, baseline: Baseline | null, update: boolean): { outcome: Outcome; measured: Record<string, Advisory[]> } {
  const measured: Record<string, Advisory[]> = {};
  const errors: string[] = [];
  for (const dir of LOCKFILE_DIRS) {
    const { advisories, error } = auditDir(root, dir);
    if (error) errors.push(error);
    else measured[dir] = advisories;
  }

  if (errors.length > 0) {
    return {
      outcome: {
        part: "dependencies",
        status: "mute",
        summary: "bun audit non ha risposto",
        details: [
          ...errors,
          "",
          "`bun audit` interroga il registro: senza rete non c'e' misura, e senza misura",
          "questo comando non stampa verde. E' la ragione per cui l'esito e' 2 e non 0.",
        ],
      },
      measured,
    };
  }

  if (update) {
    return { outcome: { part: "dependencies", status: "ok", summary: "baseline da riscrivere", details: [] }, measured };
  }

  if (!baseline) {
    return {
      outcome: {
        part: "dependencies",
        status: "mute",
        summary: `manca ${BASELINE_REL}`,
        details: [`Riscrivila con \`bun run check:security --update-baseline\` e leggi il diff prima di committarlo.`],
      },
      measured,
    };
  }

  const fresh: string[] = [];
  const healed: string[] = [];
  for (const dir of Object.keys(measured)) {
    const known = new Set((baseline.advisories[dir] ?? []).map((a) => `${a.package}#${a.id}`));
    for (const a of measured[dir]!) {
      if (known.has(`${a.package}#${a.id}`)) continue;
      fresh.push(`${dir === "." ? "radice" : dir}: ${a.package} [${a.severity}] ${a.title}\n      ${a.url}`);
    }
    const now = new Set(measured[dir]!.map((a) => `${a.package}#${a.id}`));
    for (const a of baseline.advisories[dir] ?? []) {
      if (!now.has(`${a.package}#${a.id}`)) healed.push(`${dir === "." ? "radice" : dir}: ${a.package} (${a.id}) non c'e' piu'`);
    }
  }

  if (fresh.length === 0) {
    const total = Object.values(measured).reduce((n, v) => n + v.length, 0);
    return {
      outcome: {
        part: "dependencies",
        status: "ok",
        summary: `${total} avviso/i, tutti dentro la baseline del ${baseline.updated}`,
        // Migliorare non fallisce mai, ma va detto o la baseline marcisce.
        details: healed.length > 0 ? [...healed, "Riscrivi la baseline con `--update-baseline` per congelare il miglioramento."] : [],
      },
      measured,
    };
  }
  return {
    outcome: {
      part: "dependencies",
      status: "red",
      summary: `${fresh.length} avviso/i NUOVO/I rispetto alla baseline del ${baseline.updated}`,
      details: [
        ...fresh.map((n) => `  ${n}`),
        "",
        "Aggiorna il pacchetto, oppure accetta l'avviso con `--update-baseline` NELLO",
        "STESSO commit che lo accetta, cosi' il diff dice cosa si e' deciso di tenersi.",
      ],
    },
    measured,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  let root = DEFAULT_ROOT;
  let json = false;
  let update = false;
  let only: Part[] = [...PARTS];

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--root=")) {
      root = resolve(arg.slice("--root=".length));
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--update-baseline") {
      update = true;
    } else if (arg.startsWith("--only=")) {
      const requested = arg.slice("--only=".length).split(",").map((s) => s.trim());
      const unknown = requested.filter((c) => !PARTS.includes(c as Part));
      if (unknown.length > 0) {
        console.error(`[check-security] pezzo sconosciuto: ${unknown.join(", ")}. Sono: ${PARTS.join(" ")}`);
        process.exit(2);
      }
      only = requested as Part[];
    } else {
      console.error(`[check-security] argomento sconosciuto: ${arg}`);
      process.exit(2);
    }
  }

  if (update && !only.includes("dependencies")) {
    // Senza questa riga `--update-baseline --only=secrets` non scriverebbe
    // niente e uscirebbe zero: chi lo ha lanciato crede di aver aggiornato la
    // baseline, e il prossimo avviso nuovo passa perche' quella e' vecchia.
    console.error("[check-security] --update-baseline riguarda solo il pezzo `dependencies`, che --only ha escluso.");
    process.exit(2);
  }

  const baselinePath = join(root, BASELINE_REL);
  let baseline: Baseline | null = null;
  if (existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
    } catch (err) {
      console.error(`[check-security] baseline illeggibile in ${baselinePath} (${String(err)})`);
      process.exit(2);
    }
  }

  const outcomes: Outcome[] = [];
  if (only.includes("data")) outcomes.push(runDelegatedTest("data", root, "tests/unit/no-personal-data-tracked.test.ts"));
  if (only.includes("home")) outcomes.push(runDelegatedTest("home", root, "tests/unit/no-home-paths-tracked.test.ts"));
  if (only.includes("secrets")) outcomes.push(scanSecrets(root));
  if (only.includes("dependencies")) {
    const { outcome, measured } = checkDependencies(root, baseline, update);
    if (update) {
      const next: Baseline = {
        $schema: "security-baseline-v1",
        _comment: baseline?._comment ?? [],
        updated: new Date().toISOString().slice(0, 10),
        advisories: measured,
      };
      writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`[check-security] baseline riscritta: ${baselinePath}`);
      process.exit(0);
    }
    outcomes.push(outcome);
  }

  if (json) {
    console.log(JSON.stringify({ root, misurato_il: new Date().toISOString().slice(0, 10), esiti: outcomes }, null, 2));
  } else {
    console.log(`[check-security] ${root}`);
    console.log("");
    for (const e of outcomes) {
      const badge = e.status === "ok" ? "OK  " : e.status === "red" ? "ROSSO" : "MUTO";
      console.log(`${badge}  ${e.part.padEnd(13)} ${e.summary}`);
      for (const d of e.details) console.log(`      ${d}`);
      if (e.details.length > 0) console.log("");
    }
  }

  const mutes = outcomes.filter((e) => e.status === "mute");
  const reds = outcomes.filter((e) => e.status === "red");
  if (reds.length > 0) {
    console.error(`[check-security] NON PUBBLICABILE - ${reds.map((r) => r.part).join(", ")}.`);
    process.exit(1);
  }
  if (mutes.length > 0) {
    console.error(`[check-security] MISURA NON PRESA - ${mutes.map((m) => m.part).join(", ")}. Verde non se ne stampa.`);
    process.exit(2);
  }
  console.log(`[check-security] OK - ${outcomes.length} pezzo/i verde/i: il checkout e' pubblicabile.`);
  process.exit(0);
}

main();
