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
 * Inside ONE router the first `if` that answers wins, in the order the code
 * runs: a literal route that an earlier `if` of the same function always
 * answers is dead too (findInnerShadows, which reads the code as it runs and
 * not the claims). Both kinds share KNOWN.
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

// --- shadowing inside one router --------------------------------------------

/*
 * The claims above are a flat list per router, which is right across routers
 * (the table runs them in order) and wrong inside one: whether an `if` hides
 * a later one depends on the code between them. So findInnerShadows reads the
 * code as it runs. For every literal route (`pathname === "/api/x/keep"` in
 * the && chain of an `if`) it asks: does an `if` that runs before it, in the
 * same function, always answer this path and method? The earlier condition is
 * evaluated on the literal path; whatever cannot be evaluated (a field of a
 * match, a call, a value known only at runtime) is unknown, and unknown is
 * never a finding. A wrong finding is a red run on correct code.
 */

/** A path test that held for the literal: what the finding names as the winner. */
interface Via { kind: ClaimKind; value: string }

/** The request being followed. `method` "*" stands for a method the code does not name. */
interface Req { path: string; method: string }

/**
 * How a statement ends for one request: always with a Response (or a throw),
 * by going on to the next statement or answering, or in a way the check does
 * not follow (`return null`, a call that may return null, break, continue).
 */
type Flow = "answers" | "goes-on" | "escapes";

function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isAwaitExpression(n)) n = n.expression;
  return n;
}

function statementsOf(n: ts.Node): readonly ts.Statement[] | null {
  if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) return n.statements;
  return null;
}

function bindsName(b: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(b)) return b.text === name;
  return b.elements.some((e) => !ts.isOmittedExpression(e) && bindsName(e.name, name));
}

function reassigned(name: string, scope: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    const target = ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? n.left
      : (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) ? n.operand
      : null;
    if (target && ts.isIdentifier(unwrap(target)) && (unwrap(target) as ts.Identifier).text === name) found = true;
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/**
 * The `const|let name = <init>` that `name` means at `from`, found the way the
 * language does: up the enclosing blocks, across function boundaries
 * (closures). Null when it is anything else: a parameter, a loop or catch
 * variable, a destructured name, a declaration after the use, or a `let` that
 * is assigned again.
 */
function declarationOf(name: string, from: ts.Node): ts.VariableDeclaration | null {
  let child: ts.Node = from;
  for (let n = from.parent; n; child = n, n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters.some((p) => bindsName(p.name, name))) return null;
    if (ts.isCatchClause(n) && n.variableDeclaration && bindsName(n.variableDeclaration.name, name)) return null;
    if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)
      && n.initializer.declarations.some((d) => bindsName(d.name, name))) return null;
    const list = statementsOf(n);
    if (!list) continue;
    const at = list.indexOf(child as ts.Statement);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!ts.isVariableStatement(s)) continue;
      for (const d of s.declarationList.declarations) {
        if (!bindsName(d.name, name)) continue;
        if (!ts.isIdentifier(d.name) || !d.initializer || at < 0 || i >= at) return null;
        const readOnly = (s.declarationList.flags & ts.NodeFlags.Const) !== 0;
        return readOnly || !reassigned(name, n) ? d : null;
      }
    }
  }
  return null;
}

function literalOf(node: ts.Node, depth = 0): string | null {
  const n = unwrap(node);
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isIdentifier(n) && depth < 3) {
    const d = declarationOf(n.text, n);
    return d?.initializer ? literalOf(d.initializer, depth + 1) : null;
  }
  return null;
}

function regexOf(node: ts.Node, depth = 0): RegExp | null {
  const n = unwrap(node);
  if (ts.isRegularExpressionLiteral(n)) return new RegExp(n.text.slice(1, n.text.lastIndexOf("/")), n.text.slice(n.text.lastIndexOf("/") + 1));
  if (ts.isIdentifier(n) && depth < 3) {
    const d = declarationOf(n.text, n);
    return d?.initializer ? regexOf(d.initializer, depth + 1) : null;
  }
  return null;
}

interface Truth { v: boolean | null; via?: Via }
const UNKNOWN: Truth = { v: null };
const held = (v: boolean, via: Via): Truth => (v ? { v, via } : { v });

/** The truth of a condition for `req`: true, false, or null when it depends on something else. */
function truthOf(node: ts.Node, req: Req, depth = 0): Truth {
  const n = unwrap(node);
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) {
    const r = truthOf(n.operand, req, depth);
    return r.v === null ? UNKNOWN : { v: !r.v };
  }
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      const a = truthOf(n.left, req, depth);
      const b = truthOf(n.right, req, depth);
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        if (a.v === false || b.v === false) return { v: false };
        return a.v && b.v ? { v: true, via: a.via ?? b.via } : UNKNOWN;
      }
      if (a.v) return a;
      if (b.v) return b;
      return a.v === false && b.v === false ? { v: false } : UNKNOWN;
    }
    if (EQ.has(op) || NOT_EQUAL.has(op)) {
      const notEqual = NOT_EQUAL.has(op);
      const methodSide = isMethodRef(n.left) ? n.right : isMethodRef(n.right) ? n.left : null;
      const pathSide = isPathRef(n.left) ? n.right : isPathRef(n.right) ? n.left : null;
      const lit = literalOf(methodSide ?? pathSide ?? n.right);
      if ((!methodSide && !pathSide) || lit === null) return UNKNOWN;
      const eq = methodSide ? req.method === lit.toUpperCase() : req.path === lit;
      return notEqual ? { v: !eq } : methodSide ? { v: eq } : held(eq, { kind: "exact", value: lit });
    }
    return UNKNOWN;
  }
  if (ts.isCallExpression(n)) {
    const called = n.expression;
    const name = ts.isIdentifier(called) ? called.text : ts.isPropertyAccessExpression(called) ? called.name.text : "";
    if (name === "matchRoute" && n.arguments.length >= 2 && isPathRef(n.arguments[0])) {
      const pattern = literalOf(n.arguments[1]);
      return pattern === null ? UNKNOWN : held(matchPattern(req.path, pattern), { kind: "pattern", value: pattern });
    }
    if (!ts.isPropertyAccessExpression(called) || n.arguments.length !== 1) return UNKNOWN;
    if (isPathRef(called.expression)) {
      if (name === "match") {
        const re = regexOf(n.arguments[0]);
        return re ? held(re.test(req.path), { kind: "regex", value: String(re) }) : UNKNOWN;
      }
      const s = literalOf(n.arguments[0]);
      if (s === null) return UNKNOWN;
      if (name === "startsWith") return held(req.path.startsWith(s), { kind: "prefix", value: s });
      if (name === "endsWith") return { v: req.path.endsWith(s) };
      if (name === "includes") return { v: req.path.includes(s) };
      return UNKNOWN;
    }
    if ((name === "test" || name === "exec") && isPathRef(n.arguments[0])) {
      const re = regexOf(called.expression);
      return re ? held(re.test(req.path), { kind: "regex", value: String(re) }) : UNKNOWN;
    }
    return UNKNOWN;
  }
  if (ts.isIdentifier(n) && depth < 3) {
    const d = declarationOf(n.text, n);
    return d?.initializer ? truthOf(d.initializer, req, depth + 1) : UNKNOWN;
  }
  return UNKNOWN;
}

/** A value that is a Response for sure: `json(...)`, `errorResponse(...)`, `new X(...)`, `Response.x(...)`. */
function isResponse(node: ts.Node): boolean {
  const n = unwrap(node);
  if (ts.isNewExpression(n)) return true;
  if (ts.isConditionalExpression(n)) return isResponse(n.whenTrue) && isResponse(n.whenFalse);
  if (!ts.isCallExpression(n)) return false;
  const c = n.expression;
  if (ts.isIdentifier(c)) return c.text === "json" || c.text === "errorResponse";
  return ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "Response";
}

function flowOf(stmt: ts.Statement, req: Req): { flow: Flow; via?: Via } {
  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) {
      const r = flowOf(s, req);
      if (r.flow !== "goes-on") return r;
    }
    return { flow: "goes-on" };
  }
  if (ts.isIfStatement(stmt)) {
    const c = truthOf(stmt.expression, req);
    if (c.v === true) {
      const t = flowOf(stmt.thenStatement, req);
      return t.flow === "answers" ? { flow: "answers", via: c.via ?? t.via } : t;
    }
    const e = stmt.elseStatement ? flowOf(stmt.elseStatement, req) : { flow: "goes-on" as Flow };
    if (c.v === false) return e;
    // Unknown: an answer only if both sides answer, and then the path test
    // that decided is not this one.
    const t = flowOf(stmt.thenStatement, req);
    if (t.flow === "escapes" || e.flow === "escapes") return { flow: "escapes" };
    return { flow: t.flow === "answers" && e.flow === "answers" ? "answers" : "goes-on" };
  }
  if (ts.isReturnStatement(stmt)) return { flow: stmt.expression && isResponse(stmt.expression) ? "answers" : "escapes" };
  if (ts.isThrowStatement(stmt)) return { flow: "answers" };
  if (ts.isTryStatement(stmt)) {
    // A finally that answers or escapes decides. Otherwise a throw out of the
    // try lands in the catch, and with no catch it leaves the router.
    const f = stmt.finallyBlock ? flowOf(stmt.finallyBlock, req) : { flow: "goes-on" as Flow };
    if (f.flow !== "goes-on") return f;
    const t = flowOf(stmt.tryBlock, req);
    const c = stmt.catchClause ? flowOf(stmt.catchClause.block, req) : { flow: "answers" as Flow };
    if (t.flow === "escapes" || c.flow === "escapes") return { flow: "escapes" };
    return t.flow === "answers" && c.flow === "answers" ? t : { flow: "goes-on" };
  }
  // Anything else (switch, loops): the request goes on, unless it can leave
  // in a way the check does not follow: a return that is not a Response, or a
  // break or continue that jumps out of this statement (labels are not used
  // in the routers, so a labelled jump counts as local).
  let flow: Flow = "goes-on";
  const visit = (n: ts.Node, inLoop: boolean, inSwitch: boolean) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && !(n.expression && isResponse(n.expression))) flow = "escapes";
    if (ts.isBreakStatement(n) && !inLoop && !inSwitch) flow = "escapes";
    if (ts.isContinueStatement(n) && !inLoop) flow = "escapes";
    const loop = ts.isIterationStatement(n, false);
    ts.forEachChild(n, (c) => visit(c, inLoop || loop, inSwitch || ts.isSwitchStatement(n)));
  };
  visit(stmt, false, false);
  return { flow };
}

/** Every method compared anywhere in `stmt`, for a literal route that accepts any method. */
function namedMethods(stmt: ts.Node): string[] {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isBinaryExpression(n) && (EQ.has(n.operatorToken.kind) || NOT_EQUAL.has(n.operatorToken.kind))) {
      const side = isMethodRef(n.left) ? n.right : isMethodRef(n.right) ? n.left : null;
      const lit = side && literalOf(side);
      if (lit) out.add(lit.toUpperCase());
    }
    ts.forEachChild(n, visit);
  };
  visit(stmt);
  return [...out];
}

function andOperands(node: ts.Node): ts.Node[] {
  const n = unwrap(node);
  return ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? [...andOperands(n.left), ...andOperands(n.right)] : [n];
}

/**
 * A literal route that an earlier statement of the same function (an `if`, or a
 * bare `{ }` block around one) always answers for its path and method.
 */
export function findInnerShadows(source: string, file: string, router: string): Overlap[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const out: Overlap[] = [];

  const check = (lit: ts.IfStatement, value: string) => {
    let methods: string[] | null = [...methodsIn(lit.expression), ...enclosingMethods(lit, sf)];
    if (!methods.length) methods = nestedMethods(lit.thenStatement);
    methods = methods.length ? [...new Set(methods)].sort() : null;
    let child: ts.Node = lit;
    for (let n = lit.parent; n && !ts.isFunctionLike(n); child = n, n = n.parent) {
      const list = statementsOf(n);
      if (!list) continue;
      for (const s of list.slice(0, list.indexOf(child as ts.Statement))) {
        const hits = (methods ?? [...namedMethods(s), "*"])
          .map((m) => ({ m, r: flowOf(s, { path: value, method: m }) }))
          .filter((h) => h.r.flow === "answers" && h.r.via);
        if (!hits.length) continue;
        const via = hits[0].r.via!;
        const firing = hits.map((h) => h.m);
        const shared = firing.includes("*") ? null : firing.sort();
        out.push({
          prior: { router, file, line: lineOf(s), kind: via.kind, value: via.value, methods: shared },
          later: { router, file, line: lineOf(lit), kind: "exact", value, methods },
          sample: value,
          methods: shared,
        });
        return;
      }
    }
  };

  const visit = (n: ts.Node) => {
    if (ts.isIfStatement(n) && !onlyReturnsNull(n.thenStatement)) {
      const value = andOperands(n.expression).map((o) => {
        if (!ts.isBinaryExpression(o) || !EQ.has(o.operatorToken.kind)) return null;
        const side = isPathRef(o.left) ? o.right : isPathRef(o.right) ? o.left : null;
        return side && literalOf(side);
      }).find((v) => v);
      if (value) check(n, value);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
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
export const KNOWN: KnownOverlap[] = [
  // Pending branch fix/keep-list-route: that branch moves the keep-list block
  // above `/api/browsers/:id`. Remove this entry in the same change, or the
  // run fails as stale.
  {
    prior: "browserRouter",
    later: "browserRouter",
    sample: "/api/browsers/data-store-keep-list",
    why: "GET /api/browsers/:id (browser.ts:229) hides the keep-list route (browser.ts:672) since 12/08; fix/keep-list-route",
  },
];

/**
 * KNOWN entries that matched nothing. An entry about a router this tree does
 * not have is not judged: KNOWN is global, and the bench trees of the test
 * file have other routers.
 */
export function staleKnown(known: KnownOverlap[], used: Set<KnownOverlap>, order: string[]): KnownOverlap[] {
  return known.filter((k) => !used.has(k) && order.includes(k.prior) && order.includes(k.later));
}

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
  const inner: Overlap[] = [];
  let opaque = 0;

  for (const [router, file] of files) {
    const claims: Claim[] = [];
    for (const f of withSubRouters(file)) {
      const src = readFileSync(f, "utf8");
      const r = extractClaims(src, f, router);
      claims.push(...r.claims);
      opaque += r.opaque;
      inner.push(...findInnerShadows(src, f, router));
    }
    claimsByRouter.set(router, claims);
  }

  const cross = findOverlaps(claimsByRouter, order);
  const overlaps = [...cross.overlaps, ...inner];
  const unsampled = cross.unsampled;
  const total = [...claimsByRouter.values()].reduce((n, c) => n + c.length, 0);

  if (all) for (const r of order) for (const c of claimsByRouter.get(r) ?? []) console.log(`claim  ${fmt(c)}`);

  const used = new Set<KnownOverlap>();
  const fresh: Overlap[] = [];
  for (const o of overlaps) {
    const k = KNOWN.find((k) => k.prior === o.prior.router && k.later === o.later.router && k.sample === o.sample);
    if (k) used.add(k);
    else fresh.push(o);
  }
  const stale = staleKnown(KNOWN, used, order);

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
