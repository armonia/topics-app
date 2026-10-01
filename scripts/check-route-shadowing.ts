#!/usr/bin/env bun
/**
 * scripts/check-route-shadowing.ts: report two routers that claim the same
 * method + path.
 *
 * `/api/*` requests walk the routers in `API_ROUTER_ORDER`
 * (server/route-table.ts) and the first non-null answer wins. A route that an
 * EARLIER router also claims is dead code at best, and at worst a feature that
 * silently stops working (d5f4ca354: the Context Inspector was off outside
 * openclaw). Nothing in the type system sees that, so this script reads the
 * route predicates of the real router sources and looks for overlaps.
 *
 * HOW. For each router in the table, the factory named in server.ts
 * (`const xRouter = createX(...)`) leads to its source file, plus the files of
 * the sub-routers it builds (topics composes chat, history, edit...). The
 * TypeScript AST of those files yields CLAIMS: a path predicate inside an `if`
 * that does not just `return null`, with the methods tested in that condition,
 * in the enclosing ones, or in the method checks right under it:
 *   pathname === "/api/a"              exact
 *   matchRoute(pathname, "/api/a/:id") pattern (one segment per :param)
 *   /^\/api\/a\/([^/]+)$/ on pathname  regex
 *   method === "X" && pathname.startsWith("/api/a/")  prefix
 * A negated predicate (`!pathname.startsWith(...)`, `!==`) is a gate, not a claim.
 * The inline checks in server.ts's fetch that run before the table stay out:
 * they are access gates (guest, origin, CORS) that answer only on refusal.
 *
 * Then every claim of a later router is turned into a concrete sample path and
 * offered to the claims of every prior router: a match with overlapping
 * methods is a finding. Claims whose methods could not be read count as "any
 * method", so the check errs toward reporting.
 *
 * KNOWN lists the overlaps that were reviewed and are intended (or reported and
 * left alone on purpose, precedence is not changed here). An overlap not in
 * KNOWN fails the run (exit 1); an entry of KNOWN that no longer matches
 * anything fails too, so the list cannot rot.
 *
 * Run: `bun run check:route-shadowing`        (exit 0 clean, 1 findings)
 *      `bun run check:route-shadowing --all`  (also print every claim)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import ts from "../client/node_modules/typescript";

// ROUTE_SHADOWING_ROOT points the check at another tree (its bench builds one).
const ROOT = process.env.ROUTE_SHADOWING_ROOT ? resolve(process.env.ROUTE_SHADOWING_ROOT) : resolve(import.meta.dir, "..");

/** `API_ROUTER_ORDER` as written in <root>/server/route-table.ts. */
function routerOrder(): string[] {
  const src = readFileSync(join(ROOT, "server", "route-table.ts"), "utf8");
  const list = src.match(/export const API_ROUTER_ORDER = \[([\s\S]*?)\] as const/);
  if (!list) throw new Error("check-route-shadowing: API_ROUTER_ORDER not found in server/route-table.ts");
  return [...list[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
}

export type ClaimKind = "exact" | "pattern" | "regex" | "prefix";

export interface Claim {
  router: string;
  file: string;
  line: number;
  kind: ClaimKind;
  value: string;
  /** Upper-case methods, or null when the predicate does not say (any method). */
  methods: string[] | null;
}

export interface Overlap {
  prior: Claim;
  later: Claim;
  sample: string;
  methods: string[] | null;
}

// --- extraction -------------------------------------------------------------

function isPathRef(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === "pathname";
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "pathname";
  return false;
}

function isMethodRef(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === "method";
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "method";
  return false;
}

function stripParens(node: ts.Node): ts.Node {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

const EQ = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken]);
const NOT_EQUAL = new Set([ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

interface Atom {
  node: ts.Node;
  kind: ClaimKind;
  value: string;
  negated: boolean;
}

/**
 * Per-file constants: `const X = "lit"` and `const RE = /.../` at any depth,
 * so `pathname.startsWith(PREFIX)` and `RE.exec(pathname)` resolve.
 */
function collectConstants(sf: ts.SourceFile): { strings: Map<string, string>; regexes: Map<string, string> } {
  const strings = new Map<string, string>();
  const regexes = new Map<string, string>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = stripParens(n.initializer);
      if (ts.isStringLiteralLike(init)) strings.set(n.name.text, init.text);
      if (ts.isRegularExpressionLiteral(init)) regexes.set(n.name.text, init.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { strings, regexes };
}

function stringValue(node: ts.Node, strings: Map<string, string>): string | null {
  const n = stripParens(node);
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isIdentifier(n) && strings.has(n.text)) return strings.get(n.text)!;
  return null;
}

function regexValue(node: ts.Node, regexes: Map<string, string>): string | null {
  const n = stripParens(node);
  if (ts.isRegularExpressionLiteral(n)) return n.text;
  if (ts.isIdentifier(n) && regexes.has(n.text)) return regexes.get(n.text)!;
  return null;
}

/** Is `node` under a logical `!` before reaching `stop`? */
function negatedWithin(node: ts.Node, stop: ts.Node): boolean {
  let n: ts.Node = node;
  while (n !== stop && n.parent) {
    const p = n.parent;
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
    n = p;
  }
  return false;
}

/** The path atom a node IS, if any. */
function atomOf(n: ts.Node, constants: ReturnType<typeof collectConstants>): Omit<Atom, "negated"> | null {
  if (ts.isBinaryExpression(n) && (EQ.has(n.operatorToken.kind) || NOT_EQUAL.has(n.operatorToken.kind))) {
    const lit = isPathRef(n.left) ? stringValue(n.right, constants.strings) : isPathRef(n.right) ? stringValue(n.left, constants.strings) : null;
    if (lit !== null && lit.startsWith("/")) return { node: n, kind: "exact", value: lit };
  }
  if (ts.isCallExpression(n)) {
    const called = n.expression;
    const calledName = ts.isIdentifier(called) ? called.text : ts.isPropertyAccessExpression(called) ? called.name.text : "";
    if (calledName === "matchRoute" && n.arguments.length >= 2 && isPathRef(n.arguments[0])) {
      const pat = stringValue(n.arguments[1], constants.strings);
      if (pat) return { node: n, kind: "pattern", value: pat };
    }
    if (ts.isPropertyAccessExpression(called)) {
      const m = called.name.text;
      if (m === "startsWith" && isPathRef(called.expression) && n.arguments[0]) {
        const lit = stringValue(n.arguments[0], constants.strings);
        if (lit) return { node: n, kind: "prefix", value: lit };
      }
      if (m === "match" && isPathRef(called.expression) && n.arguments[0]) {
        const re = regexValue(n.arguments[0], constants.regexes);
        if (re) return { node: n, kind: "regex", value: re };
      }
      if ((m === "exec" || m === "test") && n.arguments[0] && isPathRef(n.arguments[0])) {
        const re = regexValue(called.expression, constants.regexes);
        if (re) return { node: n, kind: "regex", value: re };
      }
    }
  }
  return null;
}

function atomsIn(expr: ts.Node, constants: ReturnType<typeof collectConstants>, bindings: Map<string, Atom[]>): Atom[] {
  const out: Atom[] = [];
  const visit = (n: ts.Node) => {
    const a = atomOf(n, constants);
    if (a) {
      const notEqual = ts.isBinaryExpression(n) && NOT_EQUAL.has(n.operatorToken.kind);
      out.push({ ...a, negated: notEqual || negatedWithin(n, expr) });
      return;
    }
    if (ts.isIdentifier(n) && bindings.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      const inverted = negatedWithin(n, expr);
      for (const b of bindings.get(n.text)!) out.push({ ...b, negated: b.negated !== inverted });
      return;
    }
    if (ts.isFunctionLike(n)) return;
    // A path value passed INTO a call (`levelFor(db, id)`) is data, not a test
    // of the path: only the called side keeps the predicate.
    if (ts.isCallExpression(n)) { visit(n.expression); return; }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return out;
}

function methodsIn(expr: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && EQ.has(n.operatorToken.kind)) {
      const lit = isMethodRef(n.left) ? stripParens(n.right) : isMethodRef(n.right) ? stripParens(n.left) : null;
      if (lit && ts.isStringLiteralLike(lit) && !negatedWithin(n, expr)) out.push(lit.text.toUpperCase());
    }
    if (ts.isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return out;
}

/** `method !== "X"` in a guard clause: the code after it serves X. */
function methodsRefusedIn(expr: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && NOT_EQUAL.has(n.operatorToken.kind)) {
      const lit = isMethodRef(n.left) ? stripParens(n.right) : isMethodRef(n.right) ? stripParens(n.left) : null;
      if (lit && ts.isStringLiteralLike(lit)) out.push(lit.text.toUpperCase());
    }
    if (ts.isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return out;
}

/** `if (...) return null;` and `if (...) { return null; }` let the request through. */
function onlyReturnsNull(stmt: ts.Statement): boolean {
  const body = ts.isBlock(stmt) ? (stmt.statements.length === 1 ? stmt.statements[0] : null) : stmt;
  if (!body || !ts.isReturnStatement(body)) return false;
  const e = body.expression && stripParens(body.expression);
  return !!e && (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined"));
}

/** Methods tested by the `if`s that enclose `node` on their then-branch. */
function enclosingMethods(node: ts.Node, root: ts.Node): string[] {
  const out: string[] = [];
  let n = node;
  while (n.parent && n !== root) {
    const p = n.parent;
    if (ts.isIfStatement(p) && p.thenStatement === n) out.push(...methodsIn(p.expression));
    if (ts.isFunctionLike(p)) break;
    n = p;
  }
  return out;
}

/** Methods tested by method-only `if`s directly inside a then-branch. */
function nestedMethods(stmt: ts.Statement): string[] {
  const statements = ts.isBlock(stmt) ? stmt.statements : ts.factory.createNodeArray([stmt]);
  const out: string[] = [];
  for (const s of statements) if (ts.isIfStatement(s)) out.push(...methodsIn(s.expression));
  return out;
}

export function extractClaims(source: string, file: string, router: string): { claims: Claim[]; opaque: number } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const constants = collectConstants(sf);
  const bindings = new Map<string, Atom[]>();
  const claims: Claim[] = [];
  let opaque = 0;
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const atoms = atomsIn(n.initializer, constants, bindings);
      if (atoms.length) bindings.set(n.name.text, atoms);
    }
    if (ts.isIfStatement(n)) {
      const atoms = atomsIn(n.expression, constants, bindings).filter((a) => !a.negated);
      if (atoms.length && !onlyReturnsNull(n.thenStatement)) {
        let methods = [...methodsIn(n.expression), ...enclosingMethods(n, sf)];
        if (!methods.length) methods = nestedMethods(n.thenStatement);
        const set = methods.length ? [...new Set(methods)].sort() : null;
        for (const a of atoms) {
          if (a.kind === "prefix" && !set) continue; // a bare prefix is a gate, not a route
          claims.push({ router, file, line: lineOf(n), kind: a.kind, value: a.value, methods: set });
        }
      }
    }
    // Guard clause: `if (pathname !== "/api/x") return null;` hands the rest
    // of the block to /api/x. A negated prefix stays a gate.
    if (ts.isIfStatement(n) && onlyReturnsNull(n.thenStatement)) {
      const guarded = atomsIn(n.expression, constants, bindings).filter((a) => a.negated && a.kind !== "prefix");
      if (guarded.length) {
        const methods = [...methodsRefusedIn(n.expression), ...enclosingMethods(n, sf)];
        if (!methods.length && ts.isBlock(n.parent)) {
          const rest = n.parent.statements.slice(n.parent.statements.indexOf(n) + 1);
          for (const r of rest) if (ts.isIfStatement(r)) methods.push(...methodsIn(r.expression));
        }
        const set = methods.length ? [...new Set(methods)].sort() : null;
        for (const a of guarded) claims.push({ router, file, line: lineOf(n), kind: a.kind, value: a.value, methods: set });
      }
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && isPathRef(n.expression.expression)) {
      const m = n.expression.name.text;
      if (m === "endsWith" || m === "includes" || m === "split") opaque++;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // One claim per (kind, value, methods): the same predicate repeated in a
  // router is that router's business, not an overlap.
  const seen = new Set<string>();
  return {
    claims: claims.filter((c) => {
      const k = `${c.kind} ${c.value} ${c.methods?.join(",") ?? "*"}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
    opaque,
  };
}

// --- matching -----------------------------------------------------------------

// Same algorithm as `matchRoute` in server/utils.ts (it lives inside
// createAppContext and cannot be imported without building a context).
function matchPattern(pathname: string, pattern: string): boolean {
  const pp = pattern.split("/");
  const xp = pathname.split("/");
  if (pp.length !== xp.length) return false;
  return pp.every((seg, i) => seg.startsWith(":") || seg === xp[i]);
}

export function claimMatches(c: Claim, path: string): boolean {
  switch (c.kind) {
    case "exact": return path === c.value;
    case "pattern": return matchPattern(path, c.value);
    case "prefix": return path.startsWith(c.value);
    case "regex": try { return new RegExp(c.value.slice(1, c.value.lastIndexOf("/")), c.value.slice(c.value.lastIndexOf("/") + 1)).test(path); } catch { return false; }
  }
}

/** A concrete path the claim accepts, or null when none could be built. */
export function sampleOf(c: Claim): string | null {
  let s: string;
  switch (c.kind) {
    case "exact": return c.value;
    case "pattern": s = c.value.split("/").map((seg) => (seg.startsWith(":") ? "s1" : seg)).join("/"); break;
    case "prefix": s = c.value + (c.value.endsWith("/") ? "s1" : "/s1"); break;
    case "regex": {
      let body = c.value.slice(1, c.value.lastIndexOf("/"));
      body = body.replace(/^\^/, "").replace(/\$$/, "");
      body = body
        .replace(/\(\?:[^()]*\)\?/g, "")            // optional groups: drop
        .replace(/\(\?<\w+>/g, "(")                 // named groups: plain
        .replace(/\(\?:/g, "(")
        .replace(/\[\^\/\]\+|\[\^\/\]\*|\\d\+|\[\\w-\]\+|\[\\w\.-\]\+|\[a-zA-Z0-9_-\]\+|\.\+|\.\*|\\w\+/g, "s1")
        .replace(/\(([^()|]*)\|[^()]*\)/g, "$1")   // alternation: first branch
        .replace(/[()]/g, "")
        .replace(/\\\//g, "/")
        .replace(/\\\./g, ".")
        .replace(/\\-/g, "-");
      s = body;
      break;
    }
  }
  return claimMatches(c, s) ? s : null;
}

function methodsOverlap(a: string[] | null, b: string[] | null): string[] | null | false {
  if (!a) return b;
  if (!b) return a;
  const both = a.filter((m) => b.includes(m));
  return both.length ? both : false;
}

/** Every later claim that an prior router also claims. `order` is precedence. */
export function findOverlaps(claimsByRouter: Map<string, Claim[]>, order: string[]): { overlaps: Overlap[]; unsampled: Claim[] } {
  const overlaps: Overlap[] = [];
  const unsampled: Claim[] = [];
  order.forEach((laterName, li) => {
    for (const later of claimsByRouter.get(laterName) ?? []) {
      const sample = sampleOf(later);
      if (sample === null) { unsampled.push(later); continue; }
      if (!sample.startsWith("/api/")) continue;
      for (const priorName of order.slice(0, li)) {
        for (const prior of claimsByRouter.get(priorName) ?? []) {
          if (!claimMatches(prior, sample)) continue;
          const methods = methodsOverlap(prior.methods, later.methods);
          if (methods === false) continue;
          overlaps.push({ prior, later, sample, methods });
        }
      }
    }
  });
  return { overlaps, unsampled };
}

// --- the real routers -----------------------------------------------------------

/** Router variable in server.ts -> factory source file. */
function routerFiles(serverSrc: string, order: string[]): Map<string, string> {
  const imports = new Map<string, string>();
  for (const m of serverSrc.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.\/server\/[^"]+)"/g)) {
    for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean)) imports.set(name, m[2]);
  }
  const out = new Map<string, string>();
  for (const name of order) {
    const def = serverSrc.match(new RegExp(`const ${name} = (?:[^;]*?\\? )?(create\\w+)\\(`));
    const spec = def && imports.get(def[1]);
    if (!spec) throw new Error(`check-route-shadowing: cannot find the factory of ${name} in server.ts`);
    out.set(name, resolveTs(join(ROOT, spec)));
  }
  return out;
}

function resolveTs(base: string): string {
  for (const f of [base, `${base}.ts`, join(base, "index.ts")]) if (existsSync(f) && f.endsWith(".ts")) return f;
  throw new Error(`check-route-shadowing: cannot resolve ${base}`);
}

/** The file plus the files of every sub-router factory it imports, transitively. */
function withSubRouters(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const src = readFileSync(file, "utf8");
  const out = [file];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.{1,2}\/[^"]+)"/g)) {
    if (!/\bcreate\w*Rout(?:er|es)\b/.test(m[1])) continue;
    out.push(...withSubRouters(resolveTs(join(dirname(file), m[2])), seen));
  }
  return out;
}

export interface KnownOverlap {
  prior: string;
  later: string;
  sample: string;
  why: string;
}

/**
 * Reviewed overlaps. Each one names the two routers and the sample path the
 * check builds, so the entry stops matching (and fails the run) when the code
 * it describes changes.
 */
export const KNOWN: KnownOverlap[] = [];

function fmt(c: Claim): string {
  return `${c.router} ${relative(ROOT, c.file)}:${c.line} ${c.methods?.join("|") ?? "ANY"} ${c.kind} ${c.value}`;
}

function main(): number {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--all");
  if (unknown.length) {
    console.error(`check-route-shadowing: unknown argument(s) ${unknown.join(" ")}; the only option is --all`);
    return 2;
  }
  const all = args.includes("--all");
  const order = routerOrder();
  const serverSrc = readFileSync(join(ROOT, "server.ts"), "utf8");
  const files = routerFiles(serverSrc, order);
  const claimsByRouter = new Map<string, Claim[]>();
  let opaque = 0;

  for (const [router, file] of files) {
    const claims: Claim[] = [];
    for (const f of withSubRouters(file)) {
      const r = extractClaims(readFileSync(f, "utf8"), f, router);
      claims.push(...r.claims);
      opaque += r.opaque;
    }
    claimsByRouter.set(router, claims);
  }

  const { overlaps, unsampled } = findOverlaps(claimsByRouter, order);
  const total = [...claimsByRouter.values()].reduce((n, c) => n + c.length, 0);

  if (all) for (const r of order) for (const c of claimsByRouter.get(r) ?? []) console.log(`claim  ${fmt(c)}`);

  const used = new Set<KnownOverlap>();
  const fresh: Overlap[] = [];
  for (const o of overlaps) {
    const k = KNOWN.find((k) => k.prior === o.prior.router && k.later === o.later.router && k.sample === o.sample);
    if (k) used.add(k);
    else fresh.push(o);
  }
  const stale = KNOWN.filter((k) => !used.has(k));

  console.log(`check-route-shadowing: ${order.length} routers, ${total} claims, ${overlaps.length} overlaps (${overlaps.length - fresh.length} known), ${unsampled.length} claims without a sample, ${opaque} opaque path reads (endsWith/includes/split)`);
  for (const c of unsampled) console.log(`  no sample: ${fmt(c)}`);
  for (const o of fresh) {
    console.log(`\nOVERLAP ${o.methods?.join("|") ?? "ANY"} ${o.sample}`);
    console.log(`  wins:   ${fmt(o.prior)}`);
    console.log(`  hidden: ${fmt(o.later)}`);
  }
  for (const k of stale) console.log(`\nSTALE known overlap (no longer found): ${k.prior} over ${k.later} at ${k.sample}`);
  if (fresh.length || stale.length) {
    console.log(`\n✗ ${fresh.length} unreviewed overlap(s), ${stale.length} stale KNOWN entr(y/ies). Review each: move the route, narrow the predicate, or add it to KNOWN in scripts/check-route-shadowing.ts with the reason.`);
    return 1;
  }
  console.log("✓ no unreviewed overlap between routers");
  return 0;
}

if (import.meta.main) process.exit(main());
