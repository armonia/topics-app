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

/** Le fughe che SOPRAVVIVONO alla normalizzazione e arrivano al gestore. */
const FUGHE = [
  "..%2F..%2Fetc%2Fpasswd",
  "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "..%2f.ssh%2fid_rsa",
  "%2Fetc%2Fpasswd",
  ".ssh",
  "a%00b",
] as const;

/** Le forme che l'URL normalizza via: non arrivano nemmeno alla rotta. */
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
      // 400 = il cancello ha detto no. Qualunque altra cosa (200 con un corpo,
      // 500 con una traccia) vuol dire che il nome e' arrivato al disco.
      if (res.status !== 400) passate.push(`${nome} -> ${res.status}`);
    }
    expect(passate, "nomi che hanno superato il cancello").toEqual([]);
  });

  test("le fughe non codificate le mangia la normalizzazione, prima del routing", async () => {
    // Non e' una difesa di questa rotta ed e' importante non spacciarla per
    // tale: e' `new URL()` che riscrive il percorso. Sta qui perche' senza
    // questa riga il test sopra sembrerebbe coprire anche il caso letterale,
    // che invece non passa mai di qui — e il giorno in cui il routing
    // cambiasse parser, questa differenza tornerebbe a contare.
    for (const [nome, atteso] of NORMALIZZATE) {
      const u = new URL(`http://h/api/slash-commands/${nome}`);
      expect(u.pathname, `${nome} non e' piu' normalizzato`).toBe(atteso);
      expect(u.pathname.startsWith("/api/slash-commands/")).toBe(false);
    }
  });

  test("un nome ben formato che non esiste e' 404, non 400", async () => {
    // La meta' che rende non vacuo il test sopra: qui il cancello LASCIA
    // PASSARE, e la risposta cambia. Se rispondesse 400 anche a questo, il
    // verde di sopra non direbbe niente.
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
    // Il ramo POSITIVO, provato con `cwd` esplicito invece che cambiando la
    // cartella del processo: `bun test` fa girare i file nello stesso
    // processo, e una `chdir` non ripristinata cambierebbe il mondo sotto ai
    // file successivi. Qui la stessa prova senza effetti collaterali.
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
    // `contained()` controlla DOPO aver risolto il percorso reale, e questo e'
    // il caso per cui esiste: il nome e' ammesso, il file sta dove ci si
    // aspetta, ma il file E' un link a qualcos'altro.
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
