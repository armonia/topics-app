/**
 * @covers GATE-17
 */
import { describe, expect, test, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractClaims, findOverlaps, sampleOf, type Claim } from "./check-route-shadowing";

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
  });
});
