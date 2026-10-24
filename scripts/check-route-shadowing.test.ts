/**
 * @covers GATE-17
 */
import { describe, expect, test, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractClaims, findInnerShadows, findOverlaps, knownFor, sampleOf, staleKnown, type Claim, type KnownOverlap, type Overlap } from "./check-route-shadowing";

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

  // server/routes/people.ts:456-510 as it is, comments dropped: a refusal
  // guard, the caller check, a self check, a closure, DELETE, then the POST,
  // both ending in `return outcome()`. The block claim reads as DELETE only;
  // what covers POST is the field read `pFollow.id === io`, a claim ANY. The
  // cross-router check must keep it, or a later router's POST on the same
  // path goes unseen.
  const FOLLOW_BLOCK = [
    'const pFollow = matchRoute(pathname, "/api/people/:id/follow");',
    "if (pFollow) {",
    '  if (method !== "POST" && method !== "DELETE") return errorResponse(405, "method not allowed");',
    '  if (io === null) return errorResponse(401, "unknown caller");',
    '  if (pFollow.id === io) return errorResponse(400, "cannot follow yourself");',
    "  const outcome = (): Response => {",
    "    const b = target(pFollow.id, io);",
    "    return json({",
    "      following: segue(db as never, io, pFollow.id),",
    "      counts: b && (b.isMe || b.privacy.showFollowers) ? countFollows(db as never, pFollow.id, io) : null,",
    "    });",
    "  };",
    '  if (method === "DELETE") {',
    "    unfollow(db as never, io, pFollow.id);",
    "    return outcome();",
    "  }",
    "  const b = target(pFollow.id, io);",
    '  if (!b) return errorResponse(404, "Person not found");',
    "  follow(db as never, io, b.row.id);",
    "  return outcome();",
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

    // people.ts:456-510 as a whole: the 405 guard, the caller and self checks
    // do not stop the block from leaving on POST (through `return outcome()`),
    // so a POST route below it is dead; and on PUT the 405 leaves too.
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

    // topics.ts:2042-2061, with the writes of :2051-2059 replaced by the line a
    // reviewer injected after :2050: a self-link check on two topics read from
    // the match and the body.
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

    test("an earlier if that may go on is not a finding", () => {
      for (const body of [
        "{ log(m.id); }",
        "{ if (fresh) return json({}); }",
        '{ switch (kind) { case "a": return json({}); } }',
        "{ for (const x of list) { if (x) break; return json({}); } }",
        "{ while (busy) { if (done) continue; return json({}); } }",
      ]) expect(shadowed([MATCH, `if (m && method === "GET") ${body}`, LITERAL])).toEqual([]);
    });

    // A break or continue that leaves the earlier statement lands past the
    // literal, which is inside the same loop or switch: dead as with a return.
    test("a break or continue out of the earlier statement skips the literal too", () => {
      for (const lines of [
        [`for (const k of keys) { ${MATCH} if (k) continue; if (m && method === "GET") return json({}); ${LITERAL} }`],
        [`for (const k of keys) { if (pathname.startsWith("/api/x/")) break; ${LITERAL} }`],
        [`for (const k of keys) { if (pathname.startsWith("/api/x/")) continue; ${LITERAL} }`],
        [`switch (kind) { case "a": ${MATCH} if (m && method === "GET") break; ${LITERAL} }`],
        [`for (const k of keys) { ${MATCH} if (m && method === "GET") { for (const x of list) { if (x) break; } if (done) break; return json({}); } ${LITERAL} }`],
      ]) expect(shadowed(lines)).toEqual(["/api/x/keep"]);
    });

    // Any return leaves the function, whatever it returns: the idioms of the
    // real routers (goals.ts:79 `return denied`, memory.ts:127 `return target`,
    // tasks-board.ts:230 `return fail(e)`, people.ts:509 `return outcome()`).
    test("a return of any value leaves the function, so the literal below is dead", () => {
      for (const body of [
        "return null;",
        "{ if (!ok) return null; return json({}); }",
        "return sub(req);",
        "return routes.handle(req);",
        "return ok ? json({}) : null;",
        '{ switch (kind) { case "a": return null; } return json({}); }',
        "{ const denied = deny(m.id); if (denied) return denied; return json({}); }",
        "{ const target = resolve(m.id); if (target instanceof Response) return target; return json(target); }",
        "{ try { return json(load(m.id)); } catch (e) { return fail(e); } }",
        "{ const outcome = (): Response => json({}); if (method === \"GET\") return outcome(); }",
        '{ throw new Error("x"); }',
        '{ if (!ok) throw new Error("x"); throw new Error("y"); }',
      ]) expect(shadowed([MATCH, `if (m && method === "GET") ${body}`, LITERAL])).toEqual(["/api/x/keep"]);
    });

    test("a condition that depends on something else is not a finding", () => {
      expect(shadowed([MATCH, 'if (m && method === "GET" && isReady()) return json({});', LITERAL])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "GET" && !isLocked()) return json({});', LITERAL])).toEqual([]);
      expect(shadowed(['if (method === "GET" && pathname.startsWith("/api/y/")) return json({});', LITERAL])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "POST") return json({});', LITERAL])).toEqual([]);
      // Both branches leave, but the one with no path test is a gate.
      expect(shadowed([MATCH, 'if (ready) { if (m && method === "GET") return json({}); return null; } else return null;', LITERAL])).toEqual([]);
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
      // A continue out of the earlier block skips the literal as the return does.
      expect(shadowed([`for (const k of keys) { ${MATCH} if (m && method === "GET") { switch (k) { case "a": continue; } return json({}); } ${LITERAL} }`])).toEqual(["/api/x/keep"]);
      expect(shadowed([MATCH, 'const each = (m: unknown) => { if (m && method === "GET") return json({}); ' + LITERAL + " };"])).toEqual([]);
      // A `let` never assigned again is, and so is an alias.
      expect(shadowed(['let m = matchRoute(pathname, "/api/x/:id");', 'if (m && method === "GET") return json({});', LITERAL])).toEqual(["/api/x/keep"]);
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
        `${MATCH} try { if (m && method === "GET") return json({}); } catch (e) { return fail(e); }`,
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
      expect(at("try { return json({}); } catch { return errorResponse(500, \"x\"); } finally { if (stop) return null; }")).toEqual(["/api/x/keep"]);
      expect(at("try { log(); } catch { log(); } finally { return json({}); }")).toEqual(["/api/x/keep"]);
      expect(shadowed([`for (const k of keys) { ${MATCH} if (m && method === "GET") { try { return json({}); } finally { if (k) continue; } } ${LITERAL} }`])).toEqual(["/api/x/keep"]);
      expect(shadowed([`for (const k of keys) { ${MATCH} if (m && method === "GET") { try { if (k) continue; return json({}); } catch { log(); } } ${LITERAL} }`])).toEqual([]);
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

    test("the winner is the first statement that runs and leaves, outer blocks first", () => {
      const o = inner([MATCH, 'if (m && method === "GET") return json({});', 'if (method === "GET" && pathname.startsWith("/api/x/")) return json({});', LITERAL]);
      expect(o.map((x) => [x.prior.kind, x.prior.line])).toEqual([["pattern", 4]]);
      const nested = inner(['if (method === "GET" && pathname.startsWith("/api/x/")) return json({});', `{ ${MATCH} if (m && method === "GET") return json({}); ${LITERAL} }`]);
      expect(nested.map((x) => [x.prior.kind, x.prior.line])).toEqual([["prefix", 3]]);
    });

    // A statement that leaves with no path test that held is a gate: the
    // literal is unreachable for that method, but nothing later hides it.
    test("a gate that leaves first, with no path test, is not a finding", () => {
      expect(shadowed(['if (method === "GET") return json({});', LITERAL])).toEqual([]);
      expect(shadowed(['if (method === "GET") return json({});', MATCH, 'if (m && method === "GET") return json({});', LITERAL])).toEqual([]);
      expect(shadowed(['if (!pathname.startsWith("/api/y/")) return null;', LITERAL])).toEqual([]);
    });

    test("a literal nested two blocks down, and an else that leaves, are followed", () => {
      expect(shadowed([MATCH, 'if (m && method === "GET") return json({});', `if (ready) { { ${LITERAL} } }`])).toEqual(["/api/x/keep"]);
      expect(shadowed([MATCH, 'if (method === "POST") { log(); } else if (m) { return json({}); }', LITERAL])).toEqual(["/api/x/keep"]);
      expect(shadowed([MATCH, 'if (method === "GET") { log(); } else if (m) { return json({}); }', LITERAL])).toEqual([]);
    });

    test("only a path test that holds for the literal names a winner", () => {
      for (const prior of [
        'if (method === "GET" && pathname === "/api/x") return json({});',
        'if (method === "GET" && pathname.startsWith("/api/x/keep/")) return json({});',
        'if (method === "GET" && other === "/api/x/keep") return json({});',
        'if (method === "GET" && /^\\/api\\/x\\/[^/]+$/g.test(pathname)) return json({});',
        'if (method === "GET" && /^\\/api\\/x\\/[^/]+$/y.test(pathname)) return json({});',
        'if (method === "GET" && /[z-a]/.test(pathname)) return json({});',
      ]) expect(shadowed([prior, LITERAL])).toEqual([]);
      expect(shadowed(['if (method === "GET" && ready && pathname.startsWith("/api/x/")) return json({});', LITERAL])).toEqual([]);
      expect(shadowed(['const m = matchRoute(otherPath, "/api/x/:id");', 'if (m && method === "GET") return json({});', LITERAL])).toEqual([]);
      // Either side of the comparison, and a false `||` under a `!`.
      expect(shadowed([MATCH, 'if (m && "GET" === method) return json({});', LITERAL])).toEqual(["/api/x/keep"]);
      expect(shadowed(['if ("GET" === method && "/api/x/keep" === pathname) return json({ first: true });', LITERAL])).toEqual(["/api/x/keep"]);
      expect(shadowed([MATCH, 'if (m && method === "GET") return json({});', 'if (method === "GET" && "/api/x/keep" === pathname) return json({});'])).toEqual(["/api/x/keep"]);
      expect(shadowed([MATCH, 'if (m && !(method === "POST" || method === "PUT")) return json({});', LITERAL])).toEqual(["/api/x/keep"]);
      expect(shadowed(['if (method === "GET" && pathname.startsWith("/api/x/") && !pathname.endsWith("/z")) return json({});', 'if (ready && method === "GET" && pathname === "/api/x/keep") return json({});'])).toEqual(["/api/x/keep"]);
    });

    // The request is the parameter: a local of the same name, a field of
    // something else, or a parameter written again is not it.
    test("pathname and method are the request's only when they are its parameters", () => {
      for (const lines of [
        [MATCH, '{ const method = "GET"; if (m && method === "GET") return json({}); }', LITERAL],
        ['{ const pathname = "/api/x/keep"; if (pathname.startsWith("/api/x/")) return json({}); }', LITERAL],
        [MATCH, 'if (m && body.method === "GET") return json({});', LITERAL],
        [MATCH, 'if (m && method === "get") return json({});', LITERAL],
        ['var m = matchRoute(pathname, "/api/x/:id");', 'if (m && method === "GET") return json({});', LITERAL],
        ['let m = matchRoute(pathname, "/api/x/:id");', "[m] = other;", 'if (m && method === "GET") return json({});', LITERAL],
        ["pathname = pathname.toLowerCase();", MATCH, 'if (m && method === "GET") return json({});', LITERAL, 'if (method === "GET" && pathname === "/api/x/other") return json({});'],
        [MATCH, 'if (m && method === "get") return json({});', 'if (pathname === "/api/x/keep") return json({});'],
        ["({ method } = override);", MATCH, 'if (m && method === "GET") return json({});', LITERAL],
        ["for (method of verbs) log(method);", MATCH, 'if (m && method === "GET") return json({});', LITERAL],
      ]) expect(shadowed(lines)).toEqual([]);
      expect(shadowed(['const m = matchRoute(url.pathname, "/api/x/:id");', 'if (m && req.method === "GET") return json({});', LITERAL])).toEqual(["/api/x/keep"]);
      // Names destructured from the parameter are not followed.
      expect(findInnerShadows(`export function create(ctx: any) {
  return async function r({ pathname, method }: { pathname: string; method: string }) {
    ${MATCH}
    if (m && method === "GET") return json({});
    ${LITERAL}
    return null;
  };
}`, "a.ts", "a")).toEqual([]);
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

    // browser.ts:122 and people.ts:388 refuse every other method with a 405;
    // a pattern above that answers only those other methods hides nothing.
    test("a 405 guard, a switch on the method, or `&& method !==` limit what the literal serves", () => {
      const POST_PRIOR = 'if (m && method === "POST") return json({});';
      const GET_PRIOR = 'if (m && method === "GET") return json({});';
      for (const literal of [
        'if (pathname === "/api/x/keep") { if (method !== "GET") return errorResponse(405, "GET required"); return json({}); }',
        'if (pathname === "/api/x/keep") { if (io === null) return errorResponse(401, "x"); if (method !== "GET" && method !== "PUT") return errorResponse(405, "x"); return json({}); }',
        'if (pathname === "/api/x/keep") { switch (method) { case "GET": return json({}); default: return errorResponse(405, "x"); } }',
        'if (pathname === "/api/x/keep" && method !== "POST") return json({});',
      ]) {
        expect(shadowed([MATCH, POST_PRIOR, literal])).toEqual([]);
        expect(shadowed([MATCH, GET_PRIOR, literal])).toEqual(["/api/x/keep"]);
        expect(shadowed([MATCH, "if (m) return json({});", literal])).toEqual(["/api/x/keep"]);
      }
    });

    test("a literal in an else is served only for what the condition before it refuses", () => {
      const ELSE = 'if (method === "GET") { log(); } else { if (pathname === "/api/x/keep") return json({}); }';
      expect(shadowed([MATCH, 'if (m && method === "GET") return json({});', ELSE])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "POST") return json({});', ELSE])).toEqual(["/api/x/keep"]);
    });

    test("the methods of a finding: the ones hidden, \"*\" for a method the code does not name", () => {
      const ANY = 'if (pathname === "/api/x/keep") return json({});';
      const of = (prior: string) => inner([MATCH, prior, ANY]).map((x) => [x.methods, x.later.methods]);
      expect(of('if (m && method === "POST") return json({});')).toEqual([[["POST"], null]]);
      expect(of('if (m && method !== "GET") return json({});')).toEqual([[["*"], null]]);
      expect(of('if (m && (method === "GET" || method === "HEAD")) return json({});')).toEqual([[["GET", "HEAD"], null]]);
      expect(inner([MATCH, 'if (m) return json({});', 'if (pathname === "/api/x/keep" && method !== "GET") return json({});']).map((x) => [x.methods, x.later.methods])).toEqual([[["*"], ["*"]]]);
    });

    test("a literal in an || chain, and the guard that hands a block to one path, are literals too", () => {
      const POST_PRIOR = 'if (m && method === "POST") return json({});';
      expect(shadowed([MATCH, POST_PRIOR, 'if (method === "POST" && (pathname === "/api/x/a" || pathname === "/api/x/keep")) return json({});'])).toEqual(["/api/x/a", "/api/x/keep"]);
      expect(shadowed([MATCH, POST_PRIOR, 'if (pathname !== "/api/x/keep" || method !== "POST") return null;', "return json({});"])).toEqual(["/api/x/keep"]);
      expect(shadowed([MATCH, 'if (m && method === "GET") return json({});', 'if (pathname !== "/api/x/keep" || method !== "POST") return null;', "return json({});"])).toEqual([]);
      expect(shadowed([MATCH, POST_PRIOR, 'if (pathname !== "/api/x/keep") return null;', 'if (method === "GET") return json({});', 'return errorResponse(405, "x");'])).toEqual([]);
    });
    // browser.ts:522-632 (POST /api/browsers/:id/interact) and topics.ts:3137
    // (POST /api/command): a try around a switch whose every case returns.
    test("a switch leaves when it has a default, every case leaves and nothing breaks out of it", () => {
      const at = (body: string) => shadowed([MATCH, `if (m && method === "GET") { ${body} }`, LITERAL]);
      expect(at('const body = await readJSON(req); if (!body?.action) return errorResponse(400, "x"); try { switch (body.action) { case "a": if (!body.url) return errorResponse(400, "x"); return json({}); case "b": return json({}); default: return errorResponse(400, "x"); } } catch (err) { return errorResponse(500, "x"); }')).toEqual(["/api/x/keep"]);
      expect(at('switch (kind) { case "a": log(); default: return json({}); }')).toEqual(["/api/x/keep"]);
      expect(at('switch (kind) { case "a": for (const x of xs) { if (x) break; } return json({}); default: return json({}); }')).toEqual(["/api/x/keep"]);
      expect(at('switch (kind) { case "a": return json({}); case "b": return json({}); }')).toEqual([]);
      expect(at('switch (kind) { case "a": if (x) break; return json({}); default: return json({}); }')).toEqual([]);
      expect(at('switch (kind) { case "a": return json({}); default: log(); }')).toEqual([]);
      // A labeled break jumps past the label, which holds the literal too.
      expect(shadowed([`outer: for (const k of keys) { ${MATCH} if (m && method === "GET") { switch (k) { case "a": break outer; default: return json({}); } } ${LITERAL} }`])).toEqual(["/api/x/keep"]);
    });

    // The shapes a reviewer put in people.ts:387 and history.ts:512: a 405 or a
    // `return null` on a method is why the literal never sees that method, not
    // the pattern above it.
    test("a method gate anywhere before the literal, even after the winner, takes that method off", () => {
      const DEL = ['const d = matchRoute(pathname, "/api/x/:id");', 'if (d && method === "DELETE") return json({});'];
      expect(shadowed([...DEL, 'if (pathname.startsWith("/api/x/")) {', '  if (method !== "GET") return errorResponse(405, "x");', '  if (pathname === "/api/x/keep") return json({});', "}"])).toEqual([]);
      expect(shadowed([...DEL, 'if (method !== "GET") return null;', 'if (pathname === "/api/x/keep") return json({});'])).toEqual([]);
      expect(inner([...DEL, 'if (pathname === "/api/x/keep") return json({});']).map((x) => x.methods)).toEqual([["DELETE"]]);
    });

    // account.ts:71-73: one guard for three paths, then an if per path.
    test("a guard for several paths gives each path only the methods of its own ifs", () => {
      const account = (prior: string) => inner([
        'const s = matchRoute(pathname, "/api/x/:section");',
        prior,
        'if (pathname !== "/api/x/account" && pathname !== "/api/x/account/code" && pathname !== "/api/x/account/verify") return null;',
        'if (method === "GET" && pathname === "/api/x/account") return json({});',
        'if (method === "POST" && pathname === "/api/x/account/code") return json({});',
        'if (method === "POST" && pathname === "/api/x/account/verify") return json({});',
      ]).map((o) => [o.sample, o.methods, o.later.line]);
      expect(account('if (s && method === "POST") return json({});')).toEqual([]);
      expect(account('if (s && method === "GET") return json({});')).toEqual([["/api/x/account", ["GET"], 5], ["/api/x/account", ["GET"], 6]]);
    });

    test("a literal under a case of switch (method) serves only that method", () => {
      const SWITCH = 'switch (method) { case "GET": if (pathname === "/api/x/keep") return json({}); break; case "POST": log(); break; }';
      expect(shadowed([MATCH, 'if (m && method === "POST") return json({});', SWITCH])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "GET") return json({});', SWITCH])).toEqual(["/api/x/keep"]);
      expect(shadowed([MATCH, 'if (m && method === "GET") return json({});', 'switch (method) { case Verb.Get: if (pathname === "/api/x/keep") return json({}); break; }'])).toEqual([]);
    });

    // goals.ts:75-80, machines.ts:445-478, terminal.ts:3328.
    test("the winner's line is the if that tested the path, not the block around it", () => {
      const goals = ["{", '  const params = matchRoute(pathname, "/api/x/:id");', '  if (params && method === "GET") {', "    const denied = deny(params.id);", "    if (denied) return denied;", "    return json({});", "  }", '  if (params && method === "PUT") return json({});', "}", LITERAL];
      expect(inner(goals).map((o) => [o.prior.line, o.later.line])).toEqual([[5, 12]]);
      const machines = ["{", '  const params = matchRoute(pathname, "/api/x/:id");', "  if (params) {", '    if (method === "GET") { const v = store.get(params.id); if (!v) return errorResponse(404, "x"); return json(v); }', '    if (method === "DELETE") { try { store.delete(params.id); return json({ ok: true }); } catch (err) { if (err instanceof InUse) return errorResponse(409, "x"); throw err; } }', "  }", "}", LITERAL];
      expect(inner(machines).map((o) => [o.methods, o.prior.line, o.later.line])).toEqual([[["GET"], 5, 10]]);
      const terminal = 'if (method === "GET" && (pathname === "/api/x/a" || pathname === "/api/x/keep")) { const k = req.headers.get("k"); if (k) return json({ k }); return json({}); }';
      expect(inner([terminal, LITERAL]).map((o) => [o.prior.kind, o.prior.line])).toEqual([["exact", 3]]);
      const inside = ['if (method === "GET") {', `  ${MATCH}`, "  if (m) return json({});", "}", LITERAL];
      expect(inner(inside).map((o) => o.prior.line)).toEqual([5]);
    });

    test("a literal under a condition the gate cannot read is served, under one that refuses its method it is not", () => {
      const GET_PRIOR = 'if (m && method === "GET") return json({});';
      expect(shadowed([MATCH, GET_PRIOR, `if (!ctx.readOnly) { ${LITERAL} }`])).toEqual(["/api/x/keep"]);
      expect(shadowed([MATCH, GET_PRIOR, 'if (ready || method === "POST") { if (pathname === "/api/x/keep") return json({}); }'])).toEqual(["/api/x/keep"]);
      expect(shadowed([MATCH, GET_PRIOR, 'if (method === "POST") { if (ready) { if (pathname === "/api/x/keep") return json({}); } }'])).toEqual([]);
    });

    test("an unreadable case label, a negated literal, or a test on something else names nothing", () => {
      for (const prior of ['if (m && method === "GET") return json({});', 'if (m && method === "POST") return json({});'])
        expect(shadowed([MATCH, prior, 'if (pathname === "/api/x/keep") { switch (method) { case Verb.Post: return json({}); } }'])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "GET") return json({});', 'if (!(pathname === "/api/x/keep")) { log(); }'])).toEqual([]);
      expect(shadowed(['if (/^\\/api\\/x\\//.test(id)) return json({});', LITERAL])).toEqual([]);
      expect(shadowed(['if (method === "GET" && pathname.endsWith("/keep")) return json({});', LITERAL])).toEqual([]);
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

    // The stale filter, on its own: on the real tree every unused entry is
    // stale; on a bench tree only the entries about routers it has.
    test("staleKnown judges every entry on the real tree, and only this tree's routers on another", () => {
      const k = (prior: string, later: string): KnownOverlap => ({ prior, later, sample: "/api/x", why: "t" });
      const both = k("a", "b");
      const gone = k("a", "gone");
      expect(staleKnown([both], new Set(), ["a", "b"], false)).toEqual([both]);
      expect(staleKnown([both], new Set([both]), ["a", "b"], false)).toEqual([]);
      expect(staleKnown([gone], new Set(), ["a"], false)).toEqual([]);
      expect(staleKnown([k("gone", "a")], new Set(), ["a"], false)).toEqual([]);
      expect(staleKnown([gone, both], new Set([both]), ["a", "b"], true)).toEqual([gone]);
    });

    test("a KNOWN entry matches its routers and sample, and its methods when it names them", () => {
      const claim = (router: string, methods: string[] | null): Claim => ({ router, file: "f.ts", line: 1, kind: "exact", value: "/api/x", methods });
      const o = (methods: string[] | null, sample = "/api/x"): Overlap => ({ prior: claim("a", methods), later: claim("b", methods), sample, methods });
      const get: KnownOverlap = { prior: "a", later: "b", sample: "/api/x", methods: ["GET"], why: "t" };
      const any: KnownOverlap = { prior: "a", later: "b", sample: "/api/x", why: "t" };
      expect(knownFor(o(["GET"]), [get])).toBe(get);
      expect(knownFor(o(["DELETE"]), [get])).toBeUndefined();
      expect(knownFor(o(["DELETE", "GET"]), [get])).toBeUndefined();
      expect(knownFor(o(null), [get])).toBeUndefined();
      expect(knownFor(o(["GET"], "/api/y"), [get])).toBeUndefined();
      expect(knownFor(o(["DELETE"]), [any])).toBe(any);
      expect(knownFor({ ...o(["GET"]), later: claim("c", ["GET"]) }, [get])).toBeUndefined();
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

      // topics composes chat, history, edit...: the file of a sub-router is
      // read for its router, and every router of the table is read.
      test("the file of a sub-router and every router of the table are read", () => {
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
        const shadow = (base: string) => [
          `    const m = matchRoute(pathname, "${base}/:id");`,
          '    if (m && method === "GET") return new Response("pattern");',
          `    if (method === "GET" && pathname === "${base}/keep") return new Response("literal");`,
        ].join("\n");
        const router = (name: string, body: string, head = "") =>
          `${head}export function create${name}(ctx: any) {\n  return async function r(req: Request, url: URL, pathname: string, method: string) {\n${body}\n    return null;\n  };\n}\n`;
        writeFileSync(join(root, "server", "routes", "a.ts"), router("ARouter", "    return sub(req, url, pathname, method);", 'import { createSubRoutes } from "./a-sub";\n'));
        writeFileSync(join(root, "server", "routes", "a-sub.ts"), router("SubRoutes", shadow("/api/sub")));
        writeFileSync(join(root, "server", "routes", "b.ts"), router("BRouter", shadow("/api/b")));
        const r = run(root);
        expect(r.stdout).toContain("hidden: aRouter server/routes/a-sub.ts:5 GET exact /api/sub/keep");
        expect(r.stdout).toContain("hidden: bRouter server/routes/b.ts:5 GET exact /api/b/keep");
        expect(r.status).toBe(1);
      });
    });
  });
});
