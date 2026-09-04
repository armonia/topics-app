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
 *  · IN  -> string literals inside a JSX EXPRESSION CONTAINER in child
 *    position: `{'Consenti'}`, `{n ? 'Invia' : 'Avanti'}`. allow-italian: the quoted labels ARE the example. The first cut
 *    stripped every `{...}` before looking, so a label written as an
 *    expression was invisible to a gate whose whole job is labels.
 *  · IN  -> the value of a property a person reads: `label`, `message`,
 *    `hint`, `title`, `head`, `detail`, `description`, `confirmLabel`,
 *    `cancelLabel`, `placeholder`, `tooltip`. A dialog that takes its words
 *    from an object literal is not less visible than one that inlines them.
 *  · IN  -> `error:` / `detail:` / `reason:` / `message:` string values in the
 *    tracked modules under `server/routes`. Those are the payloads the client
 *    prints straight into a toast or an inline error.
 *  · IN  -> `client/src/lib/**.ts`, `client/src/hooks/**.ts` and `shared/**.ts`.
 *    A `.ts` module has no JSX, which is exactly why the copy that lives there
 *    (a decision label, a queue phrase, an error sentence) never got looked at.
 *  · OUT -> COMMENTS, always and on purpose. This repo's comments are Italian
 *    by design and there are thousands of them; policing prose in comments is a
 *    separate and much larger decision, and a gate that flagged them would be
 *    turned off within a week (the same reasoning `scripts/check-emdash.ts` and
 *    `scripts/check-script-naming.test.ts` already write down).
 *  · OUT -> test and spec files. Their strings are assertions, not copy, and
 *    several of them anchor Italian text on purpose.
 *  · OUT -> the translation catalogues themselves (`i18n*.ts`), by name now
 *    that `.ts` modules are scanned: the `it` dictionary IS the Italian, and
 *    flagging it would be flagging the feature.
 *
 * THE SECOND PASS, and why it is a different question. Italian is only half of
 * "this string cannot follow the chosen language". The other half is English
 * hard-coded in a file that ALREADY imports `useT`: the surface was migrated,
 * a later change wrote `Copy` straight into the JSX, and nothing complains
 * because the gate was only ever looking for Italian. Those hits are counted
 * as `untranslated`, in their own baseline map, because the fix is different
 * (add a key) and the debt is much larger.
 *
 * The heuristic for "prose a person reads" is deliberately tight: two words or
 * more, or one word from a short list of button verbs, capitalised, and never
 * anything that smells like an identifier, a class name, a path or a URL. One
 * false positive here costs more trust than ten missed strings, and this pass
 * runs over files that are already doing the right thing.
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

import { ACCENTS, STOPWORDS, UI_COPY_WORDS } from "./ui-language-words";

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
const I18N_CATALOGUES = new Set([
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
type HitKind = "italian" | "untranslated";

interface Hit {
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
function dedupe(hits: Hit[]): Hit[] {
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

// ---------------------------------------------------------------------------
// Which files
// ---------------------------------------------------------------------------

const IS_TEST = /\.(test|spec|e2e)\.[cm]?tsx?$/;

/**
 * EVERY tracked `.ts` under `client/src` is in scope, not just `lib` and
 * `hooks`. The first cut named those two directories and missed exactly the
 * modules the bug report was about: `components/Browser/navErrorMessage.ts`
 * and `components/Chat/useVoiceRecording.ts` are plain modules that live
 * beside the component that uses them, and a scope written by directory name
 * declared them out of the product.
 */
function inScope(p: string): boolean {
  if (IS_TEST.test(p)) return false;
  if (I18N_CATALOGUES.has(p)) return false;
  if (p.endsWith(".tsx")) return p.startsWith("client/src/");
  if (!p.endsWith(".ts")) return false;
  return p.startsWith("client/src/") || p.startsWith("server/routes/") || p.startsWith("shared/");
}

function trackedFiles(): string[] {
  const git = spawnSync("git", ["ls-files", "-z", "client/src", "server/routes", "shared"], {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (git.status !== 0) {
    console.error("[check-ui-language] cannot list tracked files: is this a git checkout?");
    process.exit(2);
  }
  return git.stdout.split("\0").filter(Boolean).filter(inScope);
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

interface Baseline {
  $schema: string;
  _comment: string[];
  updated: string;
  /** path -> hard-coded ITALIAN hits the day recorded. Absent means "stay at 0". */
  files: Record<string, number>;
  /** path -> hard-coded ENGLISH hits in a file that already imports `useT`. */
  untranslated: Record<string, number>;
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
  "",
  "TWO MAPS, TWO DEFECTS. `files` counts hard-coded ITALIAN: a string an",
  "English-speaking user reads in the wrong language. `untranslated` counts",
  "hard-coded ENGLISH inside a file that already imports `useT`: the surface was",
  "migrated and a later change wrote the label straight into the JSX, so the",
  "language selector silently stops governing it. The fix differs (translate vs",
  "add a key), so the debt is counted apart.",
];

function readBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const files = (parsed as { files?: unknown }).files;
    if (files === null || typeof files !== "object") return null;
    const body = parsed as Baseline;
    // A v1 baseline has no second map: an absent map is an empty one, so an
    // older file still reads and every untranslated hit shows up as new.
    body.untranslated ??= {};
    return body;
  } catch (err) {
    console.error(`[check-ui-language] baseline unreadable: ${String(err)}`);
    process.exit(2);
  }
  return null;
}

function sortedMap(counts: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) out[key] = counts.get(key)!;
  return out;
}

function writeBaseline(italian: Map<string, number>, untranslated: Map<string, number>): void {
  const body: Baseline = {
    $schema: "ui-language-baseline-v2",
    _comment: BASELINE_COMMENT,
    updated: new Date().toISOString().slice(0, 10),
    files: sortedMap(italian),
    untranslated: sortedMap(untranslated),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
  const total = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
  console.log(
    `[check-ui-language] baseline written: ${italian.size} file(s) with ${total(italian)} Italian hit(s), ` +
      `${untranslated.size} file(s) with ${total(untranslated)} untranslated hit(s).`,
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

  const italianHits = hits.filter((h) => h.kind === "italian");
  const untranslatedHits = hits.filter((h) => h.kind === "untranslated");
  const countBy = (list: Hit[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const h of list) m.set(h.file, (m.get(h.file) ?? 0) + 1);
    return m;
  };
  const counts = countBy(italianHits);
  const untranslatedCounts = countBy(untranslatedHits);

  if (update) {
    if (absolute) {
      console.error("[check-ui-language] --update-baseline needs the full tracked scan, not a file list.");
      process.exit(2);
    }
    writeBaseline(counts, untranslatedCounts);
    process.exit(0);
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
      for (const r of rows) {
        const why = r.kind === "italian" ? r.words.join(" ") : "not keyed";
        console.error(`    :${r.line}  [${r.where}] ${why} | ${r.text}`);
      }
    }
  };

  if (absolute) {
    if (json) console.log(JSON.stringify({ mode: "absolute", files: files.length, hits }, null, 2));
    if (hits.length === 0) {
      if (!json) console.log(`[check-ui-language] OK (absolute): ${files.length} file(s), every app text is keyed.`);
      process.exit(0);
    }
    if (!json) {
      console.error(
        `[check-ui-language] FAIL (absolute): ${italianHits.length} Italian string(s) and ` +
          `${untranslatedHits.length} unkeyed string(s).`,
      );
      report(hits);
      console.error(`\nPut them through i18n, or mark the line with '// ${ALLOW} <why>' when the string IS the data.`);
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

  interface Move { file: string; was: number; now: number }
  interface Verdict { newFiles: string[]; grown: Move[]; cured: Move[] }

  /** The ratchet, one family at a time: new file or grown file fails, cured is free. */
  const compare = (now: Map<string, number>, was: Record<string, number>): Verdict => {
    const v: Verdict = { newFiles: [], grown: [], cured: [] };
    for (const [file, count] of now) {
      const before = was[file];
      if (before === undefined) v.newFiles.push(file);
      else if (count > before) v.grown.push({ file, was: before, now: count });
      else if (count < before) v.cured.push({ file, was: before, now: count });
    }
    for (const [file, before] of Object.entries(was)) {
      if (!now.has(file)) v.cured.push({ file, was: before, now: 0 });
    }
    return v;
  };

  const italian = compare(counts, baseline.files);
  const untranslated = compare(untranslatedCounts, baseline.untranslated);

  if (json) {
    console.log(JSON.stringify({ mode: "ratchet", files: files.length, italian, untranslated, hits }, null, 2));
  }

  const failing =
    italian.newFiles.length + italian.grown.length + untranslated.newFiles.length + untranslated.grown.length > 0;

  if (!failing) {
    if (!json) {
      console.log(
        `[check-ui-language] OK: ${files.length} file(s) scanned, ` +
          `${italianHits.length} known Italian hit(s) in ${counts.size} file(s), ` +
          `${untranslatedHits.length} known unkeyed hit(s) in ${untranslatedCounts.size} file(s).`,
      );
      const cured = [...italian.cured, ...untranslated.cured];
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
    console.error("[check-ui-language] FAIL: a text a person reads does not follow the chosen language.");
    const families: [string, Verdict, Hit[]][] = [
      ["hard-coded Italian", italian, italianHits],
      ["copy that does not go through i18n", untranslated, untranslatedHits],
    ];
    for (const [what, verdict, family] of families) {
      if (verdict.newFiles.length > 0) {
        console.error(`\n${verdict.newFiles.length} file(s) NOT in the baseline gained ${what}:`);
        report(family.filter((h) => verdict.newFiles.includes(h.file)));
      }
      if (verdict.grown.length > 0) {
        console.error(`\n${verdict.grown.length} baselined file(s) gained MORE ${what}:`);
        for (const g of verdict.grown) console.error(`  ${g.file}: ${g.was} -> ${g.now}`);
        report(family.filter((h) => verdict.grown.some((g) => g.file === h.file)));
      }
    }
    console.error(
      `\nThe app ships in the language the person chose. Put the string through` +
        `\n'client/src/lib/i18n.ts' and add the key to BOTH catalogues. If the string IS` +
        `\nthe data (a fixture, a parser, a label the server and the client compare by` +
        `\nvalue), end the line with '// ${ALLOW} <why>'. Do not raise a baseline number.`,
    );
  }
  process.exit(1);
}

main();
