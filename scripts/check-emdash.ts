#!/usr/bin/env bun
/**
 * scripts/check-emdash.ts — fail the build when a long dash reaches a text a
 * person reads inside the app.
 *
 * The rule (Attilio, 12/08/2026): that symbol never appears in the app. Texts
 * are terse, professional, useful. The dash is almost always a sentence that
 * could have been two, so the cure is a full stop, not a shorter dash.
 *
 * WHAT IS IN SCOPE and what is not, because they are not the same thing:
 *  · IN  → string literals, template literals and JSX text — i18n entries,
 *    hand-written strings in components, and anything the server writes that
 *    ends up under a person's eyes (task notes, notifications, skip reasons).
 *  · OUT → code comments and commit messages. Nobody reads them in the app,
 *    and rewriting them would bury the real work under thousands of lines.
 *
 * So the scanner strips comments (quote-aware, so a `//` inside a string is
 * still a string) and then flags every long dash left in the file. No AST: the
 * comment/string state machine is enough for this codebase, and it keeps the
 * script dependency-free (the root has no `typescript` installed).
 *
 * Escape hatch, for the rare case where the character IS the data (a parser, a
 * fixture, this file's own pattern): suffix the line with `// allow-emdash: <why>`.
 *
 * Run: `bun run check:emdash`
 *      `bun run scripts/check-emdash.ts path/to/file.ts …`   (scan those instead)
 */
import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { resolve, relative, join } from "path";

const ROOT = resolve(import.meta.dir, "..");

/**
 * The roots that hold app-visible text. `client/src` is the UI; `server` and
 * `shared` are in because the server writes prose a person reads on a card.
 * Tests, e2e specs and `scripts/` stay out: their strings are assertions and
 * logs for us, not copy for a user.
 */
const SCAN_ROOTS = ["client/src", "server", "shared"];
const EXTENSIONS = [".ts", ".tsx"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "__tests__", "__mocks__"]);
const SKIP_FILE = /\.(test|spec|e2e)\.[cm]?tsx?$/;

/**
 * Files whose strings are PROMPTS, not copy. An MCP tool description and the
 * agent briefing are read by a model, never by a person in the app, and the
 * dash there is deliberate emphasis in tuned instructions. Rewriting them would
 * change agent behaviour to fix a typography rule that does not apply to them.
 *
 * The dispatcher is not here: it writes both the briefing AND the notes a
 * person reads on a card, so its prompt region carries a block marker instead.
 */
const PROMPT_SURFACES = new Set([
  "server/mcp/topics-mcp-server.ts", // MCP tool schemas handed to the agent
  "server/browser-tool-spec.ts", // browser_* tool descriptions
  "server/context/assemble.ts", // the awareness/context prefix
  "server/services/task-model-picker.ts", // the model+effort classifier prompt
  "server/control-tools.ts", // control tool descriptions
  "server/lib/commit-message.ts", // the commit-message writing prompt
]);

/**
 * Server logs and dev warnings print to a terminal, not into the app. They are
 * for us, so they are out of scope for the same reason comments are.
 */
const LOG_CALL_RE =
  /(?:^|[^\w.$])(?:console\.(?:log|warn|error|info|debug|trace)|logger\.\w+|(?:\w+\.)?(?:log|warn|debugLog))\s*\(/;

/** How far back to look for the log call that a wrapped argument belongs to. */
const LOG_LOOKBACK = 8;

/**
 * True when the line sits inside a log call, including the wrapped arguments of
 * a multi-line one. Walks back to a line that opens a log call and checks the
 * parentheses never closed on the way down.
 */
function insideLogCall(lines: string[], idx: number): boolean {
  // Where the offending dash sits: everything after it on that line is
  // irrelevant, so the balance is measured up to that column.
  const dashAt = (lines[idx] ?? "").search(DASH_RE);
  const until = dashAt === -1 ? (lines[idx] ?? "").length : dashAt;

  for (let start = idx; start >= 0 && idx - start <= LOG_LOOKBACK; start--) {
    const match = LOG_CALL_RE.exec(lines[start] ?? "");
    if (!match) continue;
    let depth = 0;
    let closed = false;
    for (let i = start; i <= idx; i++) {
      const text = lines[i] ?? "";
      const from = i === start ? match.index : 0;
      const to = i === idx ? until : text.length;
      for (const ch of text.slice(from, to)) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      if (i < idx && depth <= 0) {
        closed = true;
        break;
      }
    }
    if (!closed && depth > 0) return true;
  }
  return false;
}

/**
 * U+2014 em dash, U+2013 en dash, U+2015 horizontal bar. Written as escapes so
 * this file has zero raw long dashes and can be scanned by itself.
 */
const DASHES = ["\u2014", "\u2013", "\u2015"];
const DASH_RE = /[\u2013\u2014\u2015]/;
const ALLOW = "allow-emdash:";
const ALLOW_BLOCK_OPEN = "allow-emdash-block:";
const ALLOW_BLOCK_CLOSE = "end-allow-emdash";

interface Hit {
  file: string;
  line: number;
  text: string;
}

/**
 * Blanks out comments while keeping every byte position, so line numbers and
 * columns survive. Quote-aware in both directions: `"http://x"` is not a
 * comment, and `/* ... *​/` inside a string is not one either.
 *
 * Regex literals ARE modelled, and not for elegance: `/```[\s\S]*?```/g` in
 * `routes/topics.ts` opened a phantom template literal that swallowed the next
 * six comment lines and reported them as app text. A guard that cries wolf on
 * comments is worse than no guard. Whether a `/` opens a regex or divides is
 * decided the usual way, by the last significant character before it.
 */
function stripComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  let templateDepth = 0;
  // The last non-space character of real code seen, to tell regex from divide.
  let prev = "";

  const blank = (s: string) => s.replace(/[^\n]/g, " ");

  /**
   * Walk the body of a template literal from `at` and answer where the copy
   * stops: after its closing backtick, or at the `${` that hands control back
   * to code (which is why it may raise `templateDepth`). Both the opening
   * backtick and the `}` that closes an expression continue into the same
   * body, and writing that walk twice is how the two halves drift.
   */
  const scanTemplateBody = (at: number): number => {
    let j = at;
    while (j < src.length) {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === "`") {
        j++;
        break;
      }
      if (src[j] === "$" && src[j + 1] === "{") {
        j += 2;
        templateDepth++;
        break;
      }
      j++;
    }
    return j;
  };

  const REGEX_CAN_FOLLOW = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">", "\n"]);

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out.push(blank(src.slice(i, stop)));
      i = stop;
      continue;
    }

    if (c === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close === -1 ? src.length : close + 2;
      out.push(blank(src.slice(i, stop)));
      i = stop;
      continue;
    }

    if (c === "/" && REGEX_CAN_FOLLOW.has(prev)) {
      // Regex literal: copy it through verbatim, minding classes and escapes.
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
        out.push(src.slice(i, j));
        i = j;
        prev = "/";
        continue;
      }
      // Unterminated on this line: it was a division after all.
    }

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        j++;
      }
      const stop = Math.min(j + 1, src.length);
      out.push(src.slice(i, stop));
      i = stop;
      continue;
    }

    if (c === "`") {
      // Template literal: copy through, but stop at `${` so the expression
      // inside is scanned as code again (it may hold a comment).
      const j = scanTemplateBody(i + 1);
      out.push(src.slice(i, j));
      i = j;
      continue;
    }

    if (c === "}" && templateDepth > 0) {
      // Back into the template literal that opened this `${`.
      templateDepth--;
      out.push(c);
      i++;
      const j = scanTemplateBody(i);
      out.push(src.slice(i, j));
      i = j;
      continue;
    }

    out.push(c);
    if (c.trim() !== "") prev = c;
    i++;
  }

  return out.join("");
}

function scan(file: string): Hit[] {
  const abs = resolve(ROOT, file);
  if (!existsSync(abs)) {
    console.warn(`[check-emdash] missing: ${file} (skipped)`);
    return [];
  }
  const raw = readFileSync(abs, "utf-8");
  if (!DASH_RE.test(raw)) return [];

  const rawLines = raw.split(/\r?\n/);
  const cleaned = stripComments(raw).split(/\r?\n/);
  const hits: Hit[] = [];
  let muted = false;

  cleaned.forEach((line, idx) => {
    const rawLine = rawLines[idx] ?? line;
    if (rawLine.includes(ALLOW_BLOCK_OPEN)) muted = true;
    else if (rawLine.includes(ALLOW_BLOCK_CLOSE)) muted = false;
    if (muted) return;
    if (!DASH_RE.test(line)) return;
    if (rawLine.includes(ALLOW)) return;
    if (insideLogCall(cleaned, idx)) return;
    hits.push({ file, line: idx + 1, text: rawLine.trim() });
  });

  return hits;
}

function walk(dir: string, acc: string[]): string[] {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(relative(ROOT, full), acc);
      continue;
    }
    if (!EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
    if (SKIP_FILE.test(entry)) continue;
    const rel = relative(ROOT, full);
    if (PROMPT_SURFACES.has(rel)) continue;
    acc.push(rel);
  }
  return acc;
}

function main() {
  const argv = process.argv.slice(2);
  const targets = argv.length > 0 ? argv : SCAN_ROOTS;
  const files = targets.flatMap((target: string) => {
    const abs = resolve(ROOT, target);
    return existsSync(abs) && statSync(abs).isDirectory() ? walk(target, []) : [target];
  });

  const hits: Hit[] = [];
  for (const f of files) hits.push(...scan(f));

  if (hits.length === 0) {
    console.log(`[check-emdash] OK: ${files.length} file(s), no long dash in any app text.`);
    process.exit(0);
  }

  const byFile = new Map<string, Hit[]>();
  for (const h of hits) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }

  console.error(
    `[check-emdash] FAIL: ${hits.length} long dash(es) in app text, across ${byFile.size} file(s).`,
  );
  for (const [file, list] of byFile) {
    console.error(`\n  ${file}`);
    for (const h of list) {
      const text = h.text.length > 140 ? `${h.text.slice(0, 137)}…` : h.text;
      console.error(`    :${h.line}  ${text}`);
    }
  }
  console.error(
    `\nDo not swap the dash for a shorter one: the sentence it holds together is` +
      `\nusually two sentences. Split it, or drop the aside. If the character IS` +
      `\nthe data, end the line with '// ${ALLOW} <reason>'.`,
  );
  console.error(`Looking for: ${DASHES.map((d) => JSON.stringify(d)).join(" ")}`);
  process.exit(1);
}

main();
