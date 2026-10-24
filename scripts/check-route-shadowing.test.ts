/**
 * @covers GATE-17
 */
import { describe, expect, test, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractClaims, findInnerShadows, findOverlaps, knownFor, sampleOf, staleKnown, type Claim, type ClaimKind, type KnownOverlap, type Overlap } from "./check-route-shadowing";

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
      // A default runs for the methods no other case names, and an empty case falls into the next.
      const DEFAULT = 'switch (method) { case "GET": log(); break; default: if (pathname === "/api/x/keep") return json({}); }';
      expect(shadowed([MATCH, 'if (m && method === "GET") return json({});', DEFAULT])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "POST") return json({});', DEFAULT])).toEqual(["/api/x/keep"]);
      expect(shadowed([MATCH, 'if (m && method === "POST") return json({});', DEFAULT.replace('case "GET"', "case Verb.Get")])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "GET") return json({});', 'switch (method) { case "GET": case "HEAD": if (pathname === "/api/x/keep") return json({}); break; }'])).toEqual(["/api/x/keep"]);
    });

    // topics.ts:1414: the match exists only for GET.
    test("a match bound through a ternary on the method is followed for that method only", () => {
      const TERNARY = ["{", '  const m = method === "GET" ? /^\\/api\\/x\\/([^/]+)$/.exec(pathname) : null;', "  if (m) {", "    const t = load(m[1]);", '    if (!t) return json({ error: "x" }, 404);', "    return json(t);", "  }", "}"];
      expect(inner([...TERNARY, LITERAL]).map((o) => [o.sample, o.prior.kind, o.prior.line])).toEqual([["/api/x/keep", "regex", 5]]);
      expect(shadowed([...TERNARY, 'if (method === "POST" && pathname === "/api/x/keep") return json({});'])).toEqual([]);
      // With the condition unknown the branches must agree, or nothing is known.
      const UNSURE = ['const r = ready ? /^\\/api\\/x\\/([^/]+)$/.exec(pathname) : null;', 'if (r && method === "GET") return json({});'];
      expect(shadowed([...UNSURE, LITERAL])).toEqual([]);
      expect(shadowed([MATCH, 'if (m && method === "GET") return json({});', ...UNSURE, LITERAL])).toEqual(["/api/x/keep"]);
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

    // The cases a reviewer of #424 wrote against "the gate reads switch and
    // default", by their id: a dead one is a finding (its methods, the kind and
    // line of the winner), a live one is none. The live ones guard against new
    // false reds.
    describe("the reviewer's cases of #424", () => {
      const LIT = (verb: string) => `if (method === "${verb}" && pathname === "/api/x/keep") return json({});`;
      const GET_PRIOR = 'if (m && method === "GET") return json({});';
      const POST_PRIOR = 'if (m && method === "POST") return json({});';
      const RE = "/^\\/api\\/x\\/([^/]+)$/";
      type Dead = { methods: string[]; kind: ClaimKind; line: number };
      const dead = (methods: string[], kind: ClaimKind = "pattern"): Dead => ({ methods, kind, line: 4 });
      const CASES: Array<{ id: string; what: string; lines: string[]; dead?: Dead }> = [
        // A switch (method) before the literal.
        { id: "SW1", what: "a switch (method) with no default, its case GET leaves", lines: [MATCH, 'if (m) { switch (method) { case "GET": return json({}); } }', LIT("GET")], dead: dead(["GET"]) },
        { id: "SW2", what: "a switch (method) with a 405 default", lines: [MATCH, 'if (m) { switch (method) { case "GET": return json({}); default: return errorResponse(405, "x"); } }', LIT("GET")], dead: dead(["GET"]) },
        { id: "SW3", what: "case GET leaves, case POST breaks, default 405", lines: [MATCH, 'if (m) { switch (method) { case "GET": return json({}); case "POST": break; default: return errorResponse(405, "x"); } }', LIT("GET")], dead: dead(["GET"]) },
        { id: "SW4", what: "a labelled break on the switch itself goes on", lines: [MATCH, 'if (m && method === "GET") { sw: switch (kind) { case "a": break sw; default: return json({}); } }', LIT("GET")] },
        { id: "SW5", what: "case POST leaves, the default breaks: GET goes on", lines: [MATCH, 'if (m) { switch (method) { case "POST": return json({}); default: break; } }', LIT("GET")] },
        { id: "SW6", what: "a case that breaks inside a block goes on", lines: [MATCH, 'if (m && method === "GET") { switch (kind) { case "a": { if (x) { break; } } return json({}); default: return json({}); } }', LIT("GET")] },
        // The literal under a switch (method).
        { id: "SL1", what: "the literal in case GET, a GET pattern before", lines: [MATCH, GET_PRIOR, 'switch (method) { case "GET": if (pathname === "/api/x/keep") return json({}); break; }'], dead: dead(["GET"]) },
        { id: "SL2", what: "the literal in case GET, a POST pattern before", lines: [MATCH, POST_PRIOR, 'switch (method) { case "GET": if (pathname === "/api/x/keep") return json({}); break; }'] },
        // A clause that is not empty may throw before it falls through (fl.ts
        // W4, `case "GET": fail(405);`): which methods reach the literal's
        // clause through it is unknown, as main reads it.
        { id: "SL3", what: "the literal in case GET, which a case POST that is not empty falls into; a POST pattern before", lines: [MATCH, POST_PRIOR, 'switch (method) { case "POST": log(); case "GET": if (pathname === "/api/x/keep") return json({}); break; }'] },
        // Defaults.
        { id: "D1", what: "the literal in the default, case GET breaks, a GET pattern before", lines: [MATCH, GET_PRIOR, 'switch (method) { case "GET": log(); break; default: if (pathname === "/api/x/keep") return json({}); }'] },
        { id: "D2", what: "the literal in the default, a POST pattern before", lines: [MATCH, POST_PRIOR, 'switch (method) { case "GET": log(); break; default: if (pathname === "/api/x/keep") return json({}); }'], dead: dead(["POST"]) },
        { id: "D3", what: "the literal in the default, which case GET falls into with no break; a GET pattern before", lines: [MATCH, GET_PRIOR, 'switch (method) { case "GET": log(); default: if (pathname === "/api/x/keep") return json({}); }'] },
        { id: "D4", what: "the literal's switch (method): case POST and a default that serves; a GET pattern before", lines: [MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { switch (method) { case "POST": return json({ saved: true }); default: return json({ list: [] }); } }'], dead: dead(["GET"]) },
        { id: "D5", what: "the literal's switch (method): case POST and a 405 default; a GET pattern before", lines: [MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { switch (method) { case "POST": return json({}); default: return errorResponse(405, "x"); } }'] },
        { id: "D6", what: "a default before the cases, a GET pattern before", lines: [MATCH, GET_PRIOR, 'switch (method) { default: if (pathname === "/api/x/keep") return json({}); break; case "GET": log(); break; }'] },
        { id: "D7", what: "an empty case GET that falls into the default, a GET pattern before", lines: [MATCH, GET_PRIOR, 'switch (method) { case "GET": default: if (pathname === "/api/x/keep") return json({}); }'], dead: dead(["GET"]) },
        // A ternary on the method.
        { id: "T1", what: "t = method === GET ? exec : null, a GET literal", lines: [`const t = method === "GET" ? ${RE}.exec(pathname) : null;`, "if (t) { return json(t); }", LIT("GET")], dead: dead(["GET"], "regex") },
        { id: "T2", what: "t = method !== GET ? null : exec, a GET literal", lines: [`const t = method !== "GET" ? null : ${RE}.exec(pathname);`, "if (t) return json(t);", LIT("GET")], dead: dead(["GET"], "regex") },
        { id: "T3", what: "(GET || HEAD) ? matchRoute : null, a HEAD literal", lines: ['const t = method === "GET" || method === "HEAD" ? matchRoute(pathname, "/api/x/:id") : null;', "if (t) return json(t);", LIT("HEAD")], dead: dead(["HEAD"]) },
        { id: "T4", what: "a nested ternary, its POST branch, a POST literal", lines: [`const t = method === "GET" ? /^\\/api\\/zz$/.exec(pathname) : method === "POST" ? ${RE}.exec(pathname) : null;`, "if (t) return json(t);", LIT("POST")], dead: dead(["POST"], "regex") },
        { id: "T5", what: "t = method === GET ? exec : null, a POST literal", lines: [`const t = method === "GET" ? ${RE}.exec(pathname) : null;`, "if (t) return json(t);", LIT("POST")] },
        { id: "T6", what: "method === GET ? false : m in the earlier condition, a GET literal", lines: [MATCH, 'if (method === "GET" ? false : m) return json({});', LIT("GET")] },
        { id: "T7", what: "method === GET ? m : false in the earlier condition, a GET literal", lines: [MATCH, 'if (method === "GET" ? m : false) return json({});', LIT("GET")], dead: dead(["GET"]) },
        { id: "T8", what: "for GET the match is another path's regex", lines: [`const t = method === "GET" ? /^\\/api\\/y\\/([^/]+)$/.exec(pathname) : ${RE}.exec(pathname);`, 'if (t && method === "GET") return json(t);', LIT("GET")] },
        // Outside the three constructs.
        { id: "U1", what: "the literal under a test of the method the gate cannot read (WRITE.has(method)), a GET pattern before", lines: [MATCH, GET_PRIOR, 'if (WRITE.has(method)) { if (pathname === "/api/x/keep") return json({}); }'] },
        { id: "U2", what: "the literal under case POST of switch (method.toUpperCase()), a GET pattern before", lines: [MATCH, GET_PRIOR, 'switch (method.toUpperCase()) { case "POST": if (pathname === "/api/x/keep") return json({}); }'] },
        { id: "B1", what: "the literal's body: if (method === DELETE) { ...return } then a return that serves; a GET pattern before", lines: [MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { if (method === "DELETE") { drop(); return json({ ok: true }); } return json({ list: [] }); }'], dead: dead(["GET"]) },
      ];
      for (const c of CASES) {
        test(`${c.id}: ${c.what}`, () => {
          const found = inner(c.lines).map((o) => ({ methods: o.methods, kind: o.prior.kind, line: o.prior.line }));
          expect(found).toEqual(c.dead ? [c.dead] : []);
        });
      }

      // Around the same rules: what the gate cannot evaluate stays unknown,
      // and unknown is never a finding.
      test("a switch (method) whose earlier label cannot be read, or that no case or default matches, goes on", () => {
        expect(shadowed([MATCH, 'if (m) { switch (method) { case Verb.Get: break; case "GET": return json({}); } }', LIT("GET")])).toEqual([]);
        expect(shadowed([MATCH, 'if (m) { switch (method) { case "POST": return json({}); } }', LIT("GET")])).toEqual([]);
        expect(shadowed([MATCH, 'if (m) { switch (method) { case "GET": log(); case "POST": return json({}); } }', LIT("GET")])).toEqual(["/api/x/keep"]);
        expect(shadowed([MATCH, 'if (m) { switch (method) { case "GET": if (ready) break; return json({}); } }', LIT("GET")])).toEqual([]);
      });

      test("a discriminant that reads the method other than as itself, or a test of it the gate cannot read, serves no method", () => {
        expect(shadowed([MATCH, GET_PRIOR, 'switch (method.toLowerCase()) { case "get": if (pathname === "/api/x/keep") return json({}); }'])).toEqual([]);
        expect(shadowed([MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { switch (method.toLowerCase()) { case "post": return json({}); default: return errorResponse(405, "x"); } }'])).toEqual([]);
        // method.toUpperCase() is the method: its case POST serves POST.
        expect(shadowed([MATCH, POST_PRIOR, 'switch (method.toUpperCase()) { case "POST": if (pathname === "/api/x/keep") return json({}); }'])).toEqual(["/api/x/keep"]);
        expect(shadowed([MATCH, GET_PRIOR, 'if (WRITE.has(method) && pathname === "/api/x/keep") return json({});'])).toEqual([]);
        expect(shadowed([MATCH, GET_PRIOR, 'if (!READ.has(method)) { if (pathname === "/api/x/keep") return json({}); }'])).toEqual([]);
        expect(shadowed([MATCH, GET_PRIOR, 'if (method === "POST") { log(); } else if (WRITE.has(method)) { log(); } else { if (pathname === "/api/x/keep") return json({}); }'])).toEqual([]);
        // A condition that does not read the method keeps counting as met.
        expect(shadowed([MATCH, GET_PRIOR, 'if (ready && method === "GET") { if (pathname === "/api/x/keep") return json({}); }'])).toEqual(["/api/x/keep"]);
      });

      test("a tail that serves serves the methods no branch takes, one that cannot be read does not", () => {
        expect(shadowed([MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { if (method === "DELETE") return json({}); try { return json(load()); } catch (e) { return fail(e); } }'])).toEqual(["/api/x/keep"]);
        expect(shadowed([MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { if (method === "DELETE") return json({}); return new Response("list"); }'])).toEqual(["/api/x/keep"]);
        // A refusal with !== may answer a 200 (fl.ts H11): what it does not name is not served, as main reads it.
        expect(shadowed([MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { if (method === "DELETE") return json({}); if (method !== "DELETE") return json({ list: [] }); }'])).toEqual([]);
        expect(shadowed([MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { if (method === "DELETE") return json({}); return handle(req); }'])).toEqual([]);
        expect(shadowed([MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { if (method === "DELETE") return json({}); return json({ error: "x" }, 405); }'])).toEqual([]);
        expect(shadowed([MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { switch (method) { case "POST": return json({}); default: return handle(req); } }'])).toEqual([]);
      });
    });

    // The cases the verifiers of the switch branch wrote, by the probe file
    // and id they used (holes.ts, fr.ts, fr2.ts, fr3.ts, pred.ts, realistic.ts).
    // Every live one is correct code: a read of the method the gate cannot
    // evaluate, in the literal's body or before it, leaves that method unknown,
    // and unknown is never a finding.
    describe("the verifiers' cases of the switch branch", () => {
      const LIT = (verb: string) => `if (method === "${verb}" && pathname === "/api/x/keep") return json({});`;
      const GET_PRIOR = 'if (m && method === "GET") return json({});';
      const POST_PRIOR = 'if (m && method === "POST") return json({});';
      const PUT_PRIOR = 'if (m && method === "PUT") return json({});';
      const KEEP = (body: string) => `if (pathname === "/api/x/keep") { ${body} }`;
      const IN_GET_CASE = (body: string) => `if (m) { switch (method) { case "GET": ${body} } }`;
      type Dead = { methods: string[]; kind: ClaimKind; line: number };
      const CASES: Array<{ id: string; what: string; lines: string[]; dead?: Dead }> = [
        // A switch (method) before the literal whose case is a block.
        { id: "holes.ts H01", what: "case GET: { if (m) return; break; }", lines: [MATCH, 'switch (method) { case "GET": { if (m) return json({}); break; } }', LIT("GET")], dead: { methods: ["GET"], kind: "pattern", line: 4 } },
        { id: "holes.ts H02", what: "case GET: if (m) return; break; with no block", lines: [MATCH, 'switch (method) { case "GET": if (m) return json({}); break; }', LIT("GET")], dead: { methods: ["GET"], kind: "pattern", line: 4 } },
        { id: "holes.ts H03", what: "case GET: { const m = matchRoute(...); if (m) return; break; }", lines: ['switch (method) { case "GET": { const m = matchRoute(pathname, "/api/x/:id"); if (m) return json({}); break; } }', LIT("GET")], dead: { methods: ["GET"], kind: "pattern", line: 3 } },
        // Breaks that end the switch on the way: it goes on.
        { id: "fr2.ts G12", what: "a labelled continue in a loop around the switch", lines: [MATCH, 'loop: for (const r of rules) { if (m) { switch (method) { case "GET": if (r.skip) continue loop; return json({}); } } }', LIT("GET")] },
        { id: "fr2.ts G13", what: "case GET: try { if (x) break; } finally {}", lines: [MATCH, IN_GET_CASE('try { if (m.id === "keep") break; } finally { done(); } return json({});'), LIT("GET")] },
        { id: "fr2.ts G14", what: "case GET: try { return } catch { break; }", lines: [MATCH, IN_GET_CASE("try { return json(load()); } catch { break; }"), LIT("GET")] },
        { id: "fr2.ts G15", what: "a break of a nested switch, then a break of this one", lines: [MATCH, IN_GET_CASE('switch (kind) { case "a": break; default: break; } if (m.id === "keep") break; return json({});'), LIT("GET")] },
        { id: "fr2.ts G16", what: "case GET: if (x) return; break;", lines: [MATCH, 'if (m) { switch (method) { case "GET": if (m.id !== "keep") return json({}); break; default: break; } }', LIT("GET")] },
        { id: "fr2.ts G17", what: "case GET: if (x) { break; } else { return }", lines: [MATCH, IN_GET_CASE('if (m.id === "keep") { break; } else { return json({}); }'), LIT("GET")] },
        { id: "fr2.ts G18", what: "a break that ends a do-while, then off the end", lines: [MATCH, IN_GET_CASE('do { if (m.id === "keep") break; return json({}); } while (false);'), LIT("GET")] },
        { id: "fr2.ts G19", what: "a labelled break out of a block inside the case", lines: [MATCH, IN_GET_CASE('inner: { if (m.id === "keep") break inner; return json({}); }'), LIT("GET")] },
        { id: "fr2.ts G20", what: "a labelled break on an if inside the case", lines: [MATCH, IN_GET_CASE('chk: if (m.id === "keep") { break chk; } else { return json({}); }'), LIT("GET")] },
        { id: "fr2.ts G21", what: "a finally that may break overrides the return", lines: [MATCH, IN_GET_CASE('try { return json({}); } finally { if (m.id === "keep") break; }'), LIT("GET")] },
        { id: "fr2.ts G22", what: "a finally that breaks overrides the return", lines: [MATCH, IN_GET_CASE("try { return json({}); } finally { break; }"), LIT("GET")] },
        // A body that refuses a method in a way the gate cannot read, or deeper than its top statements.
        { id: "holes.ts F01", what: "body: if (![GET, HEAD].includes(method)) 405", lines: [MATCH, POST_PRIOR, KEEP('if (!["GET", "HEAD"].includes(method)) return errorResponse(405, "x"); return json({});')] },
        { id: "holes.ts F02", what: "body: if (!READ.has(method)) 405", lines: [MATCH, POST_PRIOR, KEEP('if (!READ.has(method)) return errorResponse(405, "x"); return json({});')] },
        { id: "holes.ts F04", what: "body: if (method.toUpperCase() !== GET) 405", lines: [MATCH, POST_PRIOR, KEEP('if (method.toUpperCase() !== "GET") return errorResponse(405, "x"); return json({});')] },
        { id: "holes.ts F06", what: "body: if (isRead(method)) return json; return 405", lines: [MATCH, POST_PRIOR, KEEP('if (isRead(method)) return json({}); return errorResponse(405, "x");')] },
        { id: "fr.ts F1", what: "body: if (!WRITE.has(method)) 405", lines: [MATCH, GET_PRIOR, KEEP('if (!WRITE.has(method)) return errorResponse(405, "x"); return json({});')] },
        { id: "fr.ts F2", what: "body: if (![POST, PUT].includes(method)) 405", lines: [MATCH, GET_PRIOR, KEEP('if (!["POST", "PUT"].includes(method)) return errorResponse(405, "x"); return json({});')] },
        { id: "fr.ts F3", what: "body: return method === POST ? json : 405", lines: [MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") return method === "POST" ? json({}) : errorResponse(405, "x");'] },
        { id: "fr.ts F4", what: "body: switch (true) { case method === POST }", lines: [MATCH, GET_PRIOR, KEEP('switch (true) { case method === "POST": return json({}); default: return errorResponse(405, "x"); }')] },
        { id: "fr.ts F5", what: "body: a handler table read by the method", lines: [MATCH, GET_PRIOR, KEEP('const h = HANDLERS[method]; if (!h) return errorResponse(405, "x"); return h();')] },
        { id: "fr.ts F6", what: "body: requireMethod(method, POST)", lines: [MATCH, GET_PRIOR, KEEP('requireMethod(method, "POST"); return json({});')] },
        { id: "fr.ts F23", what: "body: the method test nested in a block", lines: [MATCH, GET_PRIOR, KEEP('{ if (method !== "POST") return errorResponse(405, "x"); } return json({});')] },
        { id: "fr.ts F24", what: "body: the method test in a try", lines: [MATCH, GET_PRIOR, KEEP('try { if (method !== "POST") return errorResponse(405, "x"); return json(await save()); } catch (e) { return errorResponse(500, String(e)); }')] },
        { id: "fr.ts F25", what: "body: the method test held in a const", lines: [MATCH, GET_PRIOR, KEEP('const ok = method === "POST"; if (!ok) return errorResponse(405, "x"); return json({});')] },
        // A tail past a refusal the gate cannot read is not a tail that serves.
        { id: "fr.ts F13", what: "if POST; if (!READ.has(method)) 405; return json(list)", lines: [MATCH, PUT_PRIOR, KEEP('if (method === "POST") return json({ saved: 1 }); if (!READ.has(method)) return errorResponse(405, "x"); return json({ list: [] });')] },
        { id: "fr.ts F14", what: "if POST; if (![GET, HEAD].includes(method)) 405; return json(list)", lines: [MATCH, PUT_PRIOR, KEEP('if (method === "POST") return json({ saved: 1 }); if (!["GET", "HEAD"].includes(method)) return errorResponse(405, "x"); return json({ list: [] });')] },
        { id: "fr2.ts G6", what: "tail past if (!isRead(method)) 405", lines: [MATCH, PUT_PRIOR, KEEP('if (method === "DELETE") { drop(); return json({}); } if (!isRead(method)) return errorResponse(405, "x"); return json({ list: [] });')] },
        { id: "fr2.ts G7", what: "tail past method !== GET && !ALLOW.includes(method)", lines: [MATCH, PUT_PRIOR, KEEP('if (method === "DELETE") return json({}); if (method !== "GET" && !ALLOW.includes(method)) return errorResponse(405, "x"); return json({ list: [] });')] },
        { id: "fr2.ts G8", what: "tail past a test of an alias of the method", lines: [MATCH, PUT_PRIOR, "const verb = method.toUpperCase();", KEEP('if (method === "DELETE") return json({}); if (verb !== "GET") return errorResponse(405, "x"); return json({ list: [] });')] },
        { id: "fr2.ts G9", what: "tail past assertMethod(method, [GET])", lines: [MATCH, PUT_PRIOR, KEEP('if (method === "DELETE") return json({}); assertMethod(method, ["GET"]); return json({ list: [] });')] },
        { id: "fr2.ts G10", what: "tail past a handler table read by the method", lines: [MATCH, PUT_PRIOR, KEEP('if (method === "DELETE") return json({}); const h = READERS[method]; if (!h) return errorResponse(405, "x"); return json(h());')] },
        { id: "fr2.ts G11", what: "tail past try { check(method) } catch { 405 }", lines: [MATCH, PUT_PRIOR, KEEP('if (method === "DELETE") return json({}); try { check(method); } catch { return errorResponse(405, "x"); } return json({ list: [] });')] },
        { id: "fr3.ts K1", what: "a default that refuses with !READ.has(method) before its return", lines: [MATCH, PUT_PRIOR, KEEP('switch (method) { case "DELETE": return json({}); default: if (!READ.has(method)) return errorResponse(405, "x"); return json({ list: [] }); }')] },
        { id: "fr3.ts K2", what: "case POST refuses with !JSON_OK.has(method) and falls into the literal's case", lines: [MATCH, POST_PRIOR, 'switch (method) { case "POST": if (!JSON_OK.has(method)) return errorResponse(415, "x"); case "GET": if (pathname === "/api/x/keep") return json({}); break; }'] },
        { id: "fr3.ts K3", what: "the opaque refusal inside a block", lines: [MATCH, PUT_PRIOR, KEEP('if (method === "DELETE") return json({}); { if (!READ.has(method)) return errorResponse(405, "x"); } return json({ list: [] });')] },
        { id: "fr3.ts K4", what: "the guard form with the opaque refusal", lines: [MATCH, PUT_PRIOR, 'if (pathname !== "/api/x/keep") return null;', 'if (method === "DELETE") return json({});', 'if (!READ.has(method)) return errorResponse(405, "x");', "return json({ list: [] });"] },
        // A guard before the literal that refuses a method the gate cannot name.
        { id: "holes.ts F03", what: "if (!READ.has(method)) return null; between the prior and the literal", lines: [MATCH, POST_PRIOR, "if (!READ.has(method)) return null;", 'if (pathname === "/api/x/keep") return json({});'] },
        { id: "fr.ts F7", what: "if (!WRITE.has(method)) return null; before the literal", lines: [MATCH, GET_PRIOR, "if (!WRITE.has(method)) return null;", 'if (pathname === "/api/x/keep") return json({});'] },
        { id: "fr.ts F8", what: "if (![POST, PUT].includes(method)) 405 before the literal", lines: [MATCH, GET_PRIOR, 'if (!["POST", "PUT"].includes(method)) return errorResponse(405, "x");', 'if (pathname === "/api/x/keep") return json({});'] },
        // An alias of the method is a read of it.
        { id: "fr.ts F9", what: "const verb = method.toUpperCase() in the literal's condition", lines: [MATCH, GET_PRIOR, "const verb = method.toUpperCase();", 'if (verb === "POST" && pathname === "/api/x/keep") return json({});'] },
        { id: "fr.ts F10", what: "const verb = method in the literal's condition", lines: [MATCH, GET_PRIOR, "const verb = method;", 'if (verb === "POST" && pathname === "/api/x/keep") return json({});'] },
        { id: "fr.ts F11", what: "switch (verb) around the literal", lines: [MATCH, GET_PRIOR, "const verb = method.toUpperCase();", 'switch (verb) { case "POST": if (pathname === "/api/x/keep") return json({}); }'] },
        { id: "fr.ts F15", what: "body: switch (verb)", lines: [MATCH, GET_PRIOR, "const verb = method.toUpperCase();", KEEP('switch (verb) { case "POST": return json({}); default: return errorResponse(405, "x"); }')] },
        { id: "fr.ts F16", what: "body: if (verb !== POST) 405", lines: [MATCH, GET_PRIOR, "const verb = method.toUpperCase();", KEEP('if (verb !== "POST") return errorResponse(405, "x"); return json({});')] },
        { id: "fr.ts F17", what: "under if (WRITE.has(verb))", lines: [MATCH, GET_PRIOR, "const verb = method;", 'if (WRITE.has(verb)) { if (pathname === "/api/x/keep") return json({}); }'] },
        // A clause falls into the literal's only when it cannot leave.
        { id: "fr2.ts G1", what: "case POST: for (;;) { return }", lines: [MATCH, POST_PRIOR, 'switch (method) { case "POST": for (;;) { return json({ a: 1 }); } case "GET": if (pathname === "/api/x/keep") return json({}); break; }'] },
        { id: "fr2.ts G2", what: "case POST: an inner switch whose cases all return", lines: [MATCH, POST_PRIOR, 'switch (method) { case "POST": switch (body.kind) { case "a": return json({}); case "b": return json({}); } case "GET": if (pathname === "/api/x/keep") return json({}); break; }'] },
        { id: "fr2.ts G3", what: "case POST: blk: { return }", lines: [MATCH, POST_PRIOR, 'switch (method) { case "POST": blk: { return json({}); } case "GET": if (pathname === "/api/x/keep") return json({}); break; }'] },
        { id: "fr2.ts G4", what: "case POST: if (a) return; if (!a) return;", lines: [MATCH, POST_PRIOR, 'switch (method) { case "POST": if (a) return json({}); if (!a) return json({}); case "GET": if (pathname === "/api/x/keep") return json({}); break; }'] },
        { id: "fr2.ts G5", what: "case POST: while (true) { ... return }", lines: [MATCH, POST_PRIOR, 'switch (method) { case "POST": while (true) { const r = await poll(); if (r) return json(r); } case "GET": if (pathname === "/api/x/keep") return json({}); break; }'] },
        // Where the gate still reads it: the path test held first, so the read inside does not matter.
        { id: "a read inside the winner", what: "if (m) { if (!READ.has(method)) 405; return json }", lines: [MATCH, 'if (m) { if (!READ.has(method)) return errorResponse(405, "x"); return json({}); }', LIT("GET")], dead: { methods: ["GET"], kind: "pattern", line: 4 } },
        { id: "a refusal the gate reads", what: "if DELETE; if (method !== GET && method !== HEAD) 405; return json(list)", lines: [MATCH, GET_PRIOR, KEEP('if (method === "DELETE") return json({}); if (method !== "GET" && method !== "HEAD") return errorResponse(405, "x"); return json({ list: [] });')], dead: { methods: ["GET"], kind: "pattern", line: 4 } },
        // The edges of those rules.
        { id: "a break under a label", what: "an unlabelled break inside blk: { } ends the switch being followed", lines: [MATCH, 'if (m) { switch (method) { case "GET": blk: { if (ready) break; } return json({}); } }', LIT("GET")] },
        { id: "a refusal under an unknown if", what: "if (ready) { if (!READ.has(method)) 405 } return json", lines: [MATCH, GET_PRIOR, KEEP('if (ready) { if (!READ.has(method)) return errorResponse(405, "x"); } return json({});')] },
        { id: "a refusal in a switch on something else", what: "switch (kind) { case a: if (!READ.has(method)) 405 } return json", lines: [MATCH, GET_PRIOR, KEEP('switch (kind) { case "a": if (!READ.has(method)) return errorResponse(405, "x"); } return json({});')] },
        { id: "an opaque switch after the winner", what: "switch (method.toLowerCase()) { case post: 405 } before a literal that names no method", lines: [MATCH, GET_PRIOR, 'switch (method.toLowerCase()) { case "post": return errorResponse(405, "x"); }', 'if (pathname === "/api/x/keep") return json({});'] },
        { id: "an unread guard after the winner", what: "if (!WRITE.has(method)) return null; before a literal that names GET", lines: [MATCH, GET_PRIOR, "if (!WRITE.has(method)) return null;", LIT("GET")], dead: { methods: ["GET"], kind: "pattern", line: 4 } },
        { id: "an unread refusal before the winner", what: "{ if (!READ.has(method)) 405; if (m) return json }", lines: [MATCH, '{ if (!READ.has(method)) return errorResponse(405, "x"); if (m) return json({}); }', LIT("GET")] },
        { id: "a sub-router handed the path", what: "subRouter(req, url, pathname, method) and audit(pathname, method) read the request, not the method", lines: [MATCH, GET_PRIOR, "const sub = await subRouter(req, url, pathname, method);", "if (sub) return sub;", "audit(pathname, method);", 'if (pathname === "/api/x/keep") return json({});'], dead: { methods: ["GET"], kind: "pattern", line: 4 } },
        { id: "a labelled break in the case", what: "blk: { if (x) break blk; } goes on to the return after it", lines: [MATCH, 'if (m) { switch (method) { case "GET": blk: { if (ready) break blk; } return json({}); } }', LIT("GET")], dead: { methods: ["GET"], kind: "pattern", line: 4 } },
        { id: "a closure in a falling clause", what: "run(() => { return 1; }) in case POST may throw: whether POST falls in is unknown", lines: [MATCH, POST_PRIOR, 'switch (method) { case "POST": run(() => { return 1; }); case "GET": if (pathname === "/api/x/keep") return json({}); break; }'] },
        { id: "a refusal names what it serves", what: "if (method !== GET) 405; then a tail that does not return json", lines: [MATCH, GET_PRIOR, KEEP('if (method !== "GET") return errorResponse(405, "x"); return handle(req);')], dead: { methods: ["GET"], kind: "pattern", line: 4 } },
        { id: "a branch names what it serves", what: "if (method === GET) return handle(req); return 405", lines: [MATCH, GET_PRIOR, KEEP('if (method === "GET") return handle(req); return errorResponse(405, "x");')], dead: { methods: ["GET"], kind: "pattern", line: 4 } },
        { id: "a winner inside a path test", what: "the outer path test is the winner, at its own line", lines: [MATCH, 'if (pathname.startsWith("/api/x/")) {', GET_PRIOR, "}", LIT("GET")], dead: { methods: ["GET"], kind: "prefix", line: 4 } },
        { id: "a path test inside the body", what: "the body names DELETE, then serves under a second path test", lines: [MATCH, GET_PRIOR, KEEP('if (method === "DELETE") return errorResponse(405, "x"); if (pathname.startsWith("/api/x/")) return json({});')], dead: { methods: ["GET"], kind: "pattern", line: 4 } },
      ];
      for (const c of CASES) {
        test(`${c.id}: ${c.what}`, () => {
          const found = inner(c.lines).map((o) => ({ methods: o.methods, kind: o.prior.kind, line: o.prior.line }));
          expect(found).toEqual(c.dead ? [c.dead] : []);
        });
      }

      // realistic.ts: a whole router, correct code. PATCH on the :id block always
      // returns, and the literal refuses PATCH through READ.has(method).
      test("realistic.ts: a router whose literal refuses with READ.has(method) is not a finding", () => {
        const src = `import { json, errorResponse, matchRoute } from "../utils";
const READ = new Set(["GET", "HEAD"]);
export function createThingsRouter(ctx: any) {
  return async function thingsRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    if (!pathname.startsWith("/api/things")) return null;
    const byId = matchRoute(pathname, "/api/things/:id");
    if (byId) {
      switch (method) {
        case "GET": {
          const t = ctx.get(byId.id);
          if (!t) break;               // unknown id: fall to the literal routes below
          return json(t);
        }
        case "PATCH":
          try {
            return json(ctx.patch(byId.id, await req.json()));
          } finally {
            ctx.flush();
          }
        case "DELETE":
          if (byId.id === "keep") break;
          ctx.drop(byId.id);
          return json({ ok: true });
        default:
          break;
      }
    }
    outer: for (const hook of ctx.hooks) {
      switch (method) {
        case "OPTIONS":
          if (hook.skip) continue outer;
          return new Response(null, { status: 204 });
        default:
          break outer;
      }
    }
    if (pathname === "/api/things/keep") {
      if (method === "DELETE") { ctx.clear(); return json({ ok: true }); }
      if (!READ.has(method)) return errorResponse(405, "Method not allowed");
      return json(ctx.keep());
    }
    if (pathname === "/api/things/stats") {
      switch (method.toUpperCase()) {
        case "GET": return json(ctx.stats());
        case "HEAD": return new Response(null);
        default: return errorResponse(405, "x");
      }
    }
    return null;
  };
}`;
        expect(findInnerShadows(src, "things.ts", "thingsRouter")).toEqual([]);
        // The same router with the refusal written as tests the gate reads.
        expect(findInnerShadows(src.replace("!READ.has(method)", 'method !== "GET" && method !== "HEAD"'), "things.ts", "thingsRouter")).toEqual([]);
      });

      // pred.ts P1-P3 and fr2.ts H2-H6: a function declared to answer a boolean
      // or a fixed set of values is a predicate, whatever its ifs return.
      describe("a function typed to answer a value is a predicate", () => {
        const pred = (type: string, rows: string[], head = "") => findInnerShadows(`${head}export function allowed(pathname: string, method: string): ${type} {\n  ${rows.join("\n  ")}\n}`, "a.ts", "aRouter");
        const PUBLIC = 'method === "GET" && pathname.startsWith("/api/public/")';
        const HEALTH = 'method === "GET" && pathname === "/api/public/health"';
        const cases: Array<[string, string, string[], string?]> = [
          ["pred.ts P1", "boolean", ['if (pathname.startsWith("/api/public/")) return method === "GET";', 'if (pathname === "/api/public/health") return method === "GET";', "return false;"]],
          ["pred.ts P2", "boolean", [`if (${PUBLIC}) { audit(pathname); return true; }`, `if (${HEALTH}) { audit(pathname); return true; }`, "return false;"]],
          ["pred.ts P3", "boolean", ["const ok = true;", `if (${PUBLIC}) return ok;`, `if (${HEALTH}) return ok;`, "return false;"]],
          ["fr2.ts H2", "boolean", [`if (${PUBLIC}) return true;`, 'if (pathname === "/api/public/health") return method === "GET" || method === "HEAD";', "return false;"]],
          ["fr2.ts H3", "boolean", [`if (${PUBLIC}) return true;`, `if (${HEALTH}) { audit(pathname); return true; }`, "return false;"]],
          ["fr2.ts H4", "boolean", [`if (${PUBLIC}) return ALLOW;`, `if (${HEALTH}) return ALLOW;`, "return false;"], "const ALLOW = true;\n"],
          ["fr2.ts H5", '"public" | "private"', [`if (${PUBLIC}) return "public";`, `if (${HEALTH}) return "public";`, 'return "private";']],
          ["fr2.ts H6", "boolean", ["const m = method.toUpperCase();", 'if (pathname.startsWith("/api/nodes/")) return m === "GET";', 'if (pathname === C) return m === "POST" || m === "GET";', "return false;"], 'const C = "/api/nodes/delegated-runs";\n'],
        ];
        for (const [id, type, rows, head] of cases) test(`${id}: ${type}`, () => expect(pred(type, rows, head)).toEqual([]));
        test("a router typed to answer a Response is still judged", () => {
          expect(pred("Response | null", [`if (${PUBLIC}) return json({});`, `if (${HEALTH}) return json({});`, "return null;"]).map((o) => o.sample)).toEqual(["/api/public/health"]);
        });
      });
    });

    // The cases the reverifier of the round-2 fix wrote, by the probe file and
    // id they used (adv.ts, and run3.py on the real tree). A read of the
    // method the gate cannot evaluate, in the literal's condition or in one
    // around it, stays unknown when the call is handed the path too. A call
    // that is only handed the method (a log, a trace, a sub-router) refuses
    // nothing, so the routes after it are still judged.
    describe("the reverifier's cases of the round-2 fix", () => {
      const LIT = (verb: string) => `if (method === "${verb}" && pathname === "/api/x/keep") return json({});`;
      const ANY = 'if (pathname === "/api/x/keep") return json({});';
      const GET_PRIOR = 'if (m && method === "GET") return json({});';
      const POST_PRIOR = 'if (m && method === "POST") return json({});';
      const ANY_PRIOR = "if (m) return json({});";
      type Dead = { methods: string[] | null; line: number };
      const CASES: Array<{ id: string; what: string; lines: string[]; dead?: Dead }> = [
        // A condition handed the method and the path still reads the method.
        { id: "adv.ts RP1", what: "the literal under isWrite(method, pathname)", lines: [MATCH, GET_PRIOR, 'if (isWrite(method, pathname)) { if (pathname === "/api/x/keep") return json({}); }'] },
        { id: "adv.ts RP2", what: "allowed(method, pathname) in the literal's own condition", lines: [MATCH, POST_PRIOR, 'if (allowed(method, pathname) && pathname === "/api/x/keep") return json({});'] },
        { id: "adv.ts RP4", what: "the literal under isWrite(method, url.pathname)", lines: [MATCH, GET_PRIOR, 'if (isWrite(method, url.pathname)) { if (pathname === "/api/x/keep") return json({}); }'] },
        { id: "adv.ts RP5", what: "the literal under guestAllowed(pathname, method)", lines: [MATCH, GET_PRIOR, 'if (guestAllowed(pathname, method)) { if (pathname === "/api/x/keep") return json({}); }'] },
        { id: "a refusal handed the path before the winner", what: "if (!allowed(method, pathname)) return 405 may refuse GET before the pattern", lines: ['if (!allowed(method, pathname)) return errorResponse(405, "x");', MATCH, GET_PRIOR, LIT("GET")] },
        // A call only handed the method refuses nothing.
        { id: "adv.ts TB2", what: "metrics.count(method) at the top", lines: ["metrics.count(method);", MATCH, GET_PRIOR, LIT("GET")], dead: { methods: ["GET"], line: 5 } },
        { id: "adv.ts TB3", what: "span.setAttribute(name, method) at the top, a literal that names no method", lines: ['span.setAttribute("http.method", method);', MATCH, ANY_PRIOR, ANY], dead: { methods: null, line: 5 } },
        { id: "adv.ts TB4", what: "log(method) between the winner and a literal that names no method", lines: [MATCH, ANY_PRIOR, "log(method);", ANY], dead: { methods: null, line: 4 } },
        { id: "adv.ts TB5", what: "audit(method) in the body of a literal that names no method", lines: [MATCH, ANY_PRIOR, 'if (pathname === "/api/x/keep") { audit(method); return json({}); }'], dead: { methods: null, line: 4 } },
        { id: "adv.ts TB7", what: "a sub-router handed the method before the winner, its answer passed on", lines: [MATCH, "const r = await sub(req, url, method);", "if (r) return r;", GET_PRIOR, LIT("GET")], dead: { methods: ["GET"], line: 6 } },
        { id: "adv.ts TB8", what: "const verb = method; ctx.log(verb) at the top", lines: ["const verb = method;", "ctx.log(verb);", MATCH, GET_PRIOR, LIT("GET")], dead: { methods: ["GET"], line: 6 } },
        { id: "a sub-router handed the path before the winner", what: "const r = await sub(req, url, pathname, method); if (r) return r;", lines: [MATCH, "const r = await sub(req, url, pathname, method);", "if (r) return r;", GET_PRIOR, LIT("GET")], dead: { methods: ["GET"], line: 6 } },
        // terminal.ts:3275: a refusal that the method alone never makes certain is not a gate.
        { id: "a refusal the method alone never decides", what: "if (!ready && isRosterRoute(pathname, method)) return 503 before the winner", lines: ['if (!ready && isRosterRoute(pathname, method)) return errorResponse(503, "x");', MATCH, GET_PRIOR, LIT("GET")], dead: { methods: ["GET"], line: 5 } },
        { id: "an else the method alone never decides", what: "if (ready || READ.has(method)) { log(); } else { return 405 } before the winner", lines: ['if (ready || READ.has(method)) { log(); } else { return errorResponse(405, "x"); }', MATCH, GET_PRIOR, LIT("GET")], dead: { methods: ["GET"], line: 5 } },
        // Still unknown: a refusal the gate cannot read, before the winner, may be a gate for GET.
        { id: "adv.ts TB1", what: "if (!ALLOWED.has(method)) return 405 at the top", lines: ['if (!ALLOWED.has(method)) return errorResponse(405, "x");', MATCH, GET_PRIOR, LIT("GET")] },
        { id: "a refusal the method alone may decide", what: "if (!ready || !READ.has(method)) return 405 before the winner", lines: ['if (!ready || !READ.has(method)) return errorResponse(405, "x");', MATCH, GET_PRIOR, LIT("GET")] },
        { id: "a refusal under a negation", what: "if (!(ready && READ.has(method))) return 405 before the winner", lines: ['if (!(ready && READ.has(method))) return errorResponse(405, "x");', MATCH, GET_PRIOR, LIT("GET")] },
        { id: "a check that names the methods", what: "requireMethod(method, \"POST\") before the winner", lines: ['requireMethod(method, "POST");', MATCH, GET_PRIOR, LIT("GET")] },
        { id: "a check passed on", what: "const r = allowMethods(method, [GET]); if (r) return r; before the winner", lines: ['const r = allowMethods(method, ["GET"]);', "if (r) return r;", MATCH, POST_PRIOR, LIT("POST")] },
        { id: "an answer of the method alone passed on", what: "const r = await methodGuard(method); if (r) return r; before the winner", lines: ["const r = await methodGuard(method);", "if (r) return r;", MATCH, POST_PRIOR, LIT("POST")] },
        { id: "a sub-router's answer in the body", what: "in the literal's body it may be a refusal", lines: [MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { const r = await sub(req, url, method); if (r) return r; return json({}); }'] },
        // An alias of the method through more names than three.
        { id: "adv.ts AL6", what: "v4 after v1 = method, v2 = v1, v3 = v2, v4 = v3, in the condition around the literal", lines: [MATCH, GET_PRIOR, "const v1 = method; const v2 = v1; const v3 = v2; const v4 = v3;", 'if (v4 === "POST") { if (pathname === "/api/x/keep") return json({}); }'] },
      ];
      for (const c of CASES) {
        test(`${c.id}: ${c.what}`, () => {
          const found = inner(c.lines).map((o) => ({ methods: o.methods, line: o.prior.line }));
          expect(found).toEqual(c.dead ? [c.dead] : []);
        });
      }

      // run3.py z-trace-before-winner and z-span-top-of-block: one statement
      // that hands the method to a call, above browser.ts:229.
      for (const trace of ["recordMethod(method);", 'span.setAttribute("http.method", method);']) {
        test(`run3.py: ${trace} above GET /api/browsers/:id keeps the keep-list finding`, () => {
          const o = inner([trace, ...BY_ID, 'if (method === "GET" && pathname === "/api/browsers/data-store-keep-list") return json({});']);
          expect(o.map((x) => [x.sample, x.methods, x.prior.line])).toEqual([["/api/browsers/data-store-keep-list", ["GET"], 5]]);
        });
      }
    });

    // The cases the verifiers of the round-3 fix wrote, by the probe file and
    // id they used (fl.ts, fl2.ts, fl3.ts, mutrows.ts, distinguish.ts,
    // dist2.ts, subvariants.ts, harmless.ts, run4.py). A name whose value is
    // made of a read of the method is that read; `null`, `undefined` and
    // `false` are false; the name of a field, or a callback's own parameter,
    // is not the request; a call refuses the method only when it names a
    // method or its name says it checks; a sub-router's answer passed on
    // refuses nothing, chained or logged.
    describe("the verifiers' cases of the round-3 fix", () => {
      const LIT = (verb: string) => `if (method === "${verb}" && pathname === "/api/x/keep") return json({});`;
      const ANY = 'if (pathname === "/api/x/keep") return json({});';
      const GET_PRIOR = 'if (m && method === "GET") return json({});';
      const POST_PRIOR = 'if (m && method === "POST") return json({});';
      const BEFORE = (...lines: string[]) => [...lines, MATCH, GET_PRIOR, LIT("GET")];
      const BETWEEN = (...lines: string[]) => [MATCH, GET_PRIOR, ...lines, ANY];
      const OWN = (cond: string) => `if (${cond} && pathname === "/api/x/keep") return json({});`;
      type Dead = { methods: string[] | null; line: number };
      const GET4: Dead = { methods: ["GET"], line: 4 };
      const CASES: Array<{ id: string; what: string; lines: string[]; dead?: Dead }> = [
        // A name that holds a read of the method is that read (blocker 1).
        { id: "fl2.ts N2", what: "const kind = methodKind(method); kind === \"write\" in the literal's condition", lines: [MATCH, GET_PRIOR, "const kind = methodKind(method);", OWN('kind === "write"')] },
        { id: "fl2.ts N4", what: "const op = OPS[method]; op === \"save\"", lines: [MATCH, GET_PRIOR, "const op = OPS[method];", OWN('op === "save"')] },
        { id: "fl.ts D10", what: "const verb = override ?? method; verb === \"DELETE\"", lines: [MATCH, GET_PRIOR, 'const verb = req.headers.get("x-http-method-override") ?? method;', OWN('verb === "DELETE"')] },
        { id: "fl.ts D11", what: "const verb = String(method); verb === \"POST\"", lines: [MATCH, GET_PRIOR, "const verb = String(method);", OWN('verb === "POST"')] },
        { id: "fl3.ts closure", what: "const is = (v) => method === v; is(\"POST\")", lines: ["const is = (v: string) => method === v;", MATCH, GET_PRIOR, OWN('is("POST")')] },
        { id: "fl.ts D13", what: "tasks.ts:2834: const guestAction = matchGuestTaskAction(pathname, id, method)", lines: [MATCH, GET_PRIOR, 'const guestAction = matchGuestTaskAction(pathname, m?.id ?? "", method);', OWN('guestAction === "edit"')] },
        { id: "fl.ts D7", what: "const kind = methodKind(method); switch (kind) around the literal", lines: [MATCH, GET_PRIOR, "const kind = methodKind(method);", 'switch (kind) { case "write": if (pathname === "/api/x/keep") return json({}); }'] },
        { id: "fl2.ts N8", what: "the literal under if (kind === \"write\")", lines: [MATCH, GET_PRIOR, "const kind = methodKind(method);", 'if (kind === "write") { if (pathname === "/api/x/keep") return json({}); }'] },
        { id: "fl2.ts N9", what: "const writable = isWrite(method); a refusal on it between the winner and the literal", lines: [MATCH, GET_PRIOR, "const writable = isWrite(method);", 'if (writable === false) return errorResponse(405, "x");', ANY] },
        { id: "fl.ts D4", what: "const { canWrite } = accessFor(method, pathname)", lines: [MATCH, GET_PRIOR, "const { canWrite } = accessFor(method, pathname);", OWN("canWrite")] },
        { id: "fl.ts A3", what: "const [verb] = [method]", lines: [MATCH, GET_PRIOR, "const [verb] = [method];", OWN('verb === "POST"')] },
        { id: "adv.ts AL3", what: "let verb = method; verb = norm(verb)", lines: [MATCH, GET_PRIOR, "let verb = method;", "verb = norm(verb);", 'if (verb === "POST") { if (pathname === "/api/x/keep") return json({}); }'] },
        { id: "fl.ts A7", what: "const verb = (method ?? \"GET\") as string", lines: [MATCH, GET_PRIOR, 'const verb = (method ?? "GET") as string;', OWN('verb === "POST"')] },
        // tasks.ts guest block: the method picks how it leaves, not whether.
        { id: "sens199 tasks.ts guest block", what: "a block that always leaves under an unknown condition, method reads inside, before the winner", lines: BEFORE('if (ctx.guest) { const action = guestAction(pathname, method); if (action === "none") return errorResponse(403, "x"); return json({}); }'), dead: { methods: ["GET"], line: 5 } },
        // null, undefined and false are false (blocker 2).
        { id: "fl2.ts N6", what: "history.ts:85: const body = method === \"POST\" ? await readJSON(req) : null; body && literal", lines: [MATCH, GET_PRIOR, 'const body = method === "POST" ? await readJSON(req) : null;', OWN("body")] },
        { id: "fl2.ts N5", what: "the same ternary inline", lines: [MATCH, GET_PRIOR, OWN('(method === "POST" ? await readJSON(req) : null)')] },
        { id: "fl.ts D8", what: "const body = method === \"GET\" ? null : await readJSON(req)", lines: [MATCH, GET_PRIOR, 'const body = method === "GET" ? null : await readJSON(req);', OWN("body")] },
        { id: "undefined", what: "the ternary picks undefined for GET", lines: [MATCH, GET_PRIOR, 'const body = method === "POST" ? await readJSON(req) : undefined;', OWN("body")] },
        { id: "false", what: "the ternary picks false for GET", lines: [MATCH, GET_PRIOR, 'const body = method === "POST" ? await readJSON(req) : false;', OWN("body")] },
        { id: "POST still reaches", what: "the same body with a POST pattern before: POST is served", lines: [MATCH, POST_PRIOR, 'const body = method === "POST" ? await readJSON(req) : null;', OWN("body")], dead: { methods: ["POST"], line: 4 } },
        // The name of a field, or a callback's own parameter, is not the request (major 3).
        { id: "fl2.ts O1", what: "the body tests q.method, a field of a local", lines: [MATCH, GET_PRIOR, 'if (method === "GET" && pathname === "/api/x/keep") { const q = parse(url); if (q.method === "list") return json({}); return json({}); }'], dead: GET4 },
        { id: "fl2.ts O2", what: "the body hands fetch { method: \"POST\" } in a condition", lines: [MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { if (!(await fetch(u, { method: "POST" })).ok) return errorResponse(502, "x"); return json({}); }'], dead: GET4 },
        { id: "fl2.ts O3", what: "if (job.method === \"legacy\") return 410 between the winner and the literal", lines: [MATCH, GET_PRIOR, "const job = loadJob();", 'if (job.method === "legacy") return errorResponse(410, "x");', ANY], dead: GET4 },
        { id: "fl2.ts O4", what: "opts.method in the literal's own condition", lines: [MATCH, GET_PRIOR, "const opts = loadOpts();", OWN('opts.method !== "off"')], dead: GET4 },
        { id: "run4.py lost-row-field", what: "pendingCalls.some((c) => c.method === \"reap\") in the body", lines: [MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { if (pendingCalls.some((c) => c.method === "reap")) return errorResponse(409, "x"); return json({}); }'], dead: GET4 },
        { id: "a field named like a local", what: "job.kind next to const kind = methodKind(method)", lines: [MATCH, GET_PRIOR, "const kind = methodKind(method);", "const job = loadJob();", OWN('job.kind === "sync"')], dead: GET4 },
        { id: "a callback that reads the outer method", what: "the literal under WRITES.some((v) => v === method)", lines: [MATCH, GET_PRIOR, 'if (WRITES.some((v) => v === method)) { if (pathname === "/api/x/keep") return json({}); }'] },
        // A call refuses the method only when it names one or says it checks (majors 4, 5, 9).
        { id: "run4.py w-console-tag", what: "console.log(\"REQ\", method, pathname) before the winner", lines: BEFORE('console.log("REQ", method, pathname);'), dead: { methods: ["GET"], line: 5 } },
        { id: "run4.py w-metric-caps", what: "metrics.increment(\"HTTP\", method) before the winner", lines: BEFORE('metrics.increment("HTTP", method);'), dead: { methods: ["GET"], line: 5 } },
        { id: "harmless.ts auditOk", what: "audit(req, method, \"OK\") in the body", lines: [MATCH, GET_PRIOR, 'if (method === "GET" && pathname === "/api/x/keep") { audit(req, method, "OK"); return json({}); }'], dead: GET4 },
        { id: "harmless.ts emitCaps", what: "emit(\"REQUEST\", method) between the winner and the literal", lines: BETWEEN('emit("REQUEST", method);'), dead: GET4 },
        { id: "distinguish.ts M49", what: "requireUser(req) is not handed the method", lines: BEFORE("requireUser(req);"), dead: { methods: ["GET"], line: 5 } },
        { id: "distinguish.ts M50", what: "ctx.assertWrite(method) before the winner", lines: BEFORE("ctx.assertWrite(method);") },
        { id: "distinguish.ts MX_assert", what: "assertWrite(method) before the winner", lines: BEFORE("assertWrite(method);") },
        { id: "distinguish.ts M46", what: "checkout(method): its first word is not check", lines: BEFORE("checkout(method);"), dead: { methods: ["GET"], line: 5 } },
        { id: "distinguish.ts M47", what: "logcheck(method): check is not its first word", lines: BEFORE("logcheck(method);"), dead: { methods: ["GET"], line: 5 } },
        { id: "mutrows.ts lookahead", what: "expectedStatus(method) between the winner and the literal", lines: BETWEEN("expectedStatus(method);"), dead: GET4 },
        { id: "distinguish.ts M59", what: "allowMethod(method, \"POST\" as Method) before the winner", lines: BEFORE('allowMethod(method, "POST" as Method);') },
        { id: "distinguish.ts M53", what: "log(method, []) names no method", lines: BEFORE("log(method, []);"), dead: { methods: ["GET"], line: 5 } },
        { id: "distinguish.ts M54", what: "allow(method, [\"GET\", other]) names one", lines: BEFORE('allow(method, ["GET", other]);') },
        { id: "mutrows.ts array", what: "trace(method, [pathname]) names no method", lines: BETWEEN("trace(method, [pathname]);"), dead: GET4 },
        { id: "fl.ts H8", what: "enforceMethod(method, \"POST\") between the winner and the literal", lines: BETWEEN('enforceMethod(method, "POST");') },
        { id: "a method list", what: "allowMethods(method, [\"POST\", \"PUT\"]) between the winner and the literal", lines: BETWEEN('allowMethods(method, ["POST", "PUT"]);') },
        // The ternary and the sides of an unknown if (majors 4, 7, 17).
        { id: "mutrows.ts ternary", what: "if (ctx.strict ? isWrite(method) : ctx.flag) return 403: the method alone never decides", lines: BETWEEN('if (ctx.strict ? isWrite(method) : ctx.flag) return errorResponse(403, "x");'), dead: GET4 },
        { id: "dist2.ts M09", what: "if (ready ? !READ.has(method) : !SAFE.has(method)) return 405 before the winner", lines: BEFORE('if (ready ? !READ.has(method) : !SAFE.has(method)) return errorResponse(405, "x");') },
        { id: "dist2.ts M10", what: "if (isWrite(method) ? !READ.has(method) : ready) return 405 before the winner", lines: BEFORE('if (isWrite(method) ? !READ.has(method) : ready) return errorResponse(405, "x");') },
        { id: "dist2.ts M11", what: "if (isRead(method) ? ready : !WRITE.has(method)) return 405 before the winner", lines: BEFORE('if (isRead(method) ? ready : !WRITE.has(method)) return errorResponse(405, "x");') },
        { id: "dist2.ts M12", what: "if (ready ? !READ.has(method) : pathname === \"/nope\") return 405: the method alone never decides", lines: BEFORE('if (ready ? !READ.has(method) : pathname === "/nope") return errorResponse(405, "x");'), dead: { methods: ["GET"], line: 5 } },
        { id: "distinguish.ts M13", what: "if (isWrite(method) ? needsAuth : false) return 401: the method alone never decides", lines: BEFORE('if (isWrite(method) ? needsAuth : false) return errorResponse(401, "x");'), dead: { methods: ["GET"], line: 5 } },
        { id: "distinguish.ts M27", what: "if (READ.has(method)) { log(); } else { return 405 } before the winner", lines: BEFORE('if (READ.has(method)) { log(); } else { return errorResponse(405, "x"); }') },
        { id: "mutants.py M33", what: "a refusal on the else side of a condition that does not read the method", lines: BEFORE('if (ready) { log(); } else if (!READ.has(method)) return errorResponse(405, "x");') },
        { id: "both sides leave", what: "the body answers on WRITE.has(method) and refuses otherwise", lines: [MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { if (WRITE.has(method)) { return json({}); } else { return errorResponse(405, "x"); } }'] },
        { id: "a refusal under a flag", what: "the body serves GET when the flag is off", lines: [MATCH, GET_PRIOR, 'if (pathname === "/api/x/keep") { if (ready) { if (!READ.has(method)) return errorResponse(405, "x"); return json({}); } return json({}); }'], dead: GET4 },
        // A sub-router's answer passed on (majors 6, 8).
        { id: "subvariants.ts sub || chain", what: "(await a(...)) || (await b(...)) passed on before the winner", lines: BEFORE("const r = (await a(req, url, pathname, method)) || (await b(req, url, pathname, method));", "if (r) return r;"), dead: { methods: ["GET"], line: 6 } },
        { id: "subvariants.ts sub ?? chain", what: "(await a(...)) ?? (await b(...)) passed on before the winner", lines: BEFORE("const r = (await a(req, url, pathname, method)) ?? (await b(req, url, pathname, method));", "if (r) return r;"), dead: { methods: ["GET"], line: 6 } },
        { id: "subvariants.ts sub then logs", what: "if (r) { log.debug(...); return r; } before the winner", lines: BEFORE("const r = await sub(req, url, pathname, method);", 'if (r) { log.debug("sub answered"); return r; }'), dead: { methods: ["GET"], line: 6 } },
        { id: "distinguish.ts M39", what: "if (r) { return r; } before the winner", lines: BEFORE("const r = await sub(req, url, method);", "if (r) { return r; }"), dead: { methods: ["GET"], line: 6 } },
        { id: "distinguish.ts M42", what: "(await sub(...)) ?? null passed on before the winner", lines: BEFORE("const r = (await sub(req, url, method)) ?? null;", "if (r) return r;"), dead: { methods: ["GET"], line: 6 } },
        { id: "harmless.ts subNotNull", what: "if (r !== null) return r before the winner", lines: BEFORE("const r = await sub(req, url, method);", "if (r !== null) return r;"), dead: { methods: ["GET"], line: 6 } },
        { id: "harmless.ts subObj", what: "sub({ req, url, pathname, method }) passed on before the winner", lines: BEFORE("const r = await sub({ req, url, pathname, method });", "if (r) return r;"), dead: { methods: ["GET"], line: 6 } },
        { id: "harmless.ts subCatch", what: "sub(req, url, method).catch(() => null) passed on before the winner", lines: BEFORE("const r = await sub(req, url, method).catch(() => null);", "if (r) return r;"), dead: { methods: ["GET"], line: 6 } },
        { id: "harmless.ts subInstance", what: "if (r instanceof Response) return r before the winner: a global in the condition is not a local", lines: BEFORE("const r = await sub(req, url, method);", "if (r instanceof Response) return r;"), dead: { methods: ["GET"], line: 6 } },
        { id: "distinguish.ts M40", what: "an answer turned into a 403 before the winner", lines: BEFORE("const denied = await policy(req, url, method);", 'if (denied) return errorResponse(403, "x");') },
        { id: "distinguish.ts M41", what: "if (r) return forbidden before the winner", lines: BEFORE("const r = await policy(req, url, method);", "if (r) return forbidden;") },
        { id: "a way out before return r", what: "if (r) { if (x) return other; return r; } before the winner", lines: BEFORE("const r = await sub(req, url, method);", "if (r) { if (x) return other; return r; }") },
        { id: "a condition that reads the method too", what: "if (r && WRITE.has(method)) return r before the winner", lines: BEFORE("const r = await sub(req, url, method);", "if (r && WRITE.has(method)) return r;") },
        { id: "fl.ts H6", what: "methodGuard(method, WRITE_METHODS) is handed no request: its answer may be a refusal", lines: BETWEEN("const refused = methodGuard(method, WRITE_METHODS);", "if (refused) return refused;") },
        { id: "a request handed for its method", what: "methodGuard(req.method, WRITE_METHODS): its answer may be a refusal", lines: BETWEEN("const refused = methodGuard(req.method, WRITE_METHODS);", "if (refused) return refused;") },
        { id: "a check handed the request", what: "const r = await allowMethods(req, method, [\"POST\"]); if (r) return r; before the winner", lines: BEFORE('const r = await allowMethods(req, method, ["POST"]);', "if (r) return r;") },
        // A switch that reads the method in a label, a loop on the method (minor 14).
        { id: "fl.ts W3", what: "switch (true) { case method === \"POST\": literal }", lines: [MATCH, GET_PRIOR, 'switch (true) { case method === "POST": if (pathname === "/api/x/keep") return json({}); }'] },
        { id: "fl.ts W5", what: "while (method === \"POST\") { literal; break; }", lines: [MATCH, GET_PRIOR, 'while (method === "POST") { if (pathname === "/api/x/keep") return json({}); break; }'] },
        { id: "a loop on GET", what: "while (method === \"GET\") { literal; break; }", lines: [MATCH, GET_PRIOR, 'while (method === "GET") { if (pathname === "/api/x/keep") return json({}); break; }'], dead: GET4 },
      ];
      for (const c of CASES) {
        test(`${c.id}: ${c.what}`, () => {
          const found = inner(c.lines).map((o) => ({ methods: o.methods, line: o.prior.line }));
          expect(found).toEqual(c.dead ? [c.dead] : []);
        });
      }

      // Every first word of CHECK_VERBS makes a call handed the method a refusal.
      for (const verb of ["assert", "require", "ensure", "check", "verify", "validate", "expect", "guard", "reject", "deny", "forbid", "only", "must", "allow", "throw"]) {
        test(`${verb}Writes(method) between the winner and the literal may refuse GET`, () => {
          expect(shadowed(BETWEEN(`${verb}Writes(method);`))).toEqual([]);
        });
      }

      // Every name of HTTP_METHODS is a method a call can compare the method with.
      for (const name of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        test(`permit(method, "${name}") between the winner and the literal may refuse GET`, () => {
          expect(shadowed(BETWEEN(`permit(method, "${name}");`))).toEqual([]);
        });
      }

      // run4.py on browser.ts:229 as it is.
      const KEEP = 'if (method === "GET" && pathname === "/api/browsers/data-store-keep-list") return json({});';
      const RECENT = (cond: string) => `if (${cond} && pathname === "/api/browsers/recent") return json({ ok: true });`;
      test("run4.py fr-stored-kind, fr-guest-action, fr-body-per-method: correct code below GET /api/browsers/:id", () => {
        expect(inner([...BY_ID, "const recentKind = methodKind(method);", RECENT('recentKind === "write"')])).toEqual([]);
        expect(inner([...BY_ID, "const recentAction = recentActionFor(pathname, method);", RECENT('recentAction === "clear"')])).toEqual([]);
        expect(inner([...BY_ID, 'const recentBody = method === "POST" ? await readJSON(req) : null;', RECENT("recentBody")])).toEqual([]);
      });
      for (const [id, lines] of [
        ["lost-field-guard-before-winner", ["const pendingOp = browserService.pendingOp?.();", 'if (pendingOp?.method === "reset") return errorResponse(409, "browser resetting", { log: false });']],
        ["w-console-tag", ['console.log("REQ", method, pathname);']],
        ["w-sub-or", ["const subr = (await extraA(req, url, pathname, method)) || (await extraB(req, url, pathname, method));", "if (subr) return subr;"]],
        ["w-sub-nullish", ["const subr = (await extraA(req, url, pathname, method)) ?? (await extraB(req, url, pathname, method));", "if (subr) return subr;"]],
      ] as const) {
        test(`run4.py ${id}: above GET /api/browsers/:id the keep-list route is still found`, () => {
          const o = inner([...lines, ...BY_ID, KEEP]);
          expect(o.map((x) => [x.sample, x.methods, x.prior.line])).toEqual([["/api/browsers/data-store-keep-list", ["GET"], 4 + lines.length]]);
        });
      }
      test("run4.py lost-fetch-in-keep-list-body, w-body-console: in the keep-list body", () => {
        for (const line of ['if (!(await fetch(KEEP_MIRROR, { method: "HEAD" })).ok) return errorResponse(503, "mirror down");', 'console.log("REQ", method, pathname);'])
          expect(shadowed([...BY_ID, `if (method === "GET" && pathname === "/api/browsers/data-store-keep-list") { ${line} return json({}); }`])).toEqual(["/api/browsers/data-store-keep-list"]);
      });
    });

    // The reverifier of the round-3 fix (df0cbab2e7) measured it against
    // main row by row (mine.ts, inner.ts, types.ts, mutrows.ts, run5.py,
    // inj4.py): here each row where it was worse than main, or than a round
    // before it, and a row for each mutant of new code that survived. A
    // parameter of the factory is not the request, a helper's own parameter
    // or a type is not a read of the method, a router handed to a wrapper is
    // still a router, and a throw out of a try lands in its catch.
    describe("the rows where the round-3 fix was worse than main", () => {
      const K = '"/api/x/keep"';
      const ANY = `if (pathname === ${K}) return json({});`;
      const LIT = `if (method === "GET" && pathname === ${K}) return json({});`;
      const GET_PRIOR = 'if (m && method === "GET") return json({});';
      const POST_PRIOR = 'if (m && method === "POST") return json({});';
      const BETWEEN = (...lines: string[]) => [MATCH, GET_PRIOR, ...lines, ANY];
      const GET_BODY = (body: string) => [MATCH, GET_PRIOR, `if (method === "GET" && pathname === ${K}) { ${body} return json({}); }`];
      type Dead = { methods: string[] | null; line: number };
      const GET4: Dead = { methods: ["GET"], line: 4 };
      const ANY4: Dead = { methods: null, line: 4 };
      const CASES: Array<{ id: string; what: string; lines: string[]; dead?: Dead }> = [
        // A method guard reached through a parameter of the factory may refuse (blocker 1).
        { id: "mine.ts PO1", what: "ctx.methodGuard(method, POST_ONLY) passed on between the winner and the literal", lines: BETWEEN("const bad = ctx.methodGuard(method, POST_ONLY);", "if (bad) return bad;") },
        { id: "mine.ts PO2", what: "ctx.guards.refuse(method, WRITES) passed on", lines: BETWEEN("const denied = ctx.guards.refuse(method, WRITES);", "if (denied) return denied;") },
        { id: "mine.ts PO3", what: "methodGuard(ctx, method, POST_ONLY) passed on", lines: BETWEEN("const bad = methodGuard(ctx, method, POST_ONLY);", "if (bad) return bad;") },
        { id: "mine.ts PO4", what: "ctx.notAllowed(method, POST_ONLY) || null passed on", lines: BETWEEN("const bad = ctx.notAllowed(method, POST_ONLY) || null;", "if (bad) return bad;") },
        { id: "mine.ts PO6", what: "ctx.methodGuard(method, WRITES) passed on before the winner", lines: ["const bad = ctx.methodGuard(method, WRITES);", "if (bad) return bad;", MATCH, POST_PRIOR, ANY] },
        { id: "mutrows.ts CHAIN", what: "a sub-router's answer || a method guard's: the guard may refuse", lines: BETWEEN("const r = (await sub(req, url, pathname, method)) || methodGuard(method, POST_ONLY);", "if (r) return r;") },
        { id: "a field named like a parameter", what: "methodGuard(method, cfg.url): cfg.url is not the request", lines: BETWEEN("const bad = methodGuard(method, cfg.url);", "if (bad) return bad;") },
        // A helper's own parameter named method is not the request (major 3).
        { id: "inner.ts RM1", what: "const label = (method) => method.toLowerCase(); a test of label() before the literal", lines: [MATCH, "if (m) return json({});", "const label = (method: string) => method.toLowerCase();", 'if (label(kind) === "x") return errorResponse(410, "x");', ANY], dead: ANY4 },
        { id: "inner.ts RM2", what: "the same helper in the GET body", lines: GET_BODY('const label = (method: string) => method.toLowerCase(); if (label(q) === "x") return json({ a: 1 });'), dead: GET4 },
        // A type, or the name of a method of an object, reads nothing (major 4).
        { id: "types.ts T1", what: "a cast to { method?: string } in the GET body", lines: GET_BODY('const row = db.get() as { method?: string } | null; if (row?.method === "manual") return json({ a: 1 });'), dead: GET4 },
        { id: "types.ts T2", what: "a generic { method: string } in the GET body", lines: GET_BODY('const row = db.query<{ method: string }>("q").get(); if (!row) return json({});'), dead: GET4 },
        { id: "types.ts T5", what: "a cast before the literal, any method", lines: [MATCH, "if (m) return json({});", "const job = queue.peek() as { method: string } | undefined;", 'if (job?.method === "legacy") return errorResponse(410, "x");', ANY], dead: ANY4 },
        { id: "types.ts T6", what: "an object with a method named method in the GET body", lines: GET_BODY('const h = { method() { return 1; } }; if (!h.method()) return errorResponse(500, "x");'), dead: GET4 },
        { id: "types.ts T7", what: "satisfies Partial<{ method: string }> in the GET body", lines: GET_BODY('const opts = { mode: "x" } satisfies Partial<{ method: string; mode: string }>; if (opts.mode === "y") return json({ y: 1 });'), dead: GET4 },
        // A throw out of the try lands in the catch (minor 7).
        { id: "mine.ts MK3", what: "a try that leaves through a refusal of the method, with a catch that goes on", lines: BETWEEN('try { if (!WRITE.has(method)) return errorResponse(405, "x"); return json(await save()); } catch (e) { log(e); }') },
        { id: "mutrows.ts TRYC", what: "a try whose path test held, with a catch that refuses: the winner", lines: [MATCH, 'try { if (m) return json(get(m)); return json(list()); } catch (e) { if (!WRITE.has(method)) return errorResponse(405, "x"); return json({}); }', ANY], dead: ANY4 },
        { id: "a catch that goes on", what: "a try whose path test held, with a catch that logs: a throw reaches the literal", lines: [MATCH, "try { if (m) return json(get(m)); } catch (e) { log(e); }", ANY] },
        // Correct code main gives no finding on (b69 and later did): a 200 can
        // refuse, a call in a clause may throw before it falls through.
        { id: "fl.ts H11", what: "the body refuses non-POST with a one-arg json", lines: [MATCH, GET_PRIOR, `if (pathname === ${K}) { if (method !== "POST") return json({ error: "POST only" }); return json({}); }`] },
        { id: "fl.ts W4", what: "case GET: fail(405) falls into the literal's case POST", lines: [MATCH, GET_PRIOR, `switch (method) { case "GET": fail(405); case "POST": if (pathname === ${K}) return json({}); }`] },
        { id: "fl3.ts W4b", what: "case GET: methodNotAllowed() falls into the literal's case POST", lines: [MATCH, GET_PRIOR, `switch (method) { case "GET": methodNotAllowed(); case "POST": if (pathname === ${K}) return json({}); }`] },
        // Checks an earlier round saw and the round-3 fix did not.
        { id: "fl.ts H7", what: "allowMethods(method, WRITES) between the winner and the literal", lines: BETWEEN("allowMethods(method, WRITES);") },
        { id: "mine.ts CK6", what: "throwUnlessWrite(method) between the winner and the literal", lines: BETWEEN("throwUnlessWrite(method);") },
        { id: "mine.ts CK7", what: "require_post(method): a check named in snake case", lines: BETWEEN("require_post(method);") },
        { id: "mine.ts CK8", what: "allow(method, \"WRITE\") between the winner and the literal", lines: BETWEEN('allow(method, "WRITE");') },
        // A call with no check verb that names a method: the names, not the verb.
        { id: "a cast names a method", what: "permit(method, \"POST\" as Method) between the winner and the literal", lines: BETWEEN('permit(method, "POST" as Method);') },
        { id: "an array that names one", what: "permit(method, [\"GET\", other]) between the winner and the literal", lines: BETWEEN('permit(method, ["GET", other]);') },
        { id: "a list of methods", what: "permit(method, [\"POST\", \"PUT\"]) between the winner and the literal", lines: BETWEEN('permit(method, ["POST", "PUT"]);') },
        // The mutants that survived the round-3 file (major 6).
        { id: "mutrows.ts REC", what: "a closure that calls itself", lines: [MATCH, GET_PRIOR, "const retry = async (n: number): Promise<Response | null> => (n > 0 ? retry(n - 1) : null);", `if ((await retry(2)) && method === "POST" && pathname === ${K}) return json({});`] },
        { id: "mutrows.ts FOR", what: "for (; method === \"POST\";) { literal; break; }", lines: [MATCH, GET_PRIOR, `for (; method === "POST";) { if (pathname === ${K}) return json({}); break; }`] },
        { id: "a nested exit", what: "the body leaves under a flag through a test of the method, and refuses otherwise", lines: [MATCH, GET_PRIOR, `if (pathname === ${K}) { if (ready) { if (WRITE.has(method)) return json({}); return errorResponse(405, "x"); } else { return errorResponse(405, "x"); } }`] },
      ];
      for (const c of CASES) {
        test(`${c.id}: ${c.what}`, () => {
          const found = inner(c.lines).map((o) => ({ methods: o.methods, line: o.prior.line }));
          expect(found).toEqual(c.dead ? [c.dead] : []);
        });
      }

      // A router handed to a wrapper is still the router (major 5).
      test("mine.ts WR1, WR2, WR4, WR5: a router passed as an argument is still judged", () => {
        const wrapped = (open: string, lines: string[]) => findInnerShadows(`export function create(ctx: any, routes: any) {\n  ${open} {\n    ${lines.join("\n    ")}\n    return null;\n  });\n}`, "a.ts", "a").map((o) => [o.methods, o.prior.line]);
        const params = "(req: Request, url: URL, pathname: string, method: string)";
        expect(wrapped(`return withTiming(async function r${params}`, [MATCH, GET_PRIOR, LIT])).toEqual([[["GET"], 4]]);
        expect(wrapped(`return guarded(ctx, async ${params} =>`, [MATCH, GET_PRIOR, LIT])).toEqual([[["GET"], 4]]);
        expect(wrapped(`routes.push(async ${params} =>`, [MATCH, GET_PRIOR, LIT])).toEqual([[["GET"], 4]]);
        expect(wrapped(`return withTiming(async function r${params}`, [MATCH, "if (m) return json({});", ANY])).toEqual([[null, 4]]);
      });

      // run5.py and inj4.py on browser.ts as it is.
      test("run5.py q-ctx-method-guard, q-ctl-method-guard: a method guard below GET /api/browsers/:id refuses GET", () => {
        for (const guard of ["ctx.methodGuard(method, WRITE_METHODS)", "methodGuard(method, WRITE_METHODS)"])
          expect(inner([...BY_ID, 'if (pathname.startsWith("/api/browsers/re")) {', `  const refused = ${guard};`, "  if (refused) return refused;", '  if (pathname === "/api/browsers/recent") return json({ ok: true });', "}"])).toEqual([]);
      });
      test("run5.py q-keep-helper-param, inj4.py t-keep-row-method: the keep-list route is still found", () => {
        for (const line of [
          'const label = (method: string) => method.toLowerCase(); if (label(url.searchParams.get("m") ?? "") === "legacy") return json({ contextIds: [] });',
          'const legacy = ctx.db.query("SELECT method FROM reaper_runs LIMIT 1").get() as { method?: string } | null; if (legacy?.method === "manual") return json({ contextIds: [] });',
        ]) expect(shadowed([...BY_ID, `if (method === "GET" && pathname === "/api/browsers/data-store-keep-list") { ${line} return json({}); }`])).toEqual(["/api/browsers/data-store-keep-list"]);
      });
    });

    // A boolean helper next to the router (server.ts guestAllowed): a
    // predicate, not a route. The router function is still judged.
    test("H1: a predicate that answers true for a path is not a route", () => {
      const file = (route: string) => `/** Paths a guest may call: a predicate, not a route. */
export function guestAllowed(pathname: string, method: string): boolean {
  if (method === "GET" && pathname.startsWith("/api/public/")) return true;
  if (method === "GET" && pathname === "/api/public/health") return true;
  return false;
}
export function createARouter(ctx: any) {
  return async function r(req: Request, url: URL, pathname: string, method: string) {
    ${route}
    return null;
  };
}`;
      const of = (route: string) => findInnerShadows(file(route), "a.ts", "aRouter").map((o) => [o.sample, o.methods, o.prior.line, o.later.line]);
      expect(of("")).toEqual([]);
      expect(of(`${MATCH}\n    ${'if (m && method === "GET") return json({});'}\n    ${LITERAL}`)).toEqual([["/api/x/keep", ["GET"], 10, 11]]);
      // Untyped, the answers `true` and `false` still make it one.
      for (const answer of ["return true;", "return false;", "{ return false; }"])
        expect(findInnerShadows(`export function guest(pathname, method) {\n  if (method === "GET" && pathname.startsWith("/api/public/")) ${answer}\n  if (method === "GET" && pathname === "/api/public/health") ${answer}\n  return null;\n}`, "a.ts", "aRouter")).toEqual([]);
      // A deny list answering false, in blocks, is a predicate too.
      expect(findInnerShadows(`export function guestDenied(pathname: string, method: string): boolean {
  if (method === "DELETE" && pathname.startsWith("/api/public/")) { return false; }
  if (method === "DELETE" && pathname === "/api/public/health") { return false; }
  return true;
}`, "a.ts", "aRouter")).toEqual([]);
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

    // The stale filter, on its own, read from the environment the script runs
    // in: with no ROUTE_SHADOWING_ROOT (the real tree) every unused entry is
    // stale; on a bench tree only the entries about routers it has.
    test("staleKnown judges every entry on the real tree, and only this tree's routers on another", () => {
      const k = (prior: string, later: string): KnownOverlap => ({ prior, later, sample: "/api/x", why: "t" });
      const both = k("a", "b");
      const gone = k("a", "gone");
      const bench = { ROUTE_SHADOWING_ROOT: "/tmp/bench" };
      expect(staleKnown([both], new Set(), ["a", "b"], bench)).toEqual([both]);
      expect(staleKnown([both], new Set([both]), ["a", "b"], bench)).toEqual([]);
      expect(staleKnown([gone], new Set(), ["a"], bench)).toEqual([]);
      expect(staleKnown([k("gone", "a")], new Set(), ["a"], bench)).toEqual([]);
      expect(staleKnown([gone, both], new Set([both]), ["a", "b"], bench)).toEqual([]);
      expect(staleKnown([gone, both], new Set([both]), ["a", "b"], {})).toEqual([gone]);
      expect(staleKnown([gone, both], new Set([both]), ["a", "b"], { ROUTE_SHADOWING_ROOT: "" })).toEqual([gone]);
    });

    // The same decision in the script: run from a tree of its own with no
    // ROUTE_SHADOWING_ROOT, that tree is the real one, and KNOWN's browser
    // entry is stale there because the tree has no browser router.
    test("run on its own tree with no ROUTE_SHADOWING_ROOT, the script judges every KNOWN entry", () => {
      const root = tree('    if (method === "POST" && pathname === "/api/x") return new Response("b");');
      mkdirSync(join(root, "scripts"));
      copyFileSync(SCRIPT, join(root, "scripts", "check-route-shadowing.ts"));
      symlinkSync(resolve(import.meta.dir, "..", "client"), join(root, "client"));
      const env = { ...process.env };
      delete env.ROUTE_SHADOWING_ROOT;
      const r = spawnSync("bun", ["run", join(root, "scripts", "check-route-shadowing.ts")], { encoding: "utf8", env });
      expect(r.stdout).toContain("STALE known overlap");
      expect(r.status).toBe(1);
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

      test("a second method hidden on the same path is a new finding, not the known one", () => {
        const r = run(browserTree([
          '    const m = matchRoute(pathname, "/api/browsers/:id");',
          '    if (m && (method === "GET" || method === "DELETE")) return new Response("pattern");',
          '    if (method === "GET" && pathname === "/api/browsers/data-store-keep-list") return new Response("literal");',
          '    if (method === "DELETE" && pathname === "/api/browsers/data-store-keep-list") return new Response("literal");',
        ].join("\n")));
        expect(r.stdout).toContain("2 overlaps (1 known)");
        expect(r.stdout).toContain("OVERLAP DELETE /api/browsers/data-store-keep-list");
        expect(r.status).toBe(1);
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
