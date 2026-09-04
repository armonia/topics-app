#!/usr/bin/env bun
/**
 * scripts/ui-language-scan.ts - HOW a file is read, for `check-ui-language.ts`.
 *
 * Split out of the gate for the same reason `ui-language-words.ts` was: the
 * script had grown past the 800-line ceiling `check:bloat` holds, and the two
 * halves change for unrelated reasons. This one is the LEXER and the six
 * extraction passes: what counts as a text a person reads. The other one is
 * the ratchet: what happens to the count. A change to the scanners should not
 * make the diff of the baseline logic unreadable, and the other way round.
 *
 * Nothing here knows about the baseline, the exit codes or the CLI.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { ACCENTS, STOPWORDS, UI_COPY_WORDS } from "./ui-language-words";

const ROOT = resolve(import.meta.dir, "..");

/** The marker that turns one line into data instead of copy. */
export const ALLOW = "allow-italian:";

/**
 * The four attributes a person reads. `value` and `name` are out: they are
 * almost always identifiers, and `children` is covered by the JSX text pass.
 */
const READABLE_ATTRS = ["aria-label", "placeholder", "title", "alt"] as const;

/** The payload keys a client renders verbatim into a toast or an inline error. */
const PAYLOAD_KEYS = ["error", "detail", "reason", "message"] as const;

/**
 * The property names whose value is read by a person. `name`, `id`, `key`,
 * `value` and `type` are out on purpose: they are identifiers everywhere in
 * this tree, and one false positive costs more than ten missed strings.
 */
const READABLE_FIELDS = [
  "label", "message", "hint", "title", "head", "detail", "description",
  "confirmLabel", "cancelLabel", "placeholder", "tooltip",
] as const;

/**
 * The catalogues are DATA, not copy. They are excluded by name now that `.ts`
 * modules are in scope: the Italian dictionary is the feature this gate
 * protects, so scanning it would report the product as the defect.
 */
export const I18N_CATALOGUES = new Set([
  "client/src/lib/i18n.ts",
  "client/src/lib/i18n-it.ts",
  "client/src/lib/i18n-en.ts",
  "client/src/lib/i18n-types.ts",
  "client/src/lib/i18n-spend-it.ts",
  "client/src/lib/i18n-spend-en.ts",
]);

/**
 * The two fields that are button copy in every file, migrated or not.
 *
 * `title` and `message` are read only where a translation function is already
 * in scope: a component nobody has migrated yet is written in English on
 * purpose, and calling that a defect would flag the whole app. These two are
 * different. They are the buttons of a destructive dialog, they are handed to
 * a SHARED component, and the default the shared component picks when a caller
 * omits them is the one a person reads next to "Move to trash".
 */
const DIALOG_FIELDS = ["confirmLabel", "cancelLabel"] as const;

/** Which question a hit answers: is this Italian, or is it simply not keyed. */
export type HitKind = "italian" | "untranslated";

export interface Hit {
  file: string;
  line: number;
  kind: HitKind;
  /** `jsx` | `jsx-expr` | `attr:<name>` | `field:<name>`, so a report says WHY. */
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
    if (token.length >= 3 && (STOPWORDS.has(token) || UI_COPY_WORDS.has(token))) found.add(token);
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
    hits.push({ file, line, kind: "italian", where: "jsx", words, text: excerpt(chunk) });
  }
  return hits;
}

/**
 * The `{...}` regions that sit in JSX CHILD position, as (start, end) offsets
 * of their CONTENT. Same anchor as `scanJsxText`: a span between a `>` and the
 * next `<` in the structural view. `CODE_RESIDUE` is NOT applied here, because
 * a ternary is code by definition and its branches are still labels.
 */
function jsxExpressionRegions(code: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== "<") continue;
    const open = code.lastIndexOf(">", i - 1);
    if (open === -1) continue;
    for (let k = open + 1; k < i; k++) {
      if (code[k] !== "{") continue;
      let depth = 0;
      let end = -1;
      for (let j = k; j < code.length; j++) {
        if (code[j] === "{") depth++;
        else if (code[j] === "}") {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end === -1) break;
      out.push({ start: k + 1, end });
      k = end;
    }
  }
  return out;
}

/** String literals written inside a JSX expression container: `{'Consenti'}`. */
function scanJsxExpressions(file: string, src: string, lexed: Lexed, starts: number[], rawLines: string[]): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<number>();
  for (const region of jsxExpressionRegions(lexed.codeOnly)) {
    for (const lit of literalsIn(lexed.literals, region.start, region.end)) {
      if (seen.has(lit.start)) continue;
      seen.add(lit.start);
      const text = src.slice(lit.start, lit.end);
      const words = italianWords(text);
      if (words.length === 0) continue;
      const line = lineOf(starts, lit.start);
      if (waived(rawLines, line, lineOf(starts, region.start))) continue;
      hits.push({ file, line, kind: "italian", where: "jsx-expr", words, text: excerpt(text) });
    }
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
      hits.push({ file, line, kind: "italian", where: `attr:${attr}`, words, text: excerpt(text) });
    }
  }
  return hits;
}

/**
 * The value of a named property, for a list of property names. Two callers:
 * the server payload keys the client prints verbatim, and the label-ish fields
 * a dialog takes its words from.
 */
function scanKeyedValues(
  file: string, src: string, lexed: Lexed, starts: number[], rawLines: string[],
  keys: readonly string[], wherePrefix: string,
): Hit[] {
  const hits: Hit[] = [];
  const code = lexed.codeOnly;
  // `:` is the object literal, `=` is the other two ways the same words arrive:
  // a JSX prop (`confirmLabel="Discard"`) and a destructuring default
  // (`{ confirmLabel = 'Confirm' }`). ConfirmDialog hard-codes both buttons that
  // second way, and a scan that only knew `:` called that file clean.
  const re = new RegExp(`(?<![\\w$.-])(${keys.join("|")})\\s*[:=]\\s*`, "g");
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
      hits.push({ file, line, kind: "italian", where: `${wherePrefix}:${key}`, words, text: excerpt(text) });
    }
  }
  return hits;
}

/**
 * EVERY string literal, for the `.ts` modules that have no JSX.
 *
 * In a component the extraction has to be surgical: a `.tsx` is full of class
 * lists and ids, and looking everywhere would drown the report. A `lib`, a
 * `hook` or a `shared` module is the opposite case: it has no markup, its
 * literals are keys, paths and copy, and Italian in one of them is copy by
 * elimination. That is where `PERMISSION_LABELS`, `navErrorMessage` and the
 * dictation errors were hiding from a gate that only knew how to read JSX.
 */
function scanModuleLiterals(file: string, src: string, lexed: Lexed, starts: number[], rawLines: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const lit of lexed.literals) {
    const text = src.slice(lit.start, lit.end);
    const words = italianWords(text);
    if (words.length === 0) continue;
    const line = lineOf(starts, lit.start);
    if (waived(rawLines, line, line)) continue;
    hits.push({ file, line, kind: "italian", where: "module", words, text: excerpt(text) });
  }
  return hits;
}

/**
 * The one-word labels a button is allowed to be. A single word is normally not
 * enough evidence that a literal is copy (it is usually an identifier), but
 * these are the words this app's buttons are actually made of, and they are
 * exactly the ones that got hard-coded.
 */
const BUTTON_WORDS = new Set([
  "copy", "confirm", "cancel", "discard", "reload", "refresh", "close",
  "retry", "back", "next", "send", "save", "delete", "remove", "open",
  "allow", "deny", "stop", "start", "edit", "rename", "undo", "redo",
]);

/**
 * True when a literal reads as English COPY rather than as code.
 *
 * Tight on purpose: this pass runs over files that already went through the
 * translation layer, so a false positive here accuses somebody who did the
 * work. Anything lowercase is treated as an identifier, a key or a class
 * list, which is what lowercase strings are in this tree.
 */
function englishProse(raw: string): boolean {
  const text = raw.trim();
  if (text.length < 3 || text.length > 200) return false;
  // Paths, urls, keys, css, formats: not something a translator would touch.
  if (/[/\\_@#$]|:\/\/|\.[a-z]{2,4}$/.test(text)) return false;
  // A quote INSIDE the literal means a list of names, not a sentence: this is
  // what a CSS font stack looks like, and it was the only false positive the
  // second pass produced on this tree.
  if (/["'\u2018\u201c]/.test(text.slice(1, -1))) return false;
  if (/^[a-z0-9.\-\s]+$/.test(text)) return false;
  if (italianWords(text).length > 0) return false;
  const words = text.match(/[A-Za-z][A-Za-z'\u2019]*/g) ?? [];
  if (words.length === 0) return false;
  // Non-letter soup (numbers, symbols, emoji) is not a sentence.
  if (words.join("").length < text.replace(/[\s.,!?()'\u2019]/g, "").length / 2) return false;
  const first = text.match(/[A-Za-z]/)?.[0] ?? "";
  if (first !== first.toUpperCase()) return false;
  // No whitespace means ONE token, whatever the hyphens and dots inside it
  // suggest: `Content-Type`, `ArrowDown`, `PascalCase` are names, not
  // sentences. Only the short list of button words survives that test.
  if (!/\s/.test(text)) return BUTTON_WORDS.has(text.replace(/[^A-Za-z]/g, "").toLowerCase());
  if (words.length === 1) return BUTTON_WORDS.has(words[0]!.toLowerCase());
  // ALL CAPS is a constant, an acronym or a shout, not a sentence.
  if (text === text.toUpperCase()) return false;
  return true;
}

/**
 * English hard-coded into a file that already imports `useT`.
 *
 * Same extraction sites as the Italian pass, opposite question: the surface
 * HAS a translation function in scope and this string walked past it.
 */
function scanUntranslated(file: string, src: string, lexed: Lexed, starts: number[], rawLines: string[]): Hit[] {
  const code = lexed.codeOnly;
  // Two different burdens of proof. A JSX text node is only evidence of a
  // missed key in a file that HAS a translation function in scope; everywhere
  // else it is a surface nobody has migrated yet, which is a plan, not a
  // regression. A `label`/`confirmLabel` value is copy by construction: that
  // is the whole reason the field list exists, so it is read everywhere.
  const migrated = /\buseT\b/.test(src);
  const hits: Hit[] = [];
  const push = (start: number, text: string, where: string, openAt: number): void => {
    if (!englishProse(text)) return;
    const line = lineOf(starts, start);
    if (waived(rawLines, line, lineOf(starts, openAt))) return;
    hits.push({ file, line, kind: "untranslated", where, words: [], text: excerpt(text) });
  };

  if (migrated && file.endsWith(".tsx")) {
    for (let i = 0; i < code.length; i++) {
      if (code[i] !== "<") continue;
      const open = code.lastIndexOf(">", i - 1);
      if (open === -1) continue;
      const chunk = stripBraces(code.slice(open + 1, i));
      if (CODE_RESIDUE.test(chunk)) continue;
      const at = chunk.search(/\S/);
      if (at === -1) continue;
      push(open + 1 + at, chunk, "jsx", open);
    }
    const seen = new Set<number>();
    for (const region of jsxExpressionRegions(code)) {
      for (const lit of literalsIn(lexed.literals, region.start, region.end)) {
        if (seen.has(lit.start)) continue;
        seen.add(lit.start);
        push(lit.start, src.slice(lit.start, lit.end), "jsx-expr", region.start);
      }
    }
    const attrRe = new RegExp(`(?<![\\w$.-])(${READABLE_ATTRS.join("|")})\\s*=\\s*["'\`]`, "g");
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(code)) !== null) {
      const at = m0End(a);
      for (const lit of literalsIn(lexed.literals, at, at + 1)) {
        push(lit.start, src.slice(lit.start, lit.end), `attr:${a[1]!}`, a.index);
      }
    }
  }

  const fieldRe = new RegExp(`(?<![\\w$.-])(${(migrated ? READABLE_FIELDS : DIALOG_FIELDS).join("|")})\\s*[:=]\\s*["'\`]`, "g");
  let f: RegExpExecArray | null;
  while ((f = fieldRe.exec(code)) !== null) {
    const at = m0End(f);
    for (const lit of literalsIn(lexed.literals, at, at + 1)) {
      push(lit.start, src.slice(lit.start, lit.end), `field:${f[1]!}`, f.index);
    }
  }
  return hits;
}

/** Offset just after the quote a `key: "` match ends on: where the content starts. */
function m0End(m: RegExpExecArray): number {
  return m.index + m[0].length;
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

export function scanFile(file: string): Hit[] {
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
    hits.push(...scanJsxExpressions(file, src, lexed, starts, rawLines));
    hits.push(...scanAttributes(file, src, lexed, starts, rawLines));
  }
  // The keyed scans run BEFORE the sweep so the more specific `where` wins the
  // dedupe: a report that says `payload:error` tells you what to fix, one that
  // says `module` only tells you where.
  hits.push(...scanKeyedValues(file, src, lexed, starts, rawLines, PAYLOAD_KEYS, "payload"));
  hits.push(...scanKeyedValues(file, src, lexed, starts, rawLines, READABLE_FIELDS, "field"));
  if (!file.endsWith(".tsx") && !file.startsWith("server/routes/")) {
    // The server routes keep their narrow payload scan: their literals are SQL,
    // column names and ids by the hundred, and only what the client prints
    // verbatim is copy.
    hits.push(...scanModuleLiterals(file, src, lexed, starts, rawLines));
  }
  hits.push(...scanUntranslated(file, src, lexed, starts, rawLines));
  return dedupe(hits).sort((a, b) => a.line - b.line);
}

/**
 * One string reported once. `detail:` and `message:` are in both key lists and
 * a label inside a JSX expression is also a field value, so the same literal
 * can arrive from two scans; counting it twice would inflate the baseline and
 * make a cured file look half cured.
 */
export function dedupe(hits: Hit[]): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const h of hits) {
    const key = `${h.kind}|${h.line}|${h.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

