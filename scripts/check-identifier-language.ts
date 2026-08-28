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
 *   - No dictionary on the machine ⇒ it cannot judge, and it now exits NON-ZERO
 *     instead of exiting 0 with a line nobody reads. It shipped the other way
 *     and the other way was measured: `ubuntu-latest` carries no
 *     `/usr/share/dict/words`, so from the day this gate was added until
 *     2026-08-27 every CI run printed "skipping" and passed. The gate sat in the
 *     static row looking like coverage and judged nothing, while the same gate
 *     went red on a developer's Mac: green where nobody looks, red where
 *     somebody does, which teaches people to ignore it. CI installs the word
 *     list now (`apt-get install -y wamerican`, about a second) and a machine
 *     without one is told what to install rather than waved through.
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
/**
 * `IDENTIFIER_LANGUAGE_DICT` pins the word list: it is how the tests drive the
 * two outcomes (a real list, a path that does not exist) without depending on
 * what the machine happens to carry, and how a machine with the dictionary
 * somewhere else says so instead of being told it is broken.
 */
const DICTS = process.env.IDENTIFIER_LANGUAGE_DICT
  ? [process.env.IDENTIFIER_LANGUAGE_DICT]
  : [
      // THE LIST TRAVELS WITH THE REPO, and that is the whole point. Measured on
      // 2026-08-27: with the system list, `ubuntu-latest` (wamerican) flagged
      // 1.144 names that macOS's list knows — `rect` among them — so the same
      // commit was green on a developer's machine and red in CI. A gate whose
      // verdict depends on which operating system read it is not a gate: it
      // measures the box, not the code. This file is macOS's `words` (the
      // public-domain Webster list, 235.976 entries), and it is now the ONLY
      // answer on every machine.
      join(import.meta.dir, "english-words.txt"),
      "/usr/share/dict/words",
      "/usr/dict/words",
      "/usr/share/dict/american-english",
    ];

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
  // (Object.entries) is as English as `entry`, which it does carry. Same for
  // `database`, and `svc` is this repository's own abbreviation for a service
  // instance - it appears in a dozen test files that predate this gate.
  "entries", "database", "svc",
  // Another dictionary hole of the same kind: `destructure` is how every
  // JavaScript programmer says it and no 1934 word list carries it. It appears
  // in `state-dir-single-door.test.ts`, where the whole point of the constant is
  // to name the SHAPE of a read the gate must catch.
  "destructure",
  // Same hole again: `exec` is how every programmer says "execute" (exec,
  // execSync, execve) and the 1934 list has none of them. It arrived with
  // `onToolExecStart`, the signal that tells a tool ANNOUNCED apart from a
  // tool RUNNING.
  "exec", "executing",

  // the product and its parts. "org" is the schema's own word, not an
  // abbreviation someone chose in passing: the tables are `orgs` and
  // `org_members`, the route is `/api/auth/orgs`, and the column every
  // visibility rule reads is `org_id`. A variable holding one of those rows
  // cannot be named after anything else without describing a different thing.
  "topics", "topic", "openclaw", "armonia", "tauri", "kanban", "pane", "panes",
  "org", "orgs",
  "jcode", "unfollow",
  "sharing", "inflight", "worktree", "worktrees", "dispatcher", "dispatch", "board", "boards", "drawer",
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
  "npm", "bun", "vite", "react", "playwright", "sse", "mcp", "pty", "ptys", "ipc",
  // The ISO 4217 code of the currency this repo prices in. Every model price
  // list, every cost probe and every spend cap is denominated in it, so the
  // three letters are the name of the thing, not an abbreviation of a word.
  "usd",
  // The browser pane's own nouns. `web2` is a 1934 dictionary: it does not
  // carry `download`, and the feature it names is a menu on screen.
  "download", "downloads",
  // words the language of software invented
  "dedupe", "dedup", "stringify", "serializable", "nullable", "iterable",
  "truthy", "falsy", "boolean", "enum", "enums", "middleware", "callback",
  "callbacks", "timestamp", "timestamps", "throttle", "debounce", "memoize",
  "hydrate", "rehydrate", "unmount", "remount", "prefetch", "refetch", "rerender",
  "resnapshot",
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
  // The vocabulary of shards and system probes. Not this project's jargon:
  // these are the names the tools give themselves. `lsof` and `pgid` are
  // printed by the operating system (`pgids` is just their plural), `xml` and
  // `junit` are the format and the schema of the report Playwright writes, and
  // `selftest` is what this repo has called the proof that a gate can go red
  // for as long as it has had gates. `newest` and `overlapping` are plain
  // English: web2 carries `new` and `overlap` but not those forms, and
  // renaming them would make the name worse, not more English.
  "lsof", "pgid", "pgids", "xml", "junit", "selftest", "newest", "overlapping",
  // `unix` is a proper noun, and the code has to name it to tell the two PATH
  // separators apart (`:` there, `;` on Windows) — web2 carries neither it nor
  // `darwin`, `macos` and `ios`, which are already up there for the same
  // reason. `sep` is this repo's abbreviation for a separator and reads like
  // `cfg`, `msg` and `ctx` above it: spelling it out would not make the name
  // more English, only longer.
  "unix", "sep",
  // `spawnable` is coined English of the kind this list already carries
  // (`dedupe`, `stringify`, `nullable`): "can be spawned", said of an agent the
  // machine could actually start. No dictionary has it and no rename improves
  // it — `startable` would be the same word with a worse root.
  "spawnable",
  // `held` is plain English — the past participle of "hold" — and web2 carries
  // `hold` but not it, exactly like `seen`, `known` and `was` a few lines up.
  // `rgb` and `hsl` are the colour spaces CSS itself names, siblings of `css`
  // and `svg` already on this list.
  "held", "rgb", "hsl",
  // The two words of shortcuts. `shortcut` is plain English that web2 does not
  // carry (it has `short` and `cut` separately), and `ctrl` is the name the
  // keyboard gives itself — it belongs next to `cmd` and `alt` for that reason.
  "shortcut", "shortcuts", "ctrl",
  // THE FIRST HARVEST OF THE GATE THAT ACTUALLY RAN (27/08/2026). CI had never
  // judged a name: no word list on `ubuntu-latest`, so the 184 names below were
  // only ever visible on a Mac. Most of them are not Italian at all, they are
  // English or shop talk that a 1934 word list cannot carry, so they belong
  // here. The Italian ones were renamed in the same commit, which is the only
  // honest split between these two piles.
  //
  // Shorthands this code reads everywhere, siblings of `cfg`, `ctx` and `msg`
  // already above: `deps` is the injected-dependencies bag of a dozen modules,
  // `cls` a CSS class name, `pos` a position, `pct` a percentage, `abs` is
  // `path.resolve`/`Math.abs`, `seq` a sequence number, `proc` a child process,
  // `cmd` a command line, `pkg` a package.json, `argv` the process arguments as
  // Node spells them, `ext` a file extension, `orig` the original value, `def` a
  // definition record, `conf` a config file, `lib` the Rust crate root
  // (`lib.rs`), `mic` the microphone, `info` the payload of an event.
  "deps", "cls", "pos", "pct", "abs", "seq", "proc", "cmd", "pkg", "argv",
  "ext", "orig", "def", "defs", "conf", "lib", "mic", "info", "cfg",
  // Words of the trade, printed by the tools themselves. `checkpoint` is this
  // product's own noun for a saved turn (the API route says so), `timeout` is
  // what every timer API calls it, `outfile` is the flag name of the test
  // reporter, `endpoint` is what the browser engines return, `runtime`,
  // `standalone`, `loopback`, `lookback`, `keyword`, `enqueue`, `stdio`, `rpc`,
  // `descriptor`, `rollup` and `classify` are all plain technical English that
  // web2 does not carry. `unsub` is the unsubscribe function every store
  // returns, `subtask` is a board word, `unlayered` is CSS that sits outside an
  // `@layer`, `pinnable` and `dedent` are coinages of the same family as
  // `spawnable` and `dedupe` above.
  "checkpoint", "checkpoints", "ckpt", "timeout", "timeouts", "outfile",
  "endpoint", "endpoints", "runtime", "standalone", "loopback", "lookback",
  "keyword", "keywords", "enqueue", "stdio", "rpc", "descriptor", "rollup",
  "classify", "unsub", "subtask", "subtasks", "unlayered", "pinnable", "dedent",
  "ops", "csv", "favicon",
  // Plain English in a form web2 skips: it has `body`, `drop`, `trim`,
  // `enclose` and `delivery` but not these. Renaming them would make the names
  // worse, not more English, which is the same reason `held`, `seen` and
  // `newest` are already on this list.
  "bodies", "dropped", "trimmed", "enclosing", "deliveries",
  // Proper nouns the code has to name to talk to them: an operating system, a
  // browser engine, a debugging protocol, two model vendors, and the acronym
  // the voice loop uses for voice activity detection.
  "linux", "webkit", "cdp", "groq", "kimi", "vad",
  // `mtime` is the name the filesystem gives that field — `stat` prints it,
  // Node exposes it as `mtimeMs`. Spelling it `modificationTime` in a helper
  // that reads `st.mtimeMs` would make the code harder to follow, not more
  // English.
  "mtime",
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
    // Exiting 0 here read as approval for as long as this gate existed in CI:
    // no word list on `ubuntu-latest`, one printed line, green. A gate that
    // cannot measure has to stop the build, not narrate its own absence.
    console.error(`[identifier-language] no English word list on this machine (looked in: ${DICTS.join(", ")}).`);
    console.error("Cannot judge names, so this gate FAILS instead of passing blind.");
    console.error("  Debian/Ubuntu: sudo apt-get install -y wamerican");
    console.error("  macOS: /usr/share/dict/words ships with the system");
    console.error("  elsewhere: point IDENTIFIER_LANGUAGE_DICT at a one-word-per-line English list");
    process.exit(2);
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
