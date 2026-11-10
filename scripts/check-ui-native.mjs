#!/usr/bin/env node
/**
 * scripts/check-ui-native.mjs - exit 1 when the preview draws a control of the
 * browser instead of one of the layer's own.
 *
 * WHY. Attilio asked for an app where nothing is the browser's: a native
 * select opens the system list (grey, another font, no icons, no search), a
 * date input the system calendar, and a `title` attribute the yellow-grey
 * tooltip that appears late and cannot be styled. The layer has its own
 * (`primitives/Field.tsx` Select and DatePicker, the tooltip of `data-tip`
 * drawn by the container); this gate keeps the native ones from coming back.
 *
 * WHAT IT READS, two ways, both must be clean:
 *  1. the sources of the preview (`client/src/ui/**` and
 *     `client/src/ui-gallery/**`, .tsx), parsed with TypeScript: on a lowercase
 *     JSX element it fails on `select`, `datalist`, `option`, `optgroup`, an
 *     `input` whose literal type is a date, time, colour, range or file
 *     picker, a checkbox or radio that is not visually hidden (`sr-only`),
 *     and any `title` attribute (the tooltip of the browser);
 *  2. the build (`client/dist-ui/`, run `bun run build:ui` first): the same
 *     elements in the HTML, and in the bundled JavaScript the JSX calls that
 *     make them (`jsx("select",…)`, `type:"date"` on an `input`, a `title:` among the props
 *     of a lowercase element).
 *
 *   node scripts/check-ui-native.mjs [--src-only]
 *
 * Exit 0: no native control and no native tooltip, with the counts read.
 * Exit 1: every hit as `file:line - what`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "client/package.json"));
const ts = require("typescript");

const SOURCES = ["client/src/ui", "client/src/ui-gallery"].map((d) => join(ROOT, d));
const DIST = join(ROOT, "client/dist-ui");
const srcOnly = process.argv.includes("--src-only");

const NATIVE_TAGS = new Set(["select", "datalist", "option", "optgroup"]);
/* Input types whose look and picker belong to the browser. */
const NATIVE_INPUT_TYPES = new Set(["date", "time", "datetime-local", "month", "week", "color", "range", "file"]);

const rel = (p) => relative(ROOT, p).split(sep).join("/");

function walk(dir, ext) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (ext.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

const hits = [];

/* ---------- 1. sources ---------- */

/** The literal text of an attribute's value, or undefined when it is an expression. */
function literal(attr, sf) {
  const init = attr?.initializer;
  if (!init) return attr ? "" : undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))) return init.expression.text;
  return undefined;
}

let sourceFiles = 0;
let elements = 0;
for (const file of SOURCES.flatMap((d) => walk(d, [".tsx"]))) {
  sourceFiles++;
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const at = (n) => `${rel(file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(sf);
      if (/^[a-z]/.test(tag)) {
        elements++;
        const attrs = n.attributes.properties.filter(ts.isJsxAttribute);
        const get = (k) => attrs.find((a) => a.name.getText(sf) === k);
        if (NATIVE_TAGS.has(tag)) hits.push(`${at(n)} - <${tag}> of the browser: use Select or the layer's menu`);
        if (get("title")) hits.push(`${at(n)} - title= on <${tag}>: the browser's tooltip, use data-tip`);
        if (tag === "input") {
          const type = literal(get("type"), sf);
          if (type && NATIVE_INPUT_TYPES.has(type)) hits.push(`${at(n)} - <input type="${type}">: the browser's picker`);
          if (type === "checkbox" || type === "radio") {
            const cls = get("className")?.initializer?.getText(sf) ?? "";
            if (!/\bsr-only\b/.test(cls)) hits.push(`${at(n)} - visible <input type="${type}">: hide it (sr-only) under the layer's box`);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/* ---------- 2. build ---------- */

/** The props object that starts at `open` (a `{`), as text, braces and strings balanced. */
function objectAt(code, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < code.length && i < open + 20000; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return code.slice(open, open + 2000);
}

/** Whether `key:` appears among the top-level keys of an object literal's text. */
function hasTopKey(obj, key) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (depth === 1 && obj.startsWith(key + ":", i) && /[{,\s]/.test(obj[i - 1] ?? ",")) return true;
  }
  return false;
}

let buildFiles = 0;
if (!srcOnly) {
  for (const page of ["sarim.html", "consorzio.html"]) {
    if (!existsSync(join(DIST, page))) {
      console.error(`check-ui-native: client/dist-ui/${page} is missing, run \`bun run build:ui\` first (or pass --src-only).`);
      process.exit(1);
    }
  }
  for (const file of walk(DIST, [".html"])) {
    buildFiles++;
    const html = readFileSync(file, "utf8");
    for (const m of html.matchAll(/<(select|datalist)\b|<input[^>]*type=["']?(date|time|datetime-local|month|week|color|range)\b|<[a-z][a-z0-9-]*\s[^>]*\stitle=/gi)) {
      hits.push(`${rel(file)} - ${m[0].slice(0, 60)}`);
    }
  }
  for (const file of walk(join(DIST, "assets"), [".js"])) {
    buildFiles++;
    const code = readFileSync(file, "utf8");
    const where = (i) => `${rel(file)}@${i}`;
    for (const m of code.matchAll(/\bjsxs?\("(select|datalist|option|optgroup)",/g)) hits.push(`${where(m.index)} - jsx("${m[1]}") in the bundle`);
    for (const m of code.matchAll(/\bjsxs?\("([a-z][a-z0-9-]*)",\{/g)) {
      if (m[1] === "svg") continue;
      const props = objectAt(code, m.index + m[0].length - 1);
      /* Only on the browser's own <input>: `type:"date"` handed to the layer's TextField draws the DatePicker, not a native field. */
      const native = m[1] === "input" && props.match(/(?:^|[{,])type:"(date|time|datetime-local|month|week|color|range)"/);
      if (native) hits.push(`${where(m.index)} - <input type="${native[1]}"> in the bundle`);
      if (hasTopKey(props, "title")) hits.push(`${where(m.index)} - title on <${m[1]}> in the bundle: ${props.slice(0, 90).replace(/\s+/g, " ")}`);
    }
  }
}

if (sourceFiles === 0 || elements === 0) {
  console.error("check-ui-native: read zero sources: a gate that scans nothing is green by accident.");
  process.exit(1);
}

if (hits.length) {
  console.error(`check-ui-native: ${hits.length} native controls or tooltips of the browser:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-ui-native: ok, ${sourceFiles} source files (${elements} lowercase elements)${srcOnly ? "" : ` and ${buildFiles} files of the build`}, no native control or tooltip`);
