/**
 * Gli script di un progetto, da QUALUNQUE manifest — non solo `package.json`.
 *
 * Prima si leggeva un file solo: `package.json` → `scripts`. Su un progetto
 * Rust, Python, Go o su qualunque cosa retta da un Makefile la sezione Processi
 * era vuota per sempre, senza dire perché: i comandi c'erano, semplicemente
 * nessuno li guardava. E l'esecutore aveva `npm run` cablato, quindi anche
 * volendo non avrebbe saputo lanciarli.
 *
 * Ogni script rilevato porta con sé il PROPRIO `argv`. È questo che permette
 * all'esecutore di essere uno solo per tutti i formati invece di sapere a
 * memoria come si lancia ciascuno.
 *
 * ── I parser sono puri, e le fixture vengono dagli strumenti veri ───────────
 * Ogni formato ha la sua funzione senza I/O, e i test la confrontano con quello
 * che risponde lo strumento stesso dove esiste su questa macchina:
 * `make -pRrq` per i target, `deno task` per i task, `cargo metadata` per i
 * binari. Scrivere «il formato è questo» a memoria è esattamente il modo in cui
 * si perdono i casi veri — il binario implicito di Cargo (`src/main.rs`, che
 * nel TOML non è scritto da nessuna parte) non l'avrei trovato ragionando.
 *
 * ── Perché un `id` e non solo il nome ──────────────────────────────────────
 * Lo stesso nome può stare in due manifest: `test` in `package.json` e `test`
 * nel Makefile sono due comandi diversi. Il nome resta quello che si legge,
 * l'`id` (`<manifest>#<nome>`) è quello che si lancia.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface DetectedScript {
  /** Unico: `<manifest>#<nome>`. È la chiave con cui si lancia. */
  id: string;
  /** Come si legge nella lista. */
  name: string;
  /** Cosa fa, per il tooltip: il comando dichiarato nel manifest. */
  detail: string;
  /** Cosa si esegue davvero. */
  argv: string[];
  /** Da quale file viene. */
  from: string;
}

/** Tutti i file che guardiamo, in ordine. Serve anche allo stato vuoto. */
export const MANIFESTS = [
  "package.json",
  "Makefile",
  "Cargo.toml",
  "pyproject.toml",
  "deno.json",
  "composer.json",
  "justfile",
  "Taskfile.yml",
] as const;

// ── package.json ────────────────────────────────────────────────────────────

/**
 * Il gestore di pacchetti, dal file di lock.
 *
 * `npm run` era cablato: su un progetto Bun o pnpm lanciava comunque npm, che
 * a seconda dello script legge un `node_modules` diverso o non parte proprio.
 * Il lock è la dichiarazione più affidabile che un progetto abbia.
 */
export function pickPackageManager(presenti: (f: string) => boolean): "bun" | "pnpm" | "yarn" | "npm" {
  if (presenti("bun.lock") || presenti("bun.lockb")) return "bun";
  if (presenti("pnpm-lock.yaml")) return "pnpm";
  if (presenti("yarn.lock")) return "yarn";
  return "npm";
}

export function parsePackageScripts(text: string): { name: string; detail: string }[] {
  try {
    const pkg = JSON.parse(text);
    const s = pkg?.scripts;
    if (!s || typeof s !== "object") return [];
    return Object.entries(s)
      .filter(([, v]) => typeof v === "string")
      .map(([name, v]) => ({ name, detail: v as string }));
  } catch { return []; }
}

// ── Makefile ────────────────────────────────────────────────────────────────

/**
 * I target di un Makefile.
 *
 * Le trappole, tutte confermate contro `make -pRrq` su un Makefile vero:
 *  - `VAR := valore` contiene i due punti e NON è un target. Idem `?=`, `+=`.
 *  - `%.o: %.c` è una regola a modello, non un target invocabile.
 *  - `.PHONY`, `.SUFFIXES` e ogni nome che comincia per punto sono direttive.
 *  - `install:: build` (doppio due punti) È un target.
 *  - le righe che cominciano con TAB sono ricette, non dichiarazioni.
 *  - una riga può dichiarare più target: `a b c: dep`.
 */
export function parseMakefileTargets(text: string): string[] {
  const out: string[] = [];
  const visti = new Set<string>();
  for (const raw of text.split("\n")) {
    if (raw.startsWith("\t")) continue;            // ricetta
    const riga = raw.replace(/#.*$/, "").trim();
    if (!riga) continue;
    // Assegnamento: `=`, `:=`, `::=`, `?=`, `+=` prima di qualunque `:` solo.
    if (/^[^:=]*(::=|:=|\?=|\+=|=)/.test(riga)) continue;
    const m = /^([^:]+)::?(?!=)/.exec(riga);
    if (!m) continue;
    for (const nome of m[1].trim().split(/\s+/)) {
      if (!nome || nome.startsWith(".") || nome.includes("%") || nome.includes("$")) continue;
      if (visti.has(nome)) continue;
      visti.add(nome);
      out.push(nome);
    }
  }
  return out;
}

// ── TOML, quel tanto che basta ──────────────────────────────────────────────

/**
 * Un lettore TOML minimo: tabelle, tabelle-array e valori stringa.
 *
 * Basta per quello che serve qui (i nomi dei binari di Cargo e le tabelle di
 * task di pyproject) e non porta una dipendenza per leggere due chiavi. Non
 * gestisce array multi-riga, stringhe multilinea o date: se un giorno servissero
 * si mette un parser vero, non si allarga questo di nascosto.
 */
export function parseTomlTables(text: string): { tables: Map<string, Map<string, string>>; arrays: Map<string, Map<string, string>[]> } {
  const tables = new Map<string, Map<string, string>>();
  const arrays = new Map<string, Map<string, string>[]>();
  let corrente: Map<string, string> | null = null;

  for (const raw of text.split("\n")) {
    const riga = raw.replace(/\s+#.*$/, "").trim();
    if (!riga || riga.startsWith("#")) continue;

    const arr = /^\[\[([^\]]+)\]\]$/.exec(riga);
    if (arr) {
      corrente = new Map();
      const lista = arrays.get(arr[1].trim()) ?? [];
      lista.push(corrente);
      arrays.set(arr[1].trim(), lista);
      continue;
    }
    const tab = /^\[([^\]]+)\]$/.exec(riga);
    if (tab) {
      corrente = new Map();
      tables.set(tab[1].trim(), corrente);
      continue;
    }
    if (!corrente) continue;

    const kv = /^("?)([^"=]+)\1\s*=\s*(.+)$/.exec(riga);
    if (!kv) continue;
    const chiave = kv[2].trim();
    let valore = kv[3].trim();
    // Tabella in linea: si tiene il comando, che è l'unica cosa che ci serve.
    const inline = /^\{.*\}$/.test(valore)
      ? /(?:cmd|shell|command)\s*=\s*"([^"]*)"/.exec(valore)?.[1]
      : undefined;
    if (inline !== undefined) valore = inline;
    else valore = valore.replace(/^["']|["']$/g, "");
    corrente.set(chiave, valore);
  }
  return { tables, arrays };
}

/**
 * I binari di un progetto Cargo.
 *
 * `hasMainRs` non è un dettaglio: un `src/main.rs` produce un binario che ha il
 * nome del PACCHETTO e nel TOML non è scritto da nessuna parte. `cargo
 * metadata` lo elenca, un parser che legge solo `[[bin]]` no.
 */
export function parseCargoBins(text: string, hasMainRs: boolean): string[] {
  const { tables, arrays } = parseTomlTables(text);
  const out: string[] = [];
  const pkg = tables.get("package")?.get("name");
  if (hasMainRs && pkg) out.push(pkg);
  for (const bin of arrays.get("bin") ?? []) {
    const n = bin.get("name");
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Le tabelle di pyproject che sono davvero elenchi di task, con il loro runner. */
const PY_TASKS: { tabella: string; argv: (n: string) => string[] }[] = [
  { tabella: "tool.taskipy.tasks", argv: n => ["task", n] },
  { tabella: "tool.pdm.scripts", argv: n => ["pdm", "run", n] },
  { tabella: "tool.poe.tasks", argv: n => ["poe", n] },
  { tabella: "tool.hatch.envs.default.scripts", argv: n => ["hatch", "run", n] },
];

/**
 * I task di un pyproject.
 *
 * NON `[project.scripts]` né `[tool.poetry.scripts]`: quelli sono entry point
 * del pacchetto installato, non comandi da lanciare qui. Elencarli darebbe una
 * lista di bottoni che falliscono finché il pacchetto non è installato.
 */
export function parsePyprojectTasks(text: string): { name: string; detail: string; argv: string[] }[] {
  const { tables } = parseTomlTables(text);
  const out: { name: string; detail: string; argv: string[] }[] = [];
  for (const { tabella, argv } of PY_TASKS) {
    const t = tables.get(tabella);
    if (!t) continue;
    for (const [name, detail] of t) {
      if (name.startsWith("_")) continue;   // pdm: chiavi di servizio
      out.push({ name, detail, argv: argv(name) });
    }
  }
  return out;
}

// ── JSON con i commenti (deno.jsonc) ───────────────────────────────────────

/** Toglie i commenti `//` e le virgole finali, senza toccarli dentro le stringhe. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inStr = false, esc = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && next === "/") { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * I task di deno. Un task è una stringa OPPURE un oggetto con `command` —
 * confermato da `deno task`, che elenca allo stesso modo tutt'e due le forme.
 */
export function parseDenoTasks(text: string): { name: string; detail: string }[] {
  try {
    const cfg = JSON.parse(stripJsonComments(text));
    const t = cfg?.tasks;
    if (!t || typeof t !== "object") return [];
    return Object.entries(t).map(([name, v]) => ({
      name,
      detail: typeof v === "string" ? v : String((v as { command?: string })?.command ?? ""),
    }));
  } catch { return []; }
}

// ── composer, just, Taskfile ────────────────────────────────────────────────

export function parseComposerScripts(text: string): { name: string; detail: string }[] {
  try {
    const c = JSON.parse(text);
    const s = c?.scripts;
    if (!s || typeof s !== "object") return [];
    return Object.entries(s).map(([name, v]) => ({
      name,
      detail: Array.isArray(v) ? v.join(" && ") : String(v),
    }));
  } catch { return []; }
}

/**
 * Le ricette di un justfile.
 *
 * `nome := valore` è un assegnamento, non una ricetta. Una ricetta può avere
 * parametri (`build target:`) e può essere silenziata con `@`. Le righe
 * indentate sono il corpo.
 */
export function parseJustRecipes(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (/^\s/.test(raw)) continue;
    const riga = raw.replace(/\s+#.*$/, "").trim();
    if (!riga || riga.startsWith("#")) continue;
    if (/:=/.test(riga)) continue;
    const m = /^@?([A-Za-z_][A-Za-z0-9_-]*)(\s+[^:]*)?:(?!=)/.exec(riga);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * I task di un Taskfile (go-task). YAML letto per indentazione: i nomi stanno
 * a due spazi sotto `tasks:`. Un parser YAML completo per leggere delle chiavi
 * sarebbe una dipendenza sproporzionata.
 */
export function parseTaskfileTasks(text: string): string[] {
  const out: string[] = [];
  let dentro = false;
  let rientro = -1;
  for (const raw of text.split("\n")) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    if (/^tasks:\s*$/.test(raw)) { dentro = true; continue; }
    if (!dentro) continue;
    const m = /^(\s+)([A-Za-z_][A-Za-z0-9_:-]*):\s*$|^(\s+)([A-Za-z_][A-Za-z0-9_:-]*):\s*\S/.exec(raw);
    if (!m) {
      if (/^\S/.test(raw)) dentro = false;   // è cominciata un'altra sezione
      continue;
    }
    const spazi = (m[1] ?? m[3])!.length;
    const nome = (m[2] ?? m[4])!;
    if (rientro === -1) rientro = spazi;
    if (spazi !== rientro) continue;          // è una chiave del task, non un task
    if (!out.includes(nome)) out.push(nome);
  }
  return out;
}

// ── Il rilevamento vero e proprio ───────────────────────────────────────────

export interface DetectionResult {
  scripts: DetectedScript[];
  /** I manifest trovati: lo stato vuoto dice cosa ha guardato e cosa ha visto. */
  found: string[];
}

/** L'accesso al disco, iniettabile: i parser restano puri e i test pure. */
export interface Fs {
  exists: (rel: string) => boolean;
  read: (rel: string) => string | null;
}

function realFs(projectPath: string): Fs {
  return {
    exists: rel => existsSync(join(projectPath, rel)),
    read: rel => { try { return readFileSync(join(projectPath, rel), "utf-8"); } catch { return null; } },
  };
}

/** Il primo dei nomi che esiste (i manifest cambiano maiuscole a seconda del progetto). */
function primoChe(fs: Fs, nomi: string[]): string | null {
  for (const n of nomi) if (fs.exists(n)) return n;
  return null;
}

export function detectScripts(projectPath: string, fs: Fs = realFs(projectPath)): DetectionResult {
  const scripts: DetectedScript[] = [];
  const found: string[] = [];
  const aggiungi = (from: string, name: string, detail: string, argv: string[]) => {
    scripts.push({ id: `${from}#${name}`, name, detail, argv, from });
  };

  // package.json
  const pkg = fs.read("package.json");
  if (pkg !== null) {
    found.push("package.json");
    const pm = pickPackageManager(fs.exists);
    for (const s of parsePackageScripts(pkg)) {
      aggiungi("package.json", s.name, s.detail, [pm, "run", s.name]);
    }
  }

  // Makefile
  const mk = primoChe(fs, ["Makefile", "makefile", "GNUmakefile"]);
  if (mk) {
    found.push(mk);
    for (const t of parseMakefileTargets(fs.read(mk) ?? "")) {
      aggiungi(mk, t, `make ${t}`, ["make", t]);
    }
  }

  // Cargo
  const cargo = fs.read("Cargo.toml");
  if (cargo !== null) {
    found.push("Cargo.toml");
    aggiungi("Cargo.toml", "build", "cargo build", ["cargo", "build"]);
    aggiungi("Cargo.toml", "test", "cargo test", ["cargo", "test"]);
    const bins = parseCargoBins(cargo, fs.exists("src/main.rs"));
    if (bins.length <= 1) {
      aggiungi("Cargo.toml", "run", "cargo run", ["cargo", "run"]);
    } else {
      for (const b of bins) aggiungi("Cargo.toml", `run ${b}`, `cargo run --bin ${b}`, ["cargo", "run", "--bin", b]);
    }
  }

  // pyproject
  const py = fs.read("pyproject.toml");
  if (py !== null) {
    found.push("pyproject.toml");
    for (const t of parsePyprojectTasks(py)) aggiungi("pyproject.toml", t.name, t.detail, t.argv);
  }

  // deno
  const deno = primoChe(fs, ["deno.json", "deno.jsonc"]);
  if (deno) {
    found.push(deno);
    for (const t of parseDenoTasks(fs.read(deno) ?? "")) {
      aggiungi(deno, t.name, t.detail, ["deno", "task", t.name]);
    }
  }

  // composer
  const comp = fs.read("composer.json");
  if (comp !== null) {
    found.push("composer.json");
    for (const s of parseComposerScripts(comp)) {
      aggiungi("composer.json", s.name, s.detail, ["composer", "run-script", s.name]);
    }
  }

  // just
  const just = primoChe(fs, ["justfile", "Justfile", ".justfile"]);
  if (just) {
    found.push(just);
    for (const r of parseJustRecipes(fs.read(just) ?? "")) {
      aggiungi(just, r, `just ${r}`, ["just", r]);
    }
  }

  // Taskfile
  const tf = primoChe(fs, ["Taskfile.yml", "Taskfile.yaml"]);
  if (tf) {
    found.push(tf);
    for (const t of parseTaskfileTasks(fs.read(tf) ?? "")) {
      aggiungi(tf, t, `task ${t}`, ["task", t]);
    }
  }

  return { scripts, found };
}

/** Lo script da lanciare, per id o — per chi ha solo quello — per nome. */
export function resolveScript(res: DetectionResult, chiave: string): DetectedScript | null {
  return res.scripts.find(s => s.id === chiave) ?? res.scripts.find(s => s.name === chiave) ?? null;
}
