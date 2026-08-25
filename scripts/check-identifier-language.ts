#!/usr/bin/env bun
/**
 * scripts/check-identifier-language.ts — fail the build when a NEW identifier
 * is not an English word.
 *
 * WHY IT EXISTS, and why `check:comment-language` could never have done it.
 * That gate reads COMMENTS, by construction: it says so on its first line, and
 * an identifier is invisible to it. On 2026-08-21 four new names went in over
 * one evening — `sostituisce`, `annunciaRipresa`, `NOTA_SESSIONE_MORTA`,  allow-italian: the Italian names ARE the subject
 * `PREFISSO_NOTA_ANTEPRIMA` — through every gate, green all the way.  allow-italian: the Italian names ARE the subject
 *
 * The obvious repair would have been the worst outcome available. That gate
 * recognises Italian by matching a list of 85 stopwords, and six of the eight
 * tokens in those four names are not on it. Extended as-is to identifiers, it
 * would have passed all four and gone on reporting success: a blind gate, which
 * this repo has already paid for once (a `-S`-only history check that read
 * clean while fifteen commit messages carried the names in the open).
 *
 * SO THE QUESTION IS INVERTED. Not "is this word Italian?", which needs a
 * dictionary we do not have and a list that rots, but "is this word ENGLISH?",
 * which is a 235,976-entry file already on the machine. `replaces` is in it,
 * `sostituisce` is not, and nothing has to be kept up to date for that to stay
 * true.
 *
 * A RATCHET, born green. The codebase already carries plenty of Italian names
 * (`motivoDaRisposta`, `chiaveErroreAuth`, `verdetto-turno-interrotto.ts`) and  allow-italian: the Italian names ARE the subject
 * rewriting them today is not this gate's job: `identifier-language-baseline.json`
 * records the count per file, and the count may only go DOWN. Adding the 86th
 * fails; removing one and rerunning `--update-baseline` locks in the gain.
 *
 * WHERE IT IS BLIND, said out loud rather than discovered later:
 *   - No dictionary on the machine (Linux CI often has none) ⇒ it cannot judge,
 *     so it says that and exits 0. It guards the machine where names are born,
 *     which is a developer's, not the runner that only replays them.
 *   - It reads DECLARATIONS, not every occurrence: a name is introduced once and
 *     that is the moment worth catching.
 *   - Invented English (`dedupe`, `stringify`) is not in a dictionary either.
 *     That is what `PROJECT_WORDS` is for, and adding to it is a deliberate act
 *     with a diff, not a silent pass.
 *
 *   bun run scripts/check-identifier-language.ts
 *   bun run scripts/check-identifier-language.ts --update-baseline
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BASELINE = join(ROOT, "scripts", "identifier-language-baseline.json");
const DICTS = ["/usr/share/dict/words", "/usr/dict/words", "/usr/share/dict/american-english"];

const ROOTS = ["client/src", "server", "shared", "scripts", "tests"];

/**
 * Words this project uses that no dictionary carries: coinages, abbreviations,
 * product nouns, and the vocabulary of the tools it is built on. Every entry is
 * a decision someone made in a diff, which is the point: the gate never widens
 * itself.
 */
export const PROJECT_WORDS = new Set([
  // A dictionary hole, not jargon. `/usr/share/dict/words` is a 1934 legacy and
  // does not carry words today's English uses without thinking: `entries`
  // (Object.entries) is as English as `entry`, which it does carry.
  "entries",

  // the product and its parts
  "topics", "topic", "openclaw", "armonia", "tauri", "kanban", "pane", "panes",
  "jcode", "unfollow",
  "worktree", "worktrees", "dispatcher", "dispatch", "board", "boards", "drawer",
  // tech and tooling
  "ts", "tsx", "js", "jsx", "api", "apis", "url", "urls", "uri", "uuid", "id", "ids",
  "http", "https", "ws", "wss", "sql", "sqlite", "db", "json", "jsonl", "yaml", "css",
  "html", "dom", "ui", "ux", "cli", "cwd", "env", "pid", "cpu", "ram", "os", "io",
  "utf", "ascii", "regex", "regexp", "async", "await", "iife", "impl", "init",
  "dict", "dicts", "payload", "payloads", "pixel", "pixels", "png", "jpeg", "byte", "bytes", "svg", "webp", "baseline", "baselines", "ratchet", "camelcase", "snake",
  "decl", "decls", "has", "was", "were", "does", "did", "seen", "known", "unknown",
  "config", "configs", "params", "param", "args", "arg", "ctx", "msg", "msgs",
  "req", "res", "err", "src", "dest", "dir", "dirs", "tmp", "temp", "num", "str",
  "bool", "int", "idx", "len", "min", "max", "avg", "prev", "curr", "cur", "el",
  "ref", "refs", "props", "prop", "attr", "attrs", "elem", "btn", "nav", "auth",
  "admin", "repo", "repos", "sha", "diff", "diffs", "commit", "commits", "git",
  "npm", "bun", "vite", "react", "playwright", "sse", "mcp", "pty", "ptys",
  // The browser pane's own nouns. `web2` is a 1934 dictionary: it does not
  // carry `download`, and the feature it names is a menu on screen.
  "download", "downloads",
  // words the language of software invented
  "dedupe", "dedup", "stringify", "serializable", "nullable", "iterable",
  "truthy", "falsy", "boolean", "enum", "enums", "middleware", "callback",
  "callbacks", "timestamp", "timestamps", "throttle", "debounce", "memoize",
  "hydrate", "rehydrate", "unmount", "remount", "prefetch", "refetch", "rerender",
  "teardown", "backoff", "changeset", "workspace", "workspaces", "toolbar",
  "tooltip", "dropdown", "popover", "checkbox", "placeholder", "viewport",
  "scrollbar", "sidebar", "keyframe", "keyframes", "flex", "grid", "svg", "png",
  "jpg", "webm", "gif", "pdf", "blob", "cors", "csrf", "xhr", "oauth", "jwt",
  "utc", "iso", "ms", "sec", "px", "rem",
  // Plain English that web2 (`/usr/share/dict/words`, the list this gate reads)
  // simply does not carry. It has "boxberry" and "boxcar" but not "box", so
  // `IDENTITY_GLYPH_BOX` and `ROW_ACTION_BOX` read as foreign. The word is not
  // the problem; the dictionary is.
  "box", "boxes",
  // Platforms and devices the code has to name to test them. Proper nouns: no
  // dictionary carries "iPhone", and the user-agent constants in
  // `push/environment.test.ts` cannot say which device they impersonate
  // without them.
  "ios", "ipad", "ipados", "iphone", "macos", "android",
  // Interface vocabulary and the shorthand this codebase reads in field names,
  // neither of which web2 carries. "avatar" is what the GitHub payload calls
  // the face (`avatarUrl`) and what the profile surface draws in four places;
  // "stats" is the name of the server field the profile renders
  // (`persona.stats`), so the component that draws it would otherwise have to
  // be named after something the payload does not say.
  "avatar", "avatars", "stats",
  // The board's own column names, and two more words web2 does not have.
  // "todo" is a STATUS this product stores and routes on (`status: "todo"`),
  // so a variable holding the card in that column cannot be called anything
  // else without lying about which column it came from. "inline" is the CSS
  // display value the topbar helper measures; "kpi" is what the dashboard
  // calls its own numbers, route included (`/api/dashboard/kpis`).
  "todo", "inline", "kpi", "kpis",
  // Names the Discord IPC layer cannot avoid. "darwin" is what
  // `process.platform` calls macOS and what `getconf DARWIN_USER_TEMP_DIR`
  // spells, so the helper that reads that directory has no other honest name;
  // "ack" is the acknowledgement frame the protocol sends back
  // (`onActivityAck`), a term of art older than this codebase; "app" is what
  // Discord itself calls the application whose name it returns (`appName`, from
  // `applicationName`), and web2 carries neither.
  "darwin", "ack", "acks", "app", "apps",
]);

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...ROOTS], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => !f.endsWith(".d.ts"));
}

/**
 * The identifiers a file DECLARES.
 *
 * Declarations only, and deliberately: a name is chosen once, and that is the
 * edit worth judging. Counting every mention would make one bad name look like
 * forty and turn the baseline into noise.
 */
export function declaredNames(src: string): { line: number; name: string }[] {
  const out: { line: number; name: string }[] = [];
  const decl = /\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Strings are not code. Without this, a test that passes `"const foo = 1"`
    // to this very function declares `foo`, and the gate reports a name that
    // exists only as an example inside quotes.
    const text = lines[i]!.replace(/(["'\`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
    // A declaration inside a comment is not a declaration. Cheap and good
    // enough: a full scanner buys precision the baseline already absorbs.
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;
    for (const m of text.matchAll(decl)) out.push({ line: i + 1, name: m[1]! });
  }
  return out;
}

/** camelCase, PascalCase, snake_case and SCREAMING_SNAKE into lowercase words. */
export function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3);
}

function loadDictionary(): Set<string> | null {
  for (const p of DICTS) {
    if (!existsSync(p)) continue;
    const set = new Set<string>();
    for (const w of readFileSync(p, "utf8").split("\n")) {
      const t = w.trim().toLowerCase();
      if (t) set.add(t);
    }
    if (set.size > 1000) return set;
  }
  return null;
}

/** A word is fine when English knows it, when the project declared it, or when
 *  it is the plural or the third person of something either of them knows. */
export function isKnown(word: string, dict: Set<string>): boolean {
  if (PROJECT_WORDS.has(word) || dict.has(word)) return true;
  for (const suffix of ["s", "es", "ed", "ing", "d", "r"]) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (stem.length >= 3 && (dict.has(stem) || PROJECT_WORDS.has(stem))) return true;
    }
  }
  return false;
}

/**
 * The baseline records the NAMES, not how many there are.
 *
 * A count answers "did the debt grow" and nothing else. Two things follow, and
 * both were visible the first time this gate went red: it could not say WHICH
 * name was new, so it listed the file's oldest offenders and sent you to
 * `MAX_FANOUT` when you had just written something else; and renaming one bad
 * name while adding another kept the total identical, which is a green on a
 * change that fixed nothing. Names cost a bigger file and buy an exact answer.
 */
type Baseline = { $schema: string; generated: string; files: Record<string, string[]> };

function readBaseline(): Record<string, string[]> {
  if (!existsSync(BASELINE)) return {};
  try { return (JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline).files ?? {}; }
  catch { return {}; }
}

/**
 * The scan runs only when this file IS the command.
 *
 * Without the guard, importing it to test `declaredNames` executed the whole
 * gate — and on the day the gate is red its `process.exit(1)` would kill the
 * test run that proves it works. A check whose own tests cannot run while it is
 * failing is a check you cannot fix.
 */
if (import.meta.main) {
  const dict = loadDictionary();
  if (!dict) {
    // Silence would read as approval. This machine cannot answer the question, so
    // it says which one it could not answer.
    console.log("[identifier-language] no English dictionary on this system (/usr/share/dict/words): cannot judge names, skipping.");
    process.exit(0);
  }

  const perFile = new Map<string, string[]>();
  const hits: { file: string; line: number; name: string; bad: string[] }[] = [];
  for (const file of trackedFiles()) {
    const names: string[] = [];
    for (const d of declaredNames(readFileSync(join(ROOT, file), "utf8"))) {
      const bad = words(d.name).filter((w) => !isKnown(w, dict));
      if (bad.length === 0) continue;
      names.push(d.name);
      hits.push({ file, line: d.line, name: d.name, bad });
    }
    if (names.length > 0) perFile.set(file, [...new Set(names)].sort());
  }

  if (process.argv.includes("--update-baseline")) {
    const files: Record<string, string[]> = {};
    for (const f of [...perFile.keys()].sort()) files[f] = perFile.get(f)!;
    const payload: Baseline = {
      $schema: "identifier-language-baseline-v1",
      generated: new Date().toISOString().slice(0, 10),
      files,
    };
    writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`[identifier-language] baseline scritta: ${Object.keys(files).length} file, ${[...perFile.values()].reduce((a, b) => a + b.length, 0)} nomi.`);
    process.exit(0);
  }

  const baseline = readBaseline();
  const offenders: { file: string; names: string[] }[] = [];
  for (const [file, names] of perFile) {
    const known = new Set(baseline[file] ?? []);
    const newNames = names.filter((n) => !known.has(n));
    if (newNames.length > 0) offenders.push({ file, names: newNames });
  }
  const gone: string[] = [];
  for (const [file, names] of Object.entries(baseline)) {
    const current = new Set(perFile.get(file) ?? []);
    const removed = names.filter((n) => !current.has(n));
    if (removed.length > 0) gone.push(`    ${file}: ${removed.length} in meno (${removed.slice(0, 4).join(", ")}${removed.length > 4 ? ", …" : ""})`);
  }

  if (offenders.length > 0) {
    console.error("[identifier-language] nomi nuovi che l'inglese non conosce:\n");
    for (const { file, names } of offenders) {
      for (const nome of names) {
        const h = hits.find((x) => x.file === file && x.name === nome);
        console.error(`  ${file}:${h?.line ?? "?"}  ${nome}  (${h?.bad.join(", ") ?? ""})`);
      }
    }
    console.error("\nLo standard e' l'inglese, names compresi. Rinomina, oppure aggiungi la");
    console.error("parola a PROJECT_WORDS in scripts/check-identifier-language.ts se e' un");
    console.error("termine di questo progetto. Non riscrivere la baseline per farlo tacere.");
    process.exit(1);
  }

  if (gone.length > 0) {
    console.log("[identifier-language] debito sceso, rilancia con --update-baseline per fissarlo:");
    for (const r of gone) console.log(r);
    process.exit(1);
  }

  console.log(`[identifier-language] OK - ${[...perFile.values()].reduce((a, b) => a + b.length, 0)} nomi non inglesi, tutti gia' nella baseline.`);

}
