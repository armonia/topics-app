#!/usr/bin/env bun
/**
 * scripts/check-ui-language.ts - fail the build when Italian reaches a text a
 * person reads in the app, or an error payload the client renders verbatim.
 *
 * THE RULE. The product ships in English: code, identifiers, scripts and the
 * strings a user sees. The app still has a real translation layer
 * (`client/src/lib/i18n.ts`, `it` + `en`), and that layer is where Italian is
 * allowed to live: it is DATA there, keyed and switchable. What is not allowed
 * is Italian hard-coded into a component or into a server payload, because that
 * string can never be switched, never be reviewed by a translator, and reaches
 * an English-speaking user as-is.
 *
 * THIS IS A RATCHET, NOT AN ABSOLUTE BAR. On the day it was written the tree
 * still held hundreds of hard-coded Italian strings across surfaces owned by
 * several people at once. An absolute gate would have been red on arrival, and
 * a gate that is born red is switched off within a week instead of obeyed. So
 * `scripts/ui-language-baseline.json` freezes today's offenders per file, and
 * the gate fails when a NEW file gains a hit or a listed file gains MORE. A
 * file that gets cured never fails: the gate prints a line asking for
 * `--update-baseline`, so the debt only ever moves down.
 *
 * WHAT IS IN SCOPE, and what deliberately is not:
 *  · IN  -> JSX text nodes in tracked `.tsx` under `client/src`, plus the four
 *    attributes a person actually reads: `title`, `aria-label`, `placeholder`,
 *    `alt`.
 *  · IN  -> `error:` / `detail:` / `reason:` / `message:` string values in the
 *    tracked modules under `server/routes`. Those are the payloads the client
 *    prints straight into a toast or an inline error.
 *  · OUT -> COMMENTS, always and on purpose. This repo's comments are Italian
 *    by design and there are thousands of them; policing prose in comments is a
 *    separate and much larger decision, and a gate that flagged them would be
 *    turned off within a week (the same reasoning `scripts/check-emdash.ts` and
 *    `scripts/check-script-naming.test.ts` already write down).
 *  · OUT -> test and spec files. Their strings are assertions, not copy, and
 *    several of them anchor Italian text on purpose.
 *  · OUT -> `client/src/lib/i18n.ts`. It is a `.ts`, so it is not scanned at
 *    all: the `it` dictionary IS the Italian, and flagging it would be flagging
 *    the feature.
 *
 * HOW THE MATCH WORKS. Whole tokens against a stopword list, never substrings:
 * "alter" must not trip on "alt", "content" must not trip on "con", and a
 * proper noun must not trip at all. Two signals count as Italian: a token that
 * is in the list, or a grave-accented vowel, which English UI copy does not
 * use. Words that exist in BOTH languages are deliberately absent from the list
 * ("pane", "fine", "state", "come", "solo", "per", "media", "dove", "alto",
 * "ore", "usa"): each of them is a real English word this repo already uses,
 * and one false positive costs more trust than ten missed strings.
 *
 * ESCAPE HATCH, for the case where the Italian IS the data: a fixture, a
 * parser, a label the server and the client compare BY VALUE. Suffix the line
 * with `// allow-italian: <why>`. The marker is honoured on the offending line
 * and on the line the literal opens on, so a multi-line template only needs it
 * once.
 *
 * NO AST, on purpose: the root has no `typescript` installed, and a lexer that
 * knows comments, strings, template literals and regex literals is enough to
 * tell a JSX text node from code in this codebase.
 *
 * EXIT CODES
 *   0  within the baseline (or, in absolute mode, no hit at all)
 *   1  over: a new file, a file that grew, or in absolute mode any hit
 *   2  the measurement could not be taken (no git, unreadable baseline)
 *
 * USAGE
 *   bun run check:ui-language                       ratchet against the baseline
 *   bun run check:ui-language --absolute            every hit, baseline ignored
 *   bun run check:ui-language --json                machine readable
 *   bun run check:ui-language --update-baseline     rewrite the baseline
 *   bun run scripts/check-ui-language.ts a.tsx b.ts scan those files, absolute
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const BASELINE_PATH = resolve(ROOT, "scripts/ui-language-baseline.json");

/** The marker that turns one line into data instead of copy. */
const ALLOW = "allow-italian:";

/**
 * The four attributes a person reads. `value` and `name` are out: they are
 * almost always identifiers, and `children` is covered by the JSX text pass.
 */
const READABLE_ATTRS = ["aria-label", "placeholder", "title", "alt"] as const;

/** The payload keys a client renders verbatim into a toast or an inline error. */
const PAYLOAD_KEYS = ["error", "detail", "reason", "message"] as const;

/**
 * Grave accents plus the acute `e`. English UI copy does not carry them, and
 * every Italian sentence of any length carries at least one ("e'", "piu'",
 * "gia'", "perche'", "cosi'" are all written with the accent in this repo).
 */
const ACCENTS = /[àèéìòùÀÈÉÌÒÙ]/;

/**
 * Italian tokens that are NOT English words. Vetted one by one: a word that
 * exists in both languages is worth more as a miss than as a false positive,
 * because the first costs one untranslated string and the second costs the
 * gate's credibility. The obvious absences are deliberate and listed in this
 * file's header.
 */
const STOPWORDS = new Set<string>([
  // Articles, prepositions, determiners.
  "gli", "del", "dello", "della", "dei", "degli", "delle",
  "dal", "dallo", "dalla", "dai", "dagli", "dalle",
  "nel", "nello", "nella", "nei", "negli", "nelle",
  "sul", "sullo", "sulla", "sui", "sugli", "sulle",
  // "col" and "coi" are out: the editor's status bar reads "Ln 12, Col 4".
  "allo", "alla", "agli", "alle", "una",
  "questo", "questa", "questi", "queste",
  "quel", "quello", "quella", "quelli", "quelle",
  "suo", "sua", "suoi", "tuo", "tua", "loro",
  // Conjunctions and adverbs.
  "che", "cui", "non", "anche", "ancora", "quindi", "perche", "poiche",
  "invece", "mentre", "quando", "quanto", "quanti", "quante", "quale", "quali",
  "ogni", "tutti", "tutte", "tutto", "tutta",
  "nessun", "nessuno", "nessuna", "niente", "nulla",
  "senza", "sempre", "adesso", "subito", "soltanto", "appena", "oppure",
  "altrimenti", "inoltre", "sopra", "sotto", "dentro", "fuori", "dopo",
  "troppo", "molto", "poco", "meno",
  "altro", "altra", "altri", "altre",
  // Verbs, in the forms UI copy actually uses.
  "sono", "siamo", "essere", "stato", "stata", "stati", "stanno",
  "avere", "hanno", "abbiamo",
  "fare", "fatto", "fatta", "fatti", "fatte",
  "puo", "possono", "puoi", "possibile", "impossibile",
  "deve", "devi", "devono", "serve", "servono",
  "manca", "mancano", "mancante", "mancanti",
  "viene", "vengono", "verra", "sara", "saranno", "sarebbe",
  "apri", "apre", "aprire", "apertura",
  "chiudi", "chiude", "chiudere", "chiusa", "chiuso", "chiusi", "chiuse", "chiusura",
  "mostra", "mostrare", "nascondi", "nascosto", "nascosta",
  "salva", "salvato", "salvata", "salvare", "salvataggio",
  "elimina", "eliminato", "eliminare", "rimuovi", "rimuovere", "rimosso", "rimossa",
  "cerca", "cercare", "cercando",
  "trova", "trovato", "trovata", "trovati", "trovate", "trovare",
  "aggiungi", "aggiunta", "aggiunto", "aggiungere",
  "crea", "creare", "creato", "creata", "creazione",
  "modifica", "modifiche", "modificare", "modificato", "modificata",
  "rinomina", "rinominare",
  "copia", "copiare", "copiato", "incolla", "incollare",
  "annulla", "annullare", "annullato", "conferma", "confermare",
  "riprova", "riprovare",
  "carica", "caricare", "caricamento", "caricato", "scarica", "scaricare",
  "scegli", "scegliere", "seleziona", "selezionato", "selezionata", "selezione",
  "avvia", "avviare", "avviato", "avvio", "riavvia", "riavviare", "riavvio",
  "ferma", "fermare", "fermato", "arresto",
  "torna", "tornare", "vai", "premi", "clicca", "cliccare",
  "trascina", "trascinare",
  "esegui", "eseguire", "eseguito", "eseguita",
  "invia", "inviare", "inviato", "inviata", "ricevi", "ricevuto",
  "attendi", "attesa", "aspetta", "aspettare",
  "utilizza", "utilizzare", "usare", "usato", "usata",
  "scrivi", "scrivere", "leggi", "leggere", "letto", "letta",
  "sposta", "spostare", "spostato", "spostata",
  "ripristina", "ripristinare", "ripristino",
  "aggiorna", "aggiornare", "aggiornamento", "aggiornamenti", "aggiornato", "aggiornata",
  "installa", "installare", "installato",
  "abilita", "disabilita", "attiva", "disattiva", "attivo", "attivi", "attive",
  "spento", "spenta", "acceso", "accesa",
  "collega", "collegato", "collegamento", "connesso", "connessa", "disconnesso",
  "genera", "generato", "generata",
  "verifica", "verificare", "controlla", "controllare", "controllo",
  "termina", "terminato", "interrompi", "interrotto", "interrotta",
  "fallito", "fallita", "fallimento", "riuscito", "completato", "completata",
  // Nouns and adjectives.
  "errore", "errori", "messaggio", "messaggi", "avviso", "avvisi",
  "cartella", "cartelle", "percorso", "percorsi",
  "progetto", "progetti", "sessione", "sessioni", "finestra", "finestre",
  "impostazioni", "impostazione", "opzioni", "opzione",
  "riga", "righe", "colonna", "pagina", "pagine",
  "ricerca", "elenco", "scheda", "schede", "pulsante", "pulsanti", "tasto", "tasti",
  "nome", "nomi", "utente", "utenti", "chiave", "chiavi", "valore", "valori",
  "ramo", "rami", "anteprima", "richiesta", "richieste", "risposta", "risposte",
  "consegna", "consegne", "commento", "commenti",
  "terminale", "terminali", "lingua", "lingue", "aiuto", "guida",
  "dimensione", "dimensioni", "larghezza", "altezza",
  "giorno", "giorni", "settimana", "mese", "mesi", "anno", "anni",
  "minuto", "minuti", "secondo", "secondi", "numero", "numeri",
  "vuoto", "vuota", "pieno", "piena",
  "nuovo", "nuova", "nuovi", "nuove", "vecchio", "vecchia",
  "ultimo", "ultima", "primo", "precedente", "successivo", "successiva",
  "sinistra", "destra", "piccolo", "piccola",
  "disponibile", "disponibili", "sconosciuto", "sconosciuta",
  "predefinito", "predefinita", "consigliato", "recente", "recenti",
  "esempio", "esempi", "lavoro", "corso", "prova",
  "tentativo", "tentativi", "dettaglio", "dettagli",
  "livello", "livelli", "passaggio", "passaggi",
]);

interface Hit {
  file: string;
  line: number;
  /** `jsx` | `attr:<name>` | `payload:<key>`, so a report says WHY it looked. */
  where: string;
  words: string[];
  text: string;
}

interface Literal {
  /** Offsets of the literal's CONTENT in the source, delimiters excluded. */
  start: number;
  end: number;
}

interface Lexed {
  /**
   * The source with comments AND string contents blanked to spaces, byte
   * positions preserved. Every structural scan (attributes, braces, JSX
   * angles) runs on this, so a `>` or a `{` inside a string cannot fake
   * structure and a `title=` inside a string cannot fake an attribute.
   */
  codeOnly: string;
  literals: Literal[];
}

/** After these, a `/` opens a regex literal instead of dividing. */
const REGEX_CAN_FOLLOW = new Set([
  "", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";",
  "+", "-", "*", "%", "~", "^", "<", ">", "\n",
]);

/**
 * One pass over the file. Templates are recorded as one literal per raw chunk
 * between `${...}` holes, which is exactly what the token check wants: an
 * interpolated value is code and must not be read as prose.
 */
function lex(src: string): Lexed {
  const chars = src.split("");
  const literals: Literal[] = [];
  // One entry per template literal we are currently inside via a `${` hole.
  const templates: { braces: number }[] = [];
  let i = 0;
  let prev = "";

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < chars.length; k++) {
      if (chars[k] !== "\n") chars[k] = " ";
    }
  };

  /** Reads raw template text from `pos` up to the closing backtick or a hole. */
  const readTemplateChunk = (pos: number): void => {
    let j = pos;
    while (j < src.length) {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === "`") {
        literals.push({ start: pos, end: j });
        blank(pos, j);
        i = j + 1;
        prev = "`";
        return;
      }
      if (src[j] === "$" && src[j + 1] === "{") {
        literals.push({ start: pos, end: j });
        blank(pos, j);
        templates.push({ braces: 0 });
        i = j + 2;
        prev = "{";
        return;
      }
      j++;
    }
    literals.push({ start: pos, end: j });
    blank(pos, j);
    i = j;
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (c === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close === -1 ? src.length : close + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (c === "/" && REGEX_CAN_FOLLOW.has(prev)) {
      // A regex body can hold backticks and angle brackets. Left alive it opens
      // a phantom template and swallows the rest of the file, which is the
      // false positive `check-emdash.ts` already had to fix once.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        blank(i + 1, j - 1);
        i = j;
        prev = "/";
        continue;
      }
      // Never closed on this line: it was a division after all.
    }

    // An apostrophe INSIDE a word is not a quote: `c'è`, `l'agente`, `don't`.
    // Read as a string opener it blanks the rest of the line, and with it the
    // `<` that closes the JSX text node, so the whole sentence goes unseen.
    // The test is the character immediately before, with no space: JavaScript
    // never puts a string literal straight after an identifier character, so
    // `case 'a'` and `return 'x'` (which have one) still open normally.
    if (c === "'" && /[A-Za-z0-9À-ÿ]/.test(src[i - 1] ?? "")) {
      prev = c;
      i++;
      continue;
    }

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        j++;
      }
      literals.push({ start: i + 1, end: j });
      blank(i + 1, j);
      i = Math.min(j + 1, src.length);
      prev = c;
      continue;
    }

    if (c === "`") {
      readTemplateChunk(i + 1);
      continue;
    }

    if (c === "{" && templates.length > 0) {
      templates[templates.length - 1]!.braces++;
      i++;
      prev = "{";
      continue;
    }

    if (c === "}" && templates.length > 0) {
      const top = templates[templates.length - 1]!;
      if (top.braces === 0) {
        templates.pop();
        readTemplateChunk(i + 1);
        continue;
      }
      top.braces--;
      i++;
      prev = "}";
      continue;
    }

    if (c !== undefined && c.trim() !== "") prev = c;
    i++;
  }

  return { codeOnly: chars.join(""), literals };
}

/** Offsets where each line starts, so a hit can name a line you can open. */
function lineIndex(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * The Italian words in a piece of text, empty when it reads as English.
 *
 * The hyphen is part of a token, not a separator, and that is the whole of the
 * "whole token" rule in practice: English writes "non-empty", "non-null",
 * "non-zero" all over the server's validation errors, and splitting on the
 * hyphen would hand back "non", the commonest Italian word there is. Italian
 * copy in this repo does not hyphenate, so nothing real is lost.
 */
function italianWords(text: string): string[] {
  const found = new Set<string>();
  if (ACCENTS.test(text)) found.add("<accent>");
  for (const raw of text.toLowerCase().split(/[^a-zàèéìòù-]+/)) {
    const token = raw.replace(/^-+|-+$/g, "");
    if (token.length >= 3 && STOPWORDS.has(token)) found.add(token);
  }
  return [...found];
}

/** Removes balanced `{...}` regions, keeping byte positions. */
function stripBraces(chunk: string): string {
  const out = chunk.split("");
  let depth = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "{") {
      depth++;
      out[i] = " ";
      continue;
    }
    if (out[i] === "}") {
      if (depth > 0) depth--;
      out[i] = " ";
      continue;
    }
    if (depth > 0 && out[i] !== "\n") out[i] = " ";
  }
  return out.join("");
}

/** True when this line, or the line the literal opens on, waives the rule. */
function waived(rawLines: string[], hitLine: number, openLine: number): boolean {
  return (
    (rawLines[hitLine - 1] ?? "").includes(ALLOW) ||
    (rawLines[openLine - 1] ?? "").includes(ALLOW)
  );
}

/** The literals whose content starts inside `[from, to)`, in source order. */
function literalsIn(literals: Literal[], from: number, to: number): Literal[] {
  return literals.filter((l) => l.start >= from && l.start < to);
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

/**
 * Punctuation that prose does not use and code cannot avoid. A span between a
 * `>` and a `<` is not always a JSX text node: `a > b ... <` leaves a slice of
 * real code in the middle, and an Italian IDENTIFIER in it (there are still a
 * few) would be reported as a text a user reads, which it is not. That is a
 * different problem with a different fix, so the span is dropped here.
 */
const CODE_RESIDUE = /[;=]|&&|\|\|/;

/**
 * JSX text nodes: everything between a `>` and the next `<` in the structural
 * view, minus the `{...}` holes.
 */
function scanJsxText(file: string, src: string, lexed: Lexed, starts: number[], rawLines: string[]): Hit[] {
  const hits: Hit[] = [];
  const code = lexed.codeOnly;
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== "<") continue;
    const open = code.lastIndexOf(">", i - 1);
    if (open === -1) continue;
    const chunk = stripBraces(code.slice(open + 1, i));
    if (CODE_RESIDUE.test(chunk)) continue;
    const words = italianWords(chunk);
    if (words.length === 0) continue;
    const line = lineOf(starts, open + 1 + Math.max(0, chunk.search(/\S/)));
    if (waived(rawLines, line, lineOf(starts, open))) continue;
    hits.push({ file, line, where: "jsx", words, text: excerpt(chunk) });
  }
  return hits;
}

/** The four attributes, whether written as a bare literal or inside braces. */
function scanAttributes(file: string, src: string, lexed: Lexed, starts: number[], rawLines: string[]): Hit[] {
  const hits: Hit[] = [];
  const code = lexed.codeOnly;
  const re = new RegExp(`(?<![\\w$.-])(${READABLE_ATTRS.join("|")})\\s*=\\s*`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const attr = m[1]!;
    const at = m.index + m[0].length;
    const opener = code[at];
    let scoped: Literal[] = [];
    if (opener === '"' || opener === "'" || opener === "`") {
      scoped = literalsIn(lexed.literals, at + 1, at + 2);
    } else if (opener === "{") {
      let depth = 0;
      let end = at;
      for (let k = at; k < code.length; k++) {
        if (code[k] === "{") depth++;
        else if (code[k] === "}") {
          depth--;
          if (depth === 0) {
            end = k;
            break;
          }
        }
      }
      scoped = literalsIn(lexed.literals, at + 1, end);
    }
    for (const lit of scoped) {
      const text = src.slice(lit.start, lit.end);
      const words = italianWords(text);
      if (words.length === 0) continue;
      const line = lineOf(starts, lit.start);
      if (waived(rawLines, line, lineOf(starts, m.index))) continue;
      hits.push({ file, line, where: `attr:${attr}`, words, text: excerpt(text) });
    }
  }
  return hits;
}

/** `error:` / `detail:` / `reason:` / `message:` values, the client's copy. */
function scanPayloads(file: string, src: string, lexed: Lexed, starts: number[], rawLines: string[]): Hit[] {
  const hits: Hit[] = [];
  const code = lexed.codeOnly;
  const re = new RegExp(`(?<![\\w$.])(${PAYLOAD_KEYS.join("|")})\\s*:\\s*`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const key = m[1]!;
    const at = m.index + m[0].length;
    if (code[at] !== '"' && code[at] !== "'" && code[at] !== "`") continue;
    // A template with holes is several literals: check every raw chunk of it.
    const scoped = literalsIn(lexed.literals, at + 1, at + 2);
    const first = scoped[0];
    if (!first) continue;
    const chunks = code[at] === "`" ? templateChunks(lexed.literals, first) : scoped;
    for (const lit of chunks) {
      const text = src.slice(lit.start, lit.end);
      const words = italianWords(text);
      if (words.length === 0) continue;
      const line = lineOf(starts, lit.start);
      if (waived(rawLines, line, lineOf(starts, m.index))) continue;
      hits.push({ file, line, where: `payload:${key}`, words, text: excerpt(text) });
    }
  }
  return hits;
}

/**
 * Every raw chunk of the template that starts at `first`. The lexer emits them
 * consecutively, and a chunk that follows a hole starts one byte after the `}`
 * that closed it, so contiguity in the literal list is the reliable link.
 */
function templateChunks(literals: Literal[], first: Literal): Literal[] {
  const out: Literal[] = [];
  let idx = literals.indexOf(first);
  if (idx === -1) return [first];
  out.push(first);
  for (let k = idx + 1; k < literals.length; k++) {
    const prevEnd = literals[k - 1]!.end;
    // The hole between two chunks is `${...}`: at least four bytes.
    if (literals[k]!.start <= prevEnd || literals[k]!.start - prevEnd > 400) break;
    out.push(literals[k]!);
  }
  return out;
}

function scanFile(file: string): Hit[] {
  const abs = resolve(ROOT, file);
  if (!existsSync(abs)) {
    console.warn(`[check-ui-language] missing: ${file} (skipped)`);
    return [];
  }
  const src = readFileSync(abs, "utf-8");
  const lexed = lex(src);
  const starts = lineIndex(src);
  const rawLines = src.split(/\r?\n/);
  const hits: Hit[] = [];
  if (file.endsWith(".tsx")) {
    hits.push(...scanJsxText(file, src, lexed, starts, rawLines));
    hits.push(...scanAttributes(file, src, lexed, starts, rawLines));
  }
  hits.push(...scanPayloads(file, src, lexed, starts, rawLines));
  return hits.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// Which files
// ---------------------------------------------------------------------------

const IS_TEST = /\.(test|spec|e2e)\.[cm]?tsx?$/;

function trackedFiles(): string[] {
  const git = spawnSync("git", ["ls-files", "-z", "client/src", "server/routes"], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (git.status !== 0) {
    console.error("[check-ui-language] cannot list tracked files: is this a git checkout?");
    process.exit(2);
  }
  return git.stdout
    .split("\0")
    .filter(Boolean)
    .filter((p) => !IS_TEST.test(p))
    .filter((p) => (p.startsWith("client/src/") ? p.endsWith(".tsx") : p.endsWith(".ts")));
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

interface Baseline {
  $schema: string;
  _comment: string[];
  updated: string;
  /** path -> number of hits on the day recorded. Absent means "must stay at 0". */
  files: Record<string, number>;
}

const BASELINE_COMMENT = [
  "Frozen debt for scripts/check-ui-language.ts. One entry per file that still",
  "holds hard-coded Italian in a text a person reads, with how many hits it had",
  "the day it was recorded.",
  "",
  "THE GATE IS A RATCHET. A file that is not listed here must have ZERO hits; a",
  "file that is listed must not gain more. Curing a file never fails the gate:",
  "it prints a line asking for `--update-baseline`, and the number here only",
  "ever goes down.",
  "",
  "The numbers are a SNAPSHOT of the day they were taken, not an allowance:",
  "several surfaces were mid-translation when this was first frozen. Re-run",
  "`--update-baseline` after a sweep so the debt on record is the real one.",
  "",
  "LOWERING A NUMBER is free and expected. RAISING one is not: translate the",
  "string, or if the Italian IS the data (a fixture, a parser, a label compared",
  "by value across the client/server boundary) mark that line with",
  "`// allow-italian: <why>` instead of buying the exemption here.",
];

function readBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const files = (parsed as { files?: unknown }).files;
    if (files === null || typeof files !== "object") return null;
    return parsed as Baseline;
  } catch (err) {
    console.error(`[check-ui-language] baseline unreadable: ${String(err)}`);
    process.exit(2);
  }
  return null;
}

function writeBaseline(counts: Map<string, number>): void {
  const files: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) files[key] = counts.get(key)!;
  const body: Baseline = {
    $schema: "ui-language-baseline-v1",
    _comment: BASELINE_COMMENT,
    updated: new Date().toISOString().slice(0, 10),
    files,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
  console.log(
    `[check-ui-language] baseline written: ${Object.keys(files).length} file(s), ` +
      `${[...counts.values()].reduce((a, b) => a + b, 0)} hit(s).`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const update = argv.includes("--update-baseline");
  const explicit = argv.filter((a) => !a.startsWith("--"));
  const absolute = argv.includes("--absolute") || explicit.length > 0;

  const files = explicit.length > 0 ? explicit.map((p) => relative(ROOT, resolve(p))) : trackedFiles();

  const hits: Hit[] = [];
  for (const file of files) hits.push(...scanFile(file));

  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.file, (counts.get(h.file) ?? 0) + 1);

  if (update) {
    if (absolute) {
      console.error("[check-ui-language] --update-baseline needs the full tracked scan, not a file list.");
      process.exit(2);
    }
    writeBaseline(counts);
    process.exit(0);
  }

  const byFile = new Map<string, Hit[]>();
  for (const h of hits) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }

  const report = (list: Hit[]): void => {
    const grouped = new Map<string, Hit[]>();
    for (const h of list) {
      const acc = grouped.get(h.file) ?? [];
      acc.push(h);
      grouped.set(h.file, acc);
    }
    for (const [file, rows] of grouped) {
      console.error(`\n  ${file}`);
      for (const r of rows) console.error(`    :${r.line}  [${r.where}] ${r.words.join(" ")} | ${r.text}`);
    }
  };

  if (absolute) {
    if (json) console.log(JSON.stringify({ mode: "absolute", files: files.length, hits }, null, 2));
    if (hits.length === 0) {
      if (!json) console.log(`[check-ui-language] OK (absolute): ${files.length} file(s), no Italian in app text.`);
      process.exit(0);
    }
    if (!json) {
      console.error(
        `[check-ui-language] FAIL (absolute): ${hits.length} Italian string(s) across ${byFile.size} file(s).`,
      );
      report(hits);
      console.error(`\nTranslate them, or mark the line with '// ${ALLOW} <why>' when the Italian IS the data.`);
    }
    process.exit(1);
  }

  const baseline = readBaseline();
  if (!baseline) {
    console.error(
      `[check-ui-language] no baseline at ${relative(ROOT, BASELINE_PATH)}. ` +
        `Run 'bun run check:ui-language --update-baseline' once to freeze today's debt.`,
    );
    process.exit(2);
  }

  const newFiles: string[] = [];
  const grown: { file: string; was: number; now: number }[] = [];
  const cured: { file: string; was: number; now: number }[] = [];

  for (const [file, count] of counts) {
    const was = baseline.files[file];
    if (was === undefined) newFiles.push(file);
    else if (count > was) grown.push({ file, was, now: count });
    else if (count < was) cured.push({ file, was, now: count });
  }
  for (const [file, was] of Object.entries(baseline.files)) {
    if (!counts.has(file)) cured.push({ file, was, now: 0 });
  }

  if (json) {
    console.log(JSON.stringify({ mode: "ratchet", files: files.length, newFiles, grown, cured, hits }, null, 2));
  }

  const failing = newFiles.length > 0 || grown.length > 0;
  if (!failing) {
    if (!json) {
      console.log(
        `[check-ui-language] OK: ${files.length} file(s) scanned, ` +
          `${hits.length} known hit(s) in ${counts.size} baselined file(s).`,
      );
      if (cured.length > 0) {
        console.log(
          `[check-ui-language] ${cured.length} file(s) improved. ` +
            `Lock it in with 'bun run check:ui-language --update-baseline'.`,
        );
        for (const c of cured.slice(0, 20)) console.log(`    ${c.file}: ${c.was} -> ${c.now}`);
      }
    }
    process.exit(0);
  }

  if (!json) {
    console.error("[check-ui-language] FAIL: Italian reached a text a person reads.");
    if (newFiles.length > 0) {
      console.error(`\n${newFiles.length} file(s) NOT in the baseline gained a hit:`);
      report(hits.filter((h) => newFiles.includes(h.file)));
    }
    if (grown.length > 0) {
      console.error(`\n${grown.length} baselined file(s) gained MORE:`);
      for (const g of grown) console.error(`  ${g.file}: ${g.was} -> ${g.now}`);
      report(hits.filter((h) => grown.some((g) => g.file === h.file)));
    }
    console.error(
      `\nThe app ships in English. Put the string through 'client/src/lib/i18n.ts'` +
        `\nor write it in English. If the Italian IS the data (a fixture, a parser, a` +
        `\nlabel the server and the client compare by value), end the line with` +
        `\n'// ${ALLOW} <why>'. Do not raise a number in the baseline to pass.`,
    );
  }
  process.exit(1);
}

main();
