/**
 * @covers GATE-17
 */
import { describe, expect, test, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractClaims, findInnerShadows, findOverlaps, sampleOf, staleKnown, type Claim, type KnownOverlap } from "./check-route-shadowing";

function claimsOf(router: string, body: string): Claim[] {
  const src = `export function create(ctx: any) {
  const { matchRoute } = ctx;
  return async function r(req: Request, url: URL, pathname: string, method: string) {
${body}
    return null;
  };
}`;
  return extractClaims(src, `${router}.ts`, router).claims;
}

function overlapsOf(a: string, b: string) {
  const map = new Map([["a", claimsOf("a", a)], ["b", claimsOf("b", b)]]);
  return findOverlaps(map, ["a", "b"]).overlaps;
}

describe("check-route-shadowing", () => {
  test("the same method + exact path in two routers is an overlap, the earlier one wins", () => {
    const o = overlapsOf(
      `if (method === "GET" && pathname === "/api/x") return new Response("a");`,
      `if (method === "GET" && pathname === "/api/x") return new Response("b");`,
    );
    expect(o).toHaveLength(1);
    expect(o[0].prior.router).toBe("a");
    expect(o[0].later.router).toBe("b");
    expect(o[0].methods).toEqual(["GET"]);
  });

  test("a matchRoute pattern hides an exact path of a later router", () => {
    const o = overlapsOf(
      `const m = matchRoute(pathname, "/api/x/:id");\n    if (m && method === "PATCH") return new Response("a");`,
      `if (method === "PATCH" && pathname === "/api/x/special") return new Response("b");`,
    );
    expect(o.map((x) => x.sample)).toEqual(["/api/x/special"]);
  });

  test("a regex claim is sampled and matched", () => {
    const o = overlapsOf(
      `if (method === "POST" && pathname.match(/^\\/api\\/y\\/([^/]+)\\/run$/)) return new Response("a");`,
      `const m = matchRoute(pathname, "/api/y/:id/run");\n    if (m && method === "POST") return new Response("b");`,
    );
    expect(o).toHaveLength(1);
  });

  test("different methods on the same path do not overlap", () => {
    expect(overlapsOf(
      `if (method === "GET" && pathname === "/api/x") return new Response("a");`,
      `if (method === "POST" && pathname === "/api/x") return new Response("b");`,
    )).toEqual([]);
  });

  test("a guard clause claims its path for the rest of the block", () => {
    const o = overlapsOf(
      `if (method === "GET" && pathname === "/api/open") return new Response("a");`,
      `if (method !== "GET" || pathname !== "/api/open") return null;\n    return new Response("b");`,
    );
    expect(o).toHaveLength(1);
    expect(o[0].later.methods).toEqual(["GET"]);
  });

  test("a predicate that only returns null, or a negated prefix gate, claims nothing", () => {
    const later = claimsOf("b", `if (!pathname.startsWith("/api/x/")) return null;\n    if (method === "POST" && pathname.endsWith("/approve")) return null;`);
    expect(later).toEqual([]);
  });

  test("a path value passed into a call is data, not a predicate", () => {
    const c = claimsOf("a", `const m = matchRoute(pathname, "/api/z/:id");\n    const level = lookup(m);\n    if (level === null) return new Response("403");`);
    expect(c).toEqual([]);
  });

  // people.ts shape (server/routes/people.ts:455): a refusal guard, a self
  // check, DELETE, then the rest. The block claim reads as DELETE only; what
  // covers POST is the field read `p.id === io`, a claim ANY. The cross-router
  // check must keep it, or a later router's POST on the same path goes unseen.
  const FOLLOW_BLOCK = [
    'const p = matchRoute(pathname, "/api/people/:id/follow");',
    "if (p) {",
    '  if (method !== "POST" && method !== "DELETE") return errorResponse(405, "x");',
    '  if (p.id === io) return errorResponse(400, "y");',
    '  if (method === "DELETE") { return json({}); }',
    "  return json({});",
    "}",
  ].join("\n    ");

  test("a later router's POST route behind the people.ts block is an overlap", () => {
    const o = overlapsOf(FOLLOW_BLOCK, `if (method === "POST" && pathname === "/api/people/me/follow") return new Response("dead");`);
    expect(o.map((x) => x.methods)).toEqual([["POST"]]);
  });

  describe("shadowing inside one router", () => {
    const inner = (lines: string[]) => findInnerShadows(`export function create(ctx: any) {
  return async function r(req: Request, url: URL, pathname: string, method: string) {
    ${lines.join("\n    ")}
    return null;
  };
}`, "a.ts", "a");
    const MATCH = 'const m = matchRoute(pathname, "/api/x/:id");';
    const LITERAL = 'if (method === "GET" && pathname === "/api/x/keep") return json({});';
    const shadowed = (lines: string[]) => inner(lines).map((o) => o.sample);

    // browser.ts:228-242 as it is, with the keep-list route (browser.ts:672) below it.
    const BY_ID = [
      'const getMatch = matchRoute(pathname, "/api/browsers/:id");',
      'if (method === "GET" && getMatch && !pathname.includes("/snapshot") && !pathname.includes("/console") && !pathname.includes("/interact")) {',
      "  if (nativeHosts?.isHosting(getMatch.id)) {",
      "    const page = nativeHosts.page(getMatch.id);",
      '    return page ? json(page) : errorResponse(409, "host page not known yet", { log: false });',
      "  }",
      "  const info = browserService.getUrl(getMatch.id);",
      '  if (!info) return errorResponse(404, "Browser context not found", { log: false });',
      "  return json(info);",
      "}",
    ];

    test("the keep-list route below GET /api/browsers/:id is a finding, named at both lines", () => {
      const o = inner([...BY_ID, 'if (method === "GET" && pathname === "/api/browsers/data-store-keep-list") return json({});']);
      expect(o).toHaveLength(1);
      expect(o[0]).toMatchObject({ sample: "/api/browsers/data-store-keep-list", methods: ["GET"] });
      expect(o[0].prior).toMatchObject({ kind: "pattern", value: "/api/browsers/:id", line: 4 });
      expect(o[0].later).toMatchObject({ kind: "exact", line: 13, methods: ["GET"] });
    });

    test("the exclusions of the earlier condition are evaluated on the literal", () => {
      expect(shadowed([...BY_ID, 'if (method === "GET" && pathname === "/api/browsers/snapshot") return json({});'])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "GET" && !pathname.endsWith("/keep")) return json({});', LITERAL])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "GET" && pathname !== "/api/x/keep") return json({});', LITERAL])).toEqual([]);
    });

    // people.ts:455-462 as a whole: the 405 guard and the self check do not
    // stop the block from answering POST, so a POST route below it is dead.
    test("a refusal guard inside the earlier block is evaluated for the literal's method", () => {
      const o = inner([FOLLOW_BLOCK, 'if (method === "POST" && pathname === "/api/people/me/follow") return json({});']);
      expect(o.map((x) => [x.sample, x.methods, x.prior.line])).toEqual([["/api/people/me/follow", ["POST"], 4]]);
      expect(shadowed([FOLLOW_BLOCK, 'if (method === "PUT" && pathname === "/api/people/me/follow") return json({});'])).toEqual(["/api/people/me/follow"]);
    });

    test("the same literal above the pattern, or in the same if, or a literal that answers null, is not a finding", () => {
      expect(shadowed([LITERAL, MATCH, 'if (m && method === "GET") return json({});'])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "GET") return json({});', 'if (method === "GET" && pathname === "/api/x/keep") return null;'])).toEqual([]);
      expect(shadowed(['if ((matchRoute(pathname, "/api/x/:id") || pathname === "/api/x/keep") && method === "GET") return json({});'])).toEqual([]);
    });

    test("a field of the match is never the test of the path", () => {
      for (const prior of [
        'if (m.id === io && method === "GET") return json({});',
        'if (m?.id && method === "GET") return json({});',
        'if (m["id"] === io && method === "GET") return json({});',
        'const topic = data[m.id];\n    if (topic && method === "GET") return json({});',
      ]) expect(shadowed([MATCH, prior, LITERAL])).toEqual([]);
      expect(shadowed(['const { id: m } = matchRoute(pathname, "/api/x/:id");', 'if (m && method === "GET") return json({});', LITERAL])).toEqual([]);
    });

    // topics.ts:2042-2061 with the line a reviewer injected after :2050: a
    // self-link check on two topics read from the match and the body.
    test("the topics.ts link block with a self-link check does not hide /api/topics/reorder", () => {
      expect(shadowed([
        "{",
        '  const params = matchRoute(pathname, "/api/topics/:id/link");',
        '  if (params && method === "POST") {',
        "    const body = await readJSON(req);",
        '    if (!body || !body.targetId) return json({ error: "targetId required" }, 400);',
        "    const topic = getTopicById(params.id);",
        "    const target = getTopicById(body.targetId);",
        '    if (!topic || !target) return json({ error: "not found" }, 404);',
        '    if (topic && target && topic.id === target.id) return json({ error: "cannot link a topic to itself" }, 400);',
        "    return json({ ok: true });",
        "  }",
        "}",
        'if (method === "POST" && pathname === "/api/topics/reorder") return json({});',
      ])).toEqual([]);
    });

    test("an earlier if that does not always answer is not a finding", () => {
      for (const body of [
        "{ log(m.id); }",
        "{ if (!ok) return null; return json({}); }",
        "return sub(req);",
        "return routes.handle(req);",
        "return ok ? json({}) : null;",
        "{ if (fresh) return json({}); }",
        '{ switch (kind) { case "a": return null; } return json({}); }',
        '{ for (const x of list) { if (x) continue; } if (done) break; return json({}); }',
      ]) expect(shadowed([MATCH, `if (m && method === "GET") ${body}`, LITERAL])).toEqual([]);
    });

    test("a condition that depends on something else is not a finding", () => {
      expect(shadowed([MATCH, 'if (m && method === "GET" && isReady()) return json({});', LITERAL])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "GET" && !isLocked()) return json({});', LITERAL])).toEqual([]);
      expect(shadowed(['if (method === "GET" && pathname.startsWith("/api/y/")) return json({});', LITERAL])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "POST") return json({});', LITERAL])).toEqual([]);
    });

    test("the match is the one the literal's scope sees", () => {
      // A same-named binding in a sibling block, a loop variable, a later
      // declaration, or a `let` assigned again: not the match.
      expect(shadowed(["{ " + MATCH + " }", 'if (m && method === "GET") return json({});', LITERAL])).toEqual([]);
      expect(shadowed([MATCH, '{ const m = other(); if (m && method === "GET") return json({}); }', LITERAL])).toEqual([]);
      expect(shadowed(['if (m && method === "GET") return json({});', MATCH, LITERAL])).toEqual([]);
      expect(shadowed(['let m = matchRoute(pathname, "/api/x/:id");', "if (stale) m = null;", 'if (m && method === "GET") return json({});', LITERAL])).toEqual([]);
      expect(shadowed([MATCH, 'for (const m of list) { if (m && method === "GET") return json({}); ' + LITERAL + " }"])).toEqual([]);
      expect(shadowed([MATCH, 'try { run(); } catch (m) { if (m && method === "GET") return json({}); ' + LITERAL + " }"])).toEqual([]);
      expect(shadowed([MATCH, '{ const { m } = other; if (m && method === "GET") return json({}); }', LITERAL])).toEqual([]);
      // A continue out of the earlier block skips it, so it does not answer.
      expect(shadowed([`for (const k of keys) { ${MATCH} if (m && method === "GET") { switch (k) { case "a": continue; } return json({}); } ${LITERAL} }`])).toEqual([]);
      expect(shadowed([MATCH, 'const each = (m: unknown) => { if (m && method === "GET") return json({}); ' + LITERAL + " };"])).toEqual([]);
      // Through an alias it is.
      expect(shadowed(['const pm = matchRoute(pathname, "/api/x/:id");', "const m = pm;", 'if (m && method === "GET") return json({});', LITERAL])).toEqual(["/api/x/keep"]);
    });

    test("an if in another function is not on the literal's path", () => {
      expect(shadowed([MATCH, 'const later = () => { if (m && method === "GET") return json({}); };', LITERAL])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "GET") return json({});', `await withLock(async () => { ${LITERAL} });`])).toEqual([]);
    });

    test("every way to say the path is read, at any depth of the earlier statement", () => {
      for (const prior of [
        'if (matchRoute(pathname, "/api/x/:id") && method === "GET") return json({});',
        'if (method === "GET" && pathname.startsWith("/api/x/")) return json({});',
        'if (method === "GET" && /^\\/api\\/x\\/[^/]+$/.test(pathname)) return json({});',
        `if (method === "GET") { ${MATCH} if (m) return json({}); }`,
        `{ ${MATCH} if (m && method === "GET") { if (fresh) return json({}); else return new Response("old"); } }`,
        `${MATCH} if ((m as Match) && (method === "HEAD" || method === "GET")) return await json({});`,
        `${MATCH} if (m && method === "GET") { if (!ok) throw new Error("x"); return Response.json({}); }`,
        `${MATCH} if (m && method === "GET") { try { return json(await load()); } catch { return errorResponse(500, "x"); } }`,
        'if (method === "GET" && pathname.match(/^\\/api\\/x\\/[^/]+$/)) return json({});',
        'if (method === "GET" && /^\\/api\\/x\\/[^/]+$/.exec(pathname)) return json({});',
        'if (method === "GET" && pathname === "/api/x/keep") return json({ first: true });',
        `switch (kind) { default: ${MATCH} if (m && method === "GET") return json({}); ${LITERAL} }`,
        // Guards that do not hold for GET, and code that cannot leave the block.
        `${MATCH} if (m) { if (method !== "GET") return null; return json({}); }`,
        `${MATCH} if (m) { if (method === "POST" && isAdmin()) return null; return json({}); }`,
        `${MATCH} if (m) { if (method === "POST" || method === "PUT") return null; return json({}); }`,
        `${MATCH} if (m && method === "GET" && !pathname.endsWith("/snapshot")) return json({});`,
        `${MATCH} if (m && method === "GET") { const ids = list.filter((x) => { if (!x) return false; return true; }); return json(ids); }`,
        `${MATCH} if (m && method === "GET") { switch (kind) { case "a": log(); break; } for (const x of list) { if (!x) continue; if (x.done) break; } return json({}); }`,
        `${MATCH} if (m && method === "GET") { switch (kind) { case "a": return json({ a: true }); } return json({}); }`,
      ]) expect(shadowed(prior.startsWith("switch") ? [prior] : [prior, LITERAL])).toEqual(["/api/x/keep"]);
    });

    test("a try answers when its body and its catch do, and a finally can decide", () => {
      const at = (body: string) => shadowed([MATCH, `if (m && method === "GET") { ${body} }`, LITERAL]);
      expect(at("try { return json({}); } catch { log(); }")).toEqual([]);
      expect(at("try { return json({}); } finally { done(); }")).toEqual(["/api/x/keep"]);
      expect(at("try { return json({}); } catch { return errorResponse(500, \"x\"); } finally { if (stop) return null; }")).toEqual([]);
      expect(at("try { log(); } catch { log(); } finally { return json({}); }")).toEqual(["/api/x/keep"]);
    });

    test("module constants name the pattern and the regex", () => {
      const src = (route: string) => findInnerShadows(`const BY_ID = "/api/x/:id";
const RE = /^\\/api\\/y\\/[^/]+$/;
export function create(ctx: any) {
  return async function r(req: Request, url: URL, pathname: string, method: string) {
    ${route}
    if (method === "GET" && pathname === "/api/x/keep") return json({});
    if (method === "GET" && pathname === "/api/y/keep") return json({});
    return null;
  };
}`, "a.ts", "a").map((o) => o.sample);
      expect(src('const m = matchRoute(pathname, BY_ID);\n    if (m && method === "GET") return json({});')).toEqual(["/api/x/keep"]);
      expect(src('if (method === "GET" && RE.test(pathname)) return json({});')).toEqual(["/api/y/keep"]);
    });

    test("one finding per literal, the first earlier statement that answers it", () => {
      const o = inner([MATCH, 'if (m && method === "GET") return json({});', 'if (method === "GET" && pathname.startsWith("/api/x/")) return json({});', LITERAL]);
      expect(o.map((x) => [x.prior.kind, x.prior.line])).toEqual([["pattern", 4]]);
    });

    test("a literal that takes any method is shadowed for the methods the earlier if answers", () => {
      const o = inner([MATCH, 'if (m && method === "GET") return json({});', 'if (pathname === "/api/x/keep") return json({});']);
      expect(o.map((x) => [x.methods, x.later.methods])).toEqual([[["GET"], null]]);
      expect(inner([MATCH, "if (m) return json({});", 'if (pathname === "/api/x/keep") return json({});']).map((x) => x.methods)).toEqual([null]);
    });

    test("the literal's methods come from its own if, the ifs around it, or the ifs inside it", () => {
      const GET_PRIOR = 'if (m && method === "GET") return json({});';
      expect(shadowed([MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { if (method === "POST") return json({}); return errorResponse(405, "x"); }'])).toEqual([]);
      expect(shadowed([MATCH, GET_PRIOR, 'if (method === "POST") { if (pathname === "/api/x/keep") return json({}); }'])).toEqual([]);
    });
  });

  test("samples are paths the claim itself accepts", () => {
    for (const c of [
      ...claimsOf("a", `if (method === "GET" && pathname.match(/^\\/api\\/q\\/([^/]+)\\/browser(?:\\/|$)/)) return new Response("a");`),
      ...claimsOf("a", `if (method === "PUT" && pathname.startsWith("/api/p/")) return new Response("a");`),
    ]) expect(sampleOf(c)).not.toBeNull();
  });

  // The real script on a tree built around the defect (GATE-01): exit code and
  // the file:line of both claims.
  describe("the real script", () => {
    const SCRIPT = resolve(import.meta.dir, "check-route-shadowing.ts");
    const roots: string[] = [];
    afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

    function tree(laterBody: string): string {
      const root = mkdtempSync(join(tmpdir(), "route-shadowing-"));
      roots.push(root);
      mkdirSync(join(root, "server", "routes"), { recursive: true });
      writeFileSync(join(root, "server", "route-table.ts"), 'export const API_ROUTER_ORDER = [\n  "aRouter",\n  "bRouter",\n] as const;\n');
      writeFileSync(join(root, "server.ts"), [
        'import { createARouter } from "./server/routes/a";',
        'import { createBRouter } from "./server/routes/b";',
        "const aRouter = createARouter(ctx);",
        "const bRouter = createBRouter(ctx);",
      ].join("\n"));
      const router = (name: string, body: string) =>
        `export function create${name}Router(ctx: any) {\n  return async function r(req: Request, url: URL, pathname: string, method: string) {\n${body}\n    return null;\n  };\n}\n`;
      writeFileSync(join(root, "server", "routes", "a.ts"), router("A", '    if (method === "GET" && pathname === "/api/x") return new Response("a");'));
      writeFileSync(join(root, "server", "routes", "b.ts"), router("B", laterBody));
      return root;
    }

    const run = (root: string, args: string[] = []) =>
      spawnSync("bun", ["run", SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ROUTE_SHADOWING_ROOT: root } });

    test("an overlap exits 1 and names both files with their lines", () => {
      const r = run(tree('    if (method === "GET" && pathname === "/api/x") return new Response("b");'));
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("OVERLAP GET /api/x");
      expect(r.stdout).toContain("aRouter server/routes/a.ts:3");
      expect(r.stdout).toContain("bRouter server/routes/b.ts:3");
    });

    test("a clean tree exits 0", () => {
      const r = run(tree('    if (method === "POST" && pathname === "/api/x") return new Response("b");'));
      expect(r.stdout).toContain("2 routers, 2 claims, 0 overlaps");
      expect(r.status).toBe(0);
    });

    test("an unknown argument is an error, not a green run", () => {
      expect(run(tree(""), ["--bogus"]).status).toBe(2);
    });

    // The stale filter, on its own: only routers this tree has are judged.
    test("staleKnown judges an entry only when both of its routers are in the tree", () => {
      const k = (prior: string, later: string): KnownOverlap => ({ prior, later, sample: "/api/x", why: "t" });
      const both = k("a", "b");
      expect(staleKnown([both], new Set(), ["a", "b"])).toEqual([both]);
      expect(staleKnown([both], new Set([both]), ["a", "b"])).toEqual([]);
      expect(staleKnown([k("a", "gone")], new Set(), ["a"])).toEqual([]);
      expect(staleKnown([k("gone", "a")], new Set(), ["a"])).toEqual([]);
    });

    // KNOWN is global and names the browser router; a tree that has one and
    // does not shadow anything must fail as stale, or the list rots.
    describe("the KNOWN list", () => {
      function browserTree(body: string): string {
        const root = mkdtempSync(join(tmpdir(), "route-shadowing-"));
        roots.push(root);
        mkdirSync(join(root, "server", "routes"), { recursive: true });
        writeFileSync(join(root, "server", "route-table.ts"), 'export const API_ROUTER_ORDER = [\n  "browserRouter",\n] as const;\n');
        writeFileSync(join(root, "server.ts"), 'import { createBrowserRouter } from "./server/routes/browser";\nconst browserRouter = createBrowserRouter(ctx);\n');
        writeFileSync(join(root, "server", "routes", "browser.ts"), [
          "export function createBrowserRouter(ctx: any) {",
          "  return async function r(req: Request, url: URL, pathname: string, method: string) {",
          body,
          "    return null;",
          "  };",
          "}",
          "",
        ].join("\n"));
        return root;
      }

      test("an entry that no longer matches anything fails the run as stale", () => {
        const r = run(browserTree('    if (method === "GET" && pathname === "/api/browsers/data-store-keep-list") return new Response("literal");'));
        expect(r.stdout).toContain("STALE known overlap");
        expect(r.status).toBe(1);
      });

      test("an entry that still matches is reported as known and the run passes", () => {
        const r = run(browserTree([
          '    const m = matchRoute(pathname, "/api/browsers/:id");',
          '    if (m && method === "GET") return new Response("pattern");',
          '    if (method === "GET" && pathname === "/api/browsers/data-store-keep-list") return new Response("literal");',
        ].join("\n")));
        expect(r.stdout).toContain("1 overlaps (1 known)");
        expect(r.status).toBe(0);
      });
    });

    // One router only: a route can be shadowed by a pattern of the SAME router,
    // in the order of its if chain (browser.ts: GET /api/browsers/:id hid
    // GET /api/browsers/data-store-keep-list from 12/08).
    describe("shadowing inside one router", () => {
      function oneRouterTree(body: string): string {
        const root = mkdtempSync(join(tmpdir(), "route-shadowing-"));
        roots.push(root);
        mkdirSync(join(root, "server", "routes"), { recursive: true });
        writeFileSync(join(root, "server", "route-table.ts"), 'export const API_ROUTER_ORDER = [\n  "aRouter",\n] as const;\n');
        writeFileSync(join(root, "server.ts"), 'import { createARouter } from "./server/routes/a";\nconst aRouter = createARouter(ctx);\n');
        writeFileSync(join(root, "server", "routes", "a.ts"), [
          "export function createARouter(ctx: any) {",
          "  return async function r(req: Request, url: URL, pathname: string, method: string) {",
          body,
          "    return null;",
          "  };",
          "}",
          "",
        ].join("\n"));
        return root;
      }

      test("a literal GET path below a :param pattern that captures it is a finding", () => {
        const r = run(oneRouterTree([
          '    const m = matchRoute(pathname, "/api/x/:id");',
          '    if (m && method === "GET") return new Response("pattern");',
          '    if (method === "GET" && pathname === "/api/x/keep-list") return new Response("literal");',
        ].join("\n")));
        expect(r.stdout).toContain("OVERLAP GET /api/x/keep-list");
        expect(r.status).toBe(1);
      });

      test("the same literal above the pattern is reachable and not a finding", () => {
        const r = run(oneRouterTree([
          '    if (method === "GET" && pathname === "/api/x/keep-list") return new Response("literal");',
          '    const m = matchRoute(pathname, "/api/x/:id");',
          '    if (m && method === "GET") return new Response("pattern");',
        ].join("\n")));
        expect(r.stdout).toContain("0 overlaps");
        expect(r.status).toBe(0);
      });

      test("a field read between the pattern and the literal is not a finding", () => {
        const r = run(oneRouterTree([
          '    const m = matchRoute(pathname, "/api/x/:id");',
          '    const topic = data[m.id];',
          '    if (topic.kind === "x" && method === "GET") return new Response("field");',
          '    if (method === "GET" && pathname === "/api/x/keep-list") return new Response("literal");',
        ].join("\n")));
        expect(r.stdout).toContain("0 overlaps");
        expect(r.status).toBe(0);
      });

      test("a literal under a pattern for a different method is not a finding", () => {
        const r = run(oneRouterTree([
          '    const m = matchRoute(pathname, "/api/x/:id");',
          '    if (m && method === "POST") return new Response("pattern");',
          '    if (method === "GET" && pathname === "/api/x/keep-list") return new Response("literal");',
        ].join("\n")));
        expect(r.stdout).toContain("0 overlaps");
        expect(r.status).toBe(0);
      });
    });
  });
});
