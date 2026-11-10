#!/usr/bin/env node
/**
 * scripts/check-ui-isolation.mjs - exit 1 when a file of the UI layer
 * (`client/src/ui/`) reaches outside presentation.
 *
 * WHY. `client/src/ui/` is the one set of components the product and the
 * landing share. It stays reusable only while it renders from props alone: the
 * day a screen imports `lib/api` or a store, the landing has to boot a fake
 * server to show it, and the gallery stops being a picture of the component.
 * Code review does not hold that line for long, so this gate does.
 *
 * WHAT IS ALLOWED, and nothing else:
 *  · packages: `react` (and its jsx runtime), `lucide-react`, `clsx`;
 *  · relative imports that stay inside `client/src/ui/`;
 *  · a short list of product modules checked to be pure (PURE_MODULES below).
 *    Their own imports are checked too: a value import from outside the list
 *    fails, a type-only import is erased at build time and passes.
 *
 * WHAT ELSE FAILS:
 *  · a screen that imports `client/src/ui/fixtures/`: example data reaches a
 *    screen only through props, so in the product the same prop is fed by the
 *    API and nothing has to be unwired;
 *  · I/O and effects in code (comments and strings are stripped first):
 *    fetch, XMLHttpRequest, WebSocket, EventSource, storage, cookies, timers,
 *    window/document, and the hooks that run effects or read a context;
 *  · an empty layer: a gate that scans zero files is green by accident.
 *
 * Run: `bun run check:ui-isolation` (or `node scripts/check-ui-isolation.mjs`).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = join(ROOT, "client/src/ui");
const FIXTURES_DIR = join(UI_DIR, "fixtures");

const PACKAGES = new Set(["react", "react/jsx-runtime", "lucide-react", "clsx"]);

/* Product modules the layer may use, each read and found pure: no state, no
 * I/O, no context. Adding one means reading it first. */
const PURE_MODULES = new Set([
  "client/src/lib/selectionStyles.ts",
  "client/src/components/Shared/Segmented.tsx",
  "client/src/components/Shared/controlKeys.ts",
]);

const FORBIDDEN = [
  [/\bfetch\s*\(/, "fetch()"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
  [/\b(localStorage|sessionStorage|indexedDB)\b/, "browser storage"],
  [/\bdocument\s*\.\s*cookie\b/, "document.cookie"],
  [/\bnavigator\s*\.\s*sendBeacon\b/, "navigator.sendBeacon"],
  [/\b(setTimeout|setInterval|requestAnimationFrame)\s*\(/, "timer"],
  [/\b(window|document|globalThis)\s*\./, "window/document access"],
  [/\buse(Effect|LayoutEffect|InsertionEffect|SyncExternalStore|Context)\b/, "effect or context hook"],
  [/\bcreateContext\b/, "createContext"],
];

const EXTENSIONS = [".ts", ".tsx"];

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (EXTENSIONS.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

const rel = (p) => relative(ROOT, p).split(sep).join("/");
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/* Every module specifier with its line and whether the statement is type-only. */
function importsOf(text) {
  const found = [];
  const patterns = [
    /\bimport\s+(type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const [i, re] of patterns.entries()) {
    for (const m of text.matchAll(re)) {
      const typeOnly = i < 2 && Boolean(m[1]);
      const spec = i < 2 ? m[2] : m[1];
      found.push({ spec, typeOnly, line: lineOf(text, m.index) });
    }
  }
  return found;
}

/* Resolve a relative specifier to a file on disk, the way the bundler does. */
function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => join(base, "index" + e))]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function resolveSpec(fromFile, spec) {
  if (spec.startsWith(".")) return resolveRelative(fromFile, spec);
  if (spec.startsWith("@/")) return resolveRelative(join(ROOT, "client/src/x"), "./" + spec.slice(2));
  return null;
}

/* Code with comments and string contents blanked, so a word inside a comment
 * or a label never trips the I/O patterns. Template literals keep their
 * `${...}` expressions, which are code. */
function codeOnly(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") { while (i < n && text[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && d === "*") { while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { out += text[i] === "\n" ? "\n" : " "; i++; } out += "  "; i += 2; continue; }
    if (c === "'" || c === '"') {
      out += c; i++;
      while (i < n && text[i] !== c && text[i] !== "\n") { if (text[i] === "\\") { out += " "; i++; } out += " "; i++; }
      out += c; i++; continue;
    }
    if (c === "`") {
      out += c; i++;
      while (i < n && text[i] !== "`") {
        if (text[i] === "\\") { out += "  "; i += 2; continue; }
        if (text[i] === "$" && text[i + 1] === "{") {
          let depth = 0;
          while (i < n) { const ch = text[i]; out += ch; i++; if (ch === "{") depth++; else if (ch === "}" && --depth === 0) break; }
          continue;
        }
        out += text[i] === "\n" ? "\n" : " "; i++;
      }
      out += "`"; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

const problems = [];
const report = (file, line, what) => problems.push(`${rel(file)}:${line}  ${what}`);

/* A pure product module may import only types from anywhere, and values only
 * from packages or from other modules on the list. */
const checkedPure = new Set();
function checkPureModule(file) {
  if (checkedPure.has(file)) return;
  checkedPure.add(file);
  const text = readFileSync(file, "utf8");
  for (const imp of importsOf(text)) {
    if (imp.typeOnly) continue;
    if (PACKAGES.has(imp.spec)) continue;
    const target = resolveSpec(file, imp.spec);
    if (target && PURE_MODULES.has(rel(target))) { checkPureModule(target); continue; }
    report(file, imp.line, `pure module imports '${imp.spec}', which is not on the list`);
  }
}

const files = walk(UI_DIR);
if (files.length === 0) {
  console.error("check:ui-isolation: client/src/ui/ holds no .ts/.tsx file; nothing would be checked.");
  process.exit(1);
}

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const inFixtures = file.startsWith(FIXTURES_DIR + sep);
  for (const imp of importsOf(text)) {
    if (PACKAGES.has(imp.spec)) continue;
    const target = resolveSpec(file, imp.spec);
    if (!target) { report(file, imp.line, `imports '${imp.spec}': only react, lucide-react, clsx and files inside client/src/ui are allowed`); continue; }
    if (target.startsWith(UI_DIR + sep)) {
      if (!inFixtures && target.startsWith(FIXTURES_DIR + sep)) report(file, imp.line, `imports fixtures ('${imp.spec}'): example data reaches a screen only through props`);
      continue;
    }
    if (PURE_MODULES.has(rel(target))) { checkPureModule(target); continue; }
    report(file, imp.line, `imports '${imp.spec}' (${rel(target)}), outside the UI layer and not on the list of pure modules`);
  }
  const code = codeOnly(text);
  for (const [re, what] of FORBIDDEN) {
    const g = new RegExp(re.source, "g");
    for (const m of code.matchAll(g)) report(file, lineOf(code, m.index), `uses ${what}`);
  }
}

if (problems.length) {
  console.error(`check:ui-isolation: ${problems.length} problem(s) in client/src/ui/\n` + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}
console.log(`check:ui-isolation: ${files.length} files in client/src/ui/, props only (${checkedPure.size} pure product modules read)`);
