/**
 * IL FILE IN CUI UN COMANDO MANDA IL PROPRIO STDOUT (chat-live-work).
 *
 * `run_command` scrive stdout e stderr del comando nel suo log
 * (`<processId>.log`, CMDRUN-03), e il pannello legge quello. Un comando che
 * manda il proprio stdout in un file lo toglie al log: il 07/10 Muse girava da
 * 58 minuti con `freeagent … > /tmp/fa-wallrunv2.log 2>&1`, e il pannello diceva
 * «Waiting for output...» con tutto il lavoro nel file. Qui si trova quel file,
 * perché il registro lo segua accanto al log.
 *
 * SOLO CIÒ CHE IL COMANDO NOMINA, letto come lo leggerebbe la shell ma senza
 * eseguire niente: la redirezione dello stdout (`> f`, `>> f`, `>| f`, `1> f`,
 * `&> f`, `&>> f`, `>& f`), e `tee f` quando l'uscita di tee va altrove. Con
 * l'uscita di tee nel log quelle righe ci sono già, e seguire il file le
 * scriverebbe due volte. Un percorso relativo si risolve sulla cartella del
 * comando, o su quella di un `cd` letterale che lo precede.
 *
 * NIENTE SI ESPANDE. Un percorso con `$VAR`, un backtick o un glob resta non
 * seguito e lo si dice (`unresolved`), così il pannello spiega il vuoto invece
 * di aspettare in silenzio. Il contenuto di `$( … )` e dei backtick non è lo
 * stdout del comando, il corpo di un heredoc non è un comando, e dentro
 * `[[ ]]` e `(( ))` il `>` è un confronto.
 *
 * `/dev/null`, `/dev/stdout` e il resto di `/dev` non sono file da seguire. Con
 * più file vince il primo che il comando nomina.
 */
import { isAbsolute, join, resolve } from "path";

export type StdoutTarget =
  | { kind: "file"; path: string; append: boolean }
  | { kind: "unresolved"; target: string; reason: UnresolvedReason };

/** `variable`: `$…`, backtick, `~user`. `pattern`: un glob. `cwd`: relativo dopo un `cd` che non si legge. */
export type UnresolvedReason = "variable" | "pattern" | "cwd";

interface Word { t: "word"; text: string; dynamic: UnresolvedReason | null; tilde: boolean }
interface Op { t: "op"; op: string }
interface Redir { t: "redir"; fd: number | null; op: string }
type Token = Word | Op | Redir;

const SPACE = /[ \t\r]/;
const WORD_END = /[ \t\r\n;&|()<>]/;
/** Ciò che sta davanti al nome del comando senza esserlo: una parola riservata, un'assegnazione. */
const KEYWORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "while", "until", "do", "time"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** L'indice dopo la parentesi che chiude quella aperta in `start`, saltando virgolette e annidamenti. */
function skipBalanced(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (c === "'") { const end = s.indexOf("'", i + 1); i = end < 0 ? s.length : end; continue; }
    if (c === "\"") { i = skipDoubleQuoted(s, i + 1) - 1; continue; }
    if (c === "`") { i = skipBacktick(s, i + 1) - 1; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return s.length;
}

/** L'indice dopo il `"` che chiude, partendo dal primo carattere dentro. */
function skipDoubleQuoted(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "$" && s[i + 1] === "(") { i = skipBalanced(s, i + 1, "(", ")") - 1; continue; }
    if (s[i] === "`") { i = skipBacktick(s, i + 1) - 1; continue; }
    if (s[i] === "\"") return i + 1;
  }
  return s.length;
}

function skipBacktick(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "`") return i + 1;
  }
  return s.length;
}

/**
 * Le parole e gli operatori del comando. Una parola tiene il suo valore senza
 * virgolette e se dipende da qualcosa che solo la shell conosce.
 */
function tokenize(s: string): Token[] {
  const out: Token[] = [];
  const heredocs: Array<{ delim: string; stripTabs: boolean }> = [];
  let expectHeredocDelim: { stripTabs: boolean } | null = null;
  let i = 0;

  const push = (tok: Token) => {
    if (tok.t === "word" && expectHeredocDelim) {
      heredocs.push({ delim: tok.text, stripTabs: expectHeredocDelim.stripTabs });
      expectHeredocDelim = null;
    }
    out.push(tok);
  };

  /** Il corpo degli heredoc aperti su questa riga: righe saltate fino al delimitatore. */
  const skipHeredocBodies = () => {
    for (const h of heredocs) {
      while (i < s.length) {
        const end = s.indexOf("\n", i);
        const line = s.slice(i, end < 0 ? s.length : end);
        i = end < 0 ? s.length : end + 1;
        if ((h.stripTabs ? line.replace(/^\t+/, "") : line) === h.delim) break;
      }
    }
    heredocs.length = 0;
  };

  while (i < s.length) {
    const c = s[i]!;
    if (SPACE.test(c)) { i++; continue; }
    if (c === "\\" && s[i + 1] === "\n") { i += 2; continue; }
    if (c === "\n") { out.push({ t: "op", op: "\n" }); i++; skipHeredocBodies(); continue; }
    if (c === "#") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === ";") { push({ t: "op", op: ";" }); i += s[i + 1] === ";" ? 2 : 1; continue; }
    if (c === "&") {
      if (s[i + 1] === "&") { push({ t: "op", op: "&&" }); i += 2; continue; }
      if (s[i + 1] === ">") { const app = s[i + 2] === ">"; push({ t: "redir", fd: null, op: app ? "&>>" : "&>" }); i += app ? 3 : 2; continue; }
      push({ t: "op", op: "&" }); i++; continue;
    }
    if (c === "|") {
      if (s[i + 1] === "|" || s[i + 1] === "&") { push({ t: "op", op: s[i + 1] === "|" ? "||" : "|&" }); i += 2; continue; }
      push({ t: "op", op: "|" }); i++; continue;
    }
    if (c === "(") {
      // `(( … ))` in testa a un comando è aritmetica, dove `>` confronta.
      const prev = out[out.length - 1];
      if (s[i + 1] === "(" && (!prev || prev.t === "op")) { i = skipBalanced(s, i, "(", ")"); continue; }
      push({ t: "op", op: "(" }); i++; continue;
    }
    if (c === ")") { push({ t: "op", op: ")" }); i++; continue; }
    if ((c === ">" || c === "<") && s[i + 1] === "(") {
      // Sostituzione di processo: un nome di file che esiste solo nella shell.
      i = skipBalanced(s, i + 1, "(", ")");
      push({ t: "word", text: "", dynamic: "variable", tilde: false });
      continue;
    }
    if (c === ">" || c === "<") { i = readRedirOp(s, i, null, push, (strip) => { expectHeredocDelim = { stripTabs: strip }; }); continue; }

    // Una parola. Un numero subito attaccato a `>`/`<` è il descrittore della redirezione.
    const fd = /^\d+(?=[<>])/.exec(s.slice(i, i + 12));
    if (fd) { i = readRedirOp(s, i + fd[0].length, Number(fd[0]), push, (strip) => { expectHeredocDelim = { stripTabs: strip }; }); continue; }
    let text = "";
    let dynamic: UnresolvedReason | null = null;
    const tilde = c === "~";
    while (i < s.length && !WORD_END.test(s[i]!)) {
      const ch = s[i]!;
      if (ch === "\\") { if (s[i + 1] !== "\n") text += s[i + 1] ?? ""; i += 2; continue; }
      if (ch === "'") { const end = s.indexOf("'", i + 1); text += s.slice(i + 1, end < 0 ? s.length : end); i = end < 0 ? s.length : end + 1; continue; }
      if (ch === "$" && s[i + 1] === "'") {
        let j = i + 2;
        for (; j < s.length && s[j] !== "'"; j++) if (s[j] === "\\") j++;
        text += s.slice(i + 2, j); i = j + 1; continue;
      }
      if (ch === "\"") {
        const end = skipDoubleQuoted(s, i + 1);
        const inner = s.slice(i + 1, Math.max(i + 1, end - 1));
        if (/[$`]/.test(inner.replace(/\\./g, ""))) dynamic ??= "variable";
        text += inner.replace(/\\(["\\$`])/g, "$1");
        i = end; continue;
      }
      if (ch === "$") {
        dynamic ??= "variable";
        if (s[i + 1] === "(") { i = skipBalanced(s, i + 1, "(", ")"); continue; }
        if (s[i + 1] === "{") { i = skipBalanced(s, i + 1, "{", "}"); continue; }
        text += ch; i++; continue;
      }
      if (ch === "`") { dynamic ??= "variable"; i = skipBacktick(s, i + 1); continue; }
      if (ch === "*" || ch === "?" || ch === "[") dynamic ??= "pattern";
      text += ch; i++;
    }
    push({ t: "word", text, dynamic, tilde });
  }
  return out;
}

/** Un operatore di redirezione da `i`; ritorna l'indice dopo. */
function readRedirOp(s: string, i: number, fd: number | null, push: (t: Token) => void, heredoc: (stripTabs: boolean) => void): number {
  const ops = [">>", ">|", ">&", "<<<", "<<-", "<<", "<&", "<>", ">", "<"];
  const op = ops.find((o) => s.startsWith(o, i)) ?? s[i]!;
  push({ t: "redir", fd, op });
  if (op === "<<" || op === "<<-") heredoc(op === "<<-");
  return i + op.length;
}

/** Va allo stdout del comando: un file, se la parola che segue lo è. */
function isStdoutRedirect(r: Redir, target: Word): boolean {
  if (r.op === "&>" || r.op === "&>>") return r.fd === null;
  if (r.fd !== null && r.fd !== 1) return false;
  if (r.op === ">" || r.op === ">>" || r.op === ">|") return true;
  // `>& file` manda stdout e stderr nel file; `>&2` e `>&-` sono un descrittore.
  return r.op === ">&" && !target.dynamic && !/^(\d+|-)$/.test(target.text);
}

/** Dove porta un `cd`, o null quando non lo si sa senza eseguirlo. */
function cdTarget(cwd: string | null, args: Word[], home: string): string | null {
  const arg = args.find((a) => !/^-[LPe@]+$/.test(a.text));
  if (!arg) return home;
  if (arg.dynamic || arg.text === "-") return null;
  const path = expandTilde(arg, home);
  if (path === null) return null;
  return isAbsolute(path) ? path : cwd ? resolve(cwd, path) : null;
}

/** `~` e `~/…` sulla casa; `~utente` è di qualcun altro e resta null. */
function expandTilde(w: Word, home: string): string | null {
  if (!w.tilde) return w.text;
  if (w.text === "~") return home;
  if (w.text.startsWith("~/")) return join(home, w.text.slice(2));
  return null;
}

/**
 * Il file in cui `command`, lanciato in `cwd`, manda il proprio stdout; null
 * quando lo stdout arriva al log (o va in `/dev`).
 */
export function stdoutTargetOf(command: string, opts: { cwd: string; home: string }): StdoutTarget | null {
  const tokens = tokenize(command);
  let cwd: string | null = opts.cwd;
  const subshells: Array<string | null> = [];
  const found: StdoutTarget[] = [];
  let words: Word[] = [];
  let outs: Array<{ r: Redir; target: Word }> = [];
  let inTest = false;

  const resolveTarget = (w: Word, append: boolean, dir: string | null): StdoutTarget | null => {
    const raw = w.text;
    if (w.dynamic) return { kind: "unresolved", target: raw || "?", reason: w.dynamic };
    const path = expandTilde(w, opts.home);
    if (path === null) return { kind: "unresolved", target: raw, reason: "variable" };
    if (!path) return null;
    if (isAbsolute(path)) return path === "/dev" || path.startsWith("/dev/") ? null : { kind: "file", path, append };
    return dir ? { kind: "file", path: resolve(dir, path), append } : { kind: "unresolved", target: raw, reason: "cwd" };
  };

  const endCommand = () => {
    const name = words[0]?.dynamic ? "" : words[0]?.text;
    const stdoutRedirected = outs.some((o) => isStdoutRedirect(o.r, o.target));
    if (name === "tee" && stdoutRedirected) {
      const append = words.slice(1).some((w) => /^-[a-z]*a/.test(w.text) || w.text === "--append");
      for (const w of words.slice(1)) if (!w.text.startsWith("-") || w.dynamic) { const t = resolveTarget(w, append, cwd); if (t) found.push(t); }
    }
    for (const o of outs) {
      if (!isStdoutRedirect(o.r, o.target)) continue;
      const t = resolveTarget(o.target, o.r.op === ">>" || o.r.op === "&>>", cwd);
      if (t) found.push(t);
    }
    if (name === "cd") cwd = cdTarget(cwd, words.slice(1), opts.home);
    words = [];
    outs = [];
  };

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]!;
    if (inTest) {
      if (tok.t === "word" && tok.text === "]]") inTest = false;
      continue;
    }
    if (tok.t === "word") {
      if (words.length === 0 && !tok.dynamic) {
        if (tok.text === "[[") { inTest = true; continue; }
        if (KEYWORDS.has(tok.text) || ASSIGNMENT.test(tok.text)) continue;
      }
      words.push(tok);
      continue;
    }
    if (tok.t === "redir") {
      const next = tokens[k + 1];
      if (next?.t !== "word") continue;
      k++;
      if (tok.op.startsWith("<")) continue;
      outs.push({ r: tok, target: next });
      continue;
    }
    endCommand();
    if (tok.op === "(") subshells.push(cwd);
    else if (tok.op === ")" && subshells.length) cwd = subshells.pop()!;
  }
  endCommand();
  return found.find((t) => t.kind === "file") ?? found[0] ?? null;
}
