/**
 * `GET /api/slash-commands/:name` — the path-traversal gate, exercised THROUGH
 * the route.
 *
 * Why this file exists, and why the distinction matters. The gate itself is
 * pure and already covered (`server/lib/slash-command-source.test.ts`). What
 * was not covered is the COMPOSITION: that the route actually calls it, before
 * touching the filesystem, on a name that arrives from the client. On
 * 2026-08-25 an audit of the 310 HTTP routes found both slash-command routes
 * named by no test at all. A pure function that rejects `../../../etc/passwd`
 * protects nothing if the handler above it forgot to ask.
 *
 * WHICH SHAPES ACTUALLY REACH THE HANDLER — measured, because the answer is not
 * the obvious one. `new URL()` NORMALISES the path before anything routes, so a
 * literal `/api/slash-commands/../../../etc/passwd` collapses to `/etc/passwd`
 * and never reaches this route at all; `..` alone collapses to `/api/`. The
 * real surface is the ENCODED forms — `..%2F..%2F`, `%2e%2e%2f`, `%2Fetc%2F`,
 * and a NUL byte `a%00b` — which survive normalisation intact and only become
 * `../` again inside the handler's own `decodeURIComponent`. That is precisely
 * the shape that walks past a naive prefix check, and it is what this file
 * asserts against.
 *
 * NON-VACUITY. A gate that answered 400 to everything would pass a
 * traversal-only test while being useless. So the two codes are asserted
 * against each other: a malformed name is 400 (the gate refused it) and a
 * well-formed name that simply does not exist is 404 (the gate let it through
 * and the lookup came back empty). Two different answers prove the rejection
 * is the gate's judgement and not a blanket refusal.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { isValidSlashCommandName, readSlashCommandSource } from "../../server/lib/slash-command-source";

const ROOT = testTmpDir("slash-command-route");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

type Router = ReturnType<typeof import("../../server/routes/topics").createTopicsRouter>;

async function chiama(router: Router, path: string) {
  const url = new URL(`http://h${path}`);
  const res = await router(new Request(url), url, url.pathname, "GET");
  if (!res) throw new Error(`no route handled GET ${path}`);
  return res;
}

async function banco(): Promise<Router> {
  const { createTopicsRouter } = await import("../../server/routes/topics");
  return createTopicsRouter(await createTestAppContext());
}

/** The escapes that SURVIVE normalisation and reach the handler. */
const FUGHE = [
  "..%2F..%2Fetc%2Fpasswd",
  "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "..%2f.ssh%2fid_rsa",
  "%2Fetc%2Fpasswd",
  ".ssh",
  "a%00b",
] as const;

/** The shapes the URL normalises away: they do not even reach the route. */
const NORMALIZZATE = [
  ["../../../etc/passwd", "/etc/passwd"],
  ["..", "/api/"],
] as const;

describe("il cancello del sorgente di un comando slash", () => {
  test("nessun nome che esce dalle cartelle note arriva al filesystem", async () => {
    const router = await banco();
    const passate: string[] = [];
    for (const nome of FUGHE) {
      const res = await chiama(router, `/api/slash-commands/${nome}`);
      // 400 = the gate said no. Anything else (200 with a body, 500 with a
      // stack trace) means the name reached the disk.
      if (res.status !== 400) passate.push(`${nome} -> ${res.status}`);
    }
    expect(passate, "nomi che hanno superato il cancello").toEqual([]);
  });

  test("le fughe non codificate le mangia la normalizzazione, prima del routing", async () => {
    // This is not a defence belonging to this route and it matters not to pass
    // it off as one: it is `new URL()` that rewrites the path. It is here
    // because without this line the test above would look like it covered the
    // literal case too, which in fact never comes through here - and the day the
    // routing changed parser, this difference would start counting again.
    for (const [nome, atteso] of NORMALIZZATE) {
      const u = new URL(`http://h/api/slash-commands/${nome}`);
      expect(u.pathname, `${nome} non e' piu' normalizzato`).toBe(atteso);
      expect(u.pathname.startsWith("/api/slash-commands/")).toBe(false);
    }
  });

  test("un nome ben formato che non esiste e' 404, non 400", async () => {
    // The half that makes the test above non-vacuous: here the gate LETS IT
    // THROUGH, and the answer changes. If it answered 400 to this one too, the
    // green above would say nothing.
    const router = await banco();
    const res = await chiama(router, "/api/slash-commands/comando-che-non-esiste-12345");
    expect(res.status).toBe(404);
  });

  test("l'elenco risponde con una lista, e ogni voce si dichiara comando o skill", async () => {
    const router = await banco();
    const res = await chiama(router, "/api/slash-commands");
    expect(res.status).toBe(200);
    const voci = (await res.json()) as Array<{ name: string; description: string; kind: string }>;
    expect(Array.isArray(voci)).toBe(true);
    for (const v of voci) {
      expect(typeof v.name).toBe("string");
      expect(["command", "skill"]).toContain(v.kind);
    }
  });
});

describe("il resolver, con le sue cartelle sotto controllo", () => {
  test("legge il corpo di un comando che esiste davvero", async () => {
    // The POSITIVE branch, exercised with an explicit `cwd` instead of changing
    // the process's directory: `bun test` runs the files in the same process,
    // and a `chdir` that is not restored would change the world out from under
    // the files that follow. Here the same proof with no side effects.
    const casa = join(ROOT, "casa");
    const lavoro = join(ROOT, "lavoro");
    mkdirSync(join(lavoro, ".claude", "commands"), { recursive: true });
    mkdirSync(join(casa, ".claude", "commands"), { recursive: true });
    writeFileSync(join(lavoro, ".claude", "commands", "recap.md"), "# recap\nDue righe e basta.\n");

    const trovato = readSlashCommandSource("recap", { home: casa, cwd: lavoro });
    expect(trovato, "un comando che esiste non viene letto").toBeTruthy();
    expect(trovato!.kind).toBe("command");
    expect(trovato!.body).toContain("Due righe e basta");
  });

  test("un link che punta fuori dalle cartelle note non si legge", async () => {
    // `contained()` checks AFTER resolving the real path, and this is the case
    // it exists for: the name is allowed, the file is where it is expected to
    // be, but the file IS a link to something else.
    const { symlinkSync } = await import("node:fs");
    const casa = join(ROOT, "casa2");
    const lavoro = join(ROOT, "lavoro2");
    const fuori = join(ROOT, "fuori2");
    mkdirSync(join(lavoro, ".claude", "commands"), { recursive: true });
    mkdirSync(join(casa, ".claude", "commands"), { recursive: true });
    mkdirSync(fuori, { recursive: true });
    const segreto = join(fuori, "segreto.md");
    writeFileSync(segreto, "roba che non deve uscire");
    symlinkSync(segreto, join(lavoro, ".claude", "commands", "esca.md"));

    expect(isValidSlashCommandName("esca"), "il nome e' ammesso: e' il percorso a non esserlo").toBe(true);
    expect(readSlashCommandSource("esca", { home: casa, cwd: lavoro })).toBeNull();
  });
});
