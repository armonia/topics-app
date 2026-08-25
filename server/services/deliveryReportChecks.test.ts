/**
 * The bench is the real reports, not an invented example — and it is smaller
 * than the audit's headline number, on purpose.
 *
 * WHO IS IN IT. Of the 14 cards reopened by the audit, SEVEN have a thread that
 * claims a delivery: a sha, or a migration number. Those seven are the bench,
 * and all seven are rejected. The other seven are outside it, and not because
 * they were absolved:
 *
 *   - two are audit cards written during the audit itself, whose comments are
 *     ANALYSIS, not delivery;
 *   - one was closed as a duplicate, a human decision on a card whose request
 *     then fell between two cards - no report was ever made;
 *   - the rest were closed on an intention (an approved plan, a probe that was
 *     armed but never read) with nothing citable in the thread.
 *
 * That distinction cost a rewrite. A first version widened the bench to any
 * comment naming a file path, reached 13 cards, and reported "13 of 13
 * rejected" - which looked stronger and was worth less: two of those were being
 * rejected for reasons that had nothing to do with them. A bench inflated to
 * cover the whole headline number is the same error the audit was about.
 *
 * WHAT THIS MEANS FOR THE FOUR CHECKS. They catch the cards that LIED about
 * evidence. They do not catch a card closed on an intention, because there is
 * nothing there to look up. That half of the signature needs a different
 * instrument, and pretending otherwise here would be the third form of the
 * defect: a verification that confirms something it never examined.
 *
 * The card that asked for these checks (`56a631c3`) named its own bar: run the
 * gate on the HISTORICAL delivery reports of the cards that were closed with no
 * work behind them, and it has to reject every one. "If it rejects fewer, the
 * gate is not ready." So the fixture in `tests/fixtures/delivery-reports-reopened.json` is a verbatim dump
 * out of `task_comments` - the sentences the agents actually wrote - and not a
 * paraphrase written to make the checks look good.
 *
 * THE OTHER HALF, and it is the half that decides whether this is worth
 * shipping: a gate that rejects everything is not a gate. So the same checks
 * run against reports that describe REAL work from this repository, with a
 * probe wired to the real git history, and those have to pass. Rejecting the
 * dishonest 14 is easy; doing it without also rejecting honest delivery is the
 * whole difficulty, and it is what the second describe block is for.
 *
 * @covers KANBAN-11
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { extractClaims, checkReport, type RepoProbe } from "./deliveryReportChecks";
import { repoProbe } from "./deliveryReportProbe";

const ROOT = join(import.meta.dir, "..", "..");

/** Every tracked file, once: a citation is resolved by suffix. */
const tracked: string[] = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 })
  .split("\n")
  .filter(Boolean);

/**
 * MEMOIZED, and not as a micro-optimisation.
 *
 * `git log --all -S<symbol>` walks every ref of a repository with thousands of
 * commits; the bench asks it once per declared symbol, and the same symbols
 * recur across the reports of one card. Without the cache this file took 31
 * seconds - long enough that someone eventually moves it out of the unit suite,
 * and a bench that does not run is not a bench.
 */
const cache = new Map<string, boolean>();
const memo = (k: string, f: () => boolean) => {
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const v = f();
  cache.set(k, v);
  return v;
};

/** The real repository, which is what makes the bench a measurement. */
const realProbe: RepoProbe = {
  shaExists: (sha) => memo(`sha:${sha}`, () => {
    try {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: ROOT, stdio: "ignore" });
      return true;
    } catch { return false; }
  }),
  migrations: () => readdirSync(join(ROOT, "server/db/migrations")),
  readMigration: (n) => readFileSync(join(ROOT, "server/db/migrations", n), "utf8"),
  fileMatches: (cit) => {
    const c = cit.replace(/^\.?\//, "");
    return tracked.some((f) => f === c || f.endsWith("/" + c));
  },
  readLine(p, r) {
    try { return readFileSync(join(ROOT, p), "utf8").split("\n")[r - 1] ?? null; } catch { return null; }
  },
  symbolInHistory: (n) => memo(`sym:${n}`, () => {
    try {
      const out = execFileSync("git", ["log", "--all", "-S", n, "--format=%h", "-1"], {
        cwd: ROOT, encoding: "utf8",
      });
      return out.trim().length > 0;
    } catch { return false; }
  }),
};

type Fixture = Record<string, { title: string; reports: string[] }>;
const BENCH: Fixture = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/delivery-reports-reopened.json"), "utf8"),
);

describe("il banco: le cards riaperte, sui loro reports veri", () => {
  test("il banco esiste, non e' vuoto, ed e' quello che dice di essere", () => {
    // Without this the whole file is vacuous: an empty fixture makes every
    // loop below pass while checking nothing.
    const cards = Object.keys(BENCH);
    expect(cards.length).toBeGreaterThanOrEqual(7);
    expect(Object.values(BENCH).every((c) => c.reports.length > 0)).toBe(true);
    // And every report must claim a DELIVERY: a sha or a migration number. A
    // first pass widened the bench to anyone naming a file path, and ANALYSIS
    // comments - which deliver nothing - fell in: two cards then counted as
    // "rejected" for a reason that had nothing to do with them.
    const CLAIM = /\b(?:commit|sha)s?\s+`?[0-9a-f]{7,40}|\bmigrat\w+\b[^.\n]{0,40}?\d{3}/i;
    const without = Object.entries(BENCH).filter(([, c]) => !c.reports.some((r) => CLAIM.test(r))).map(([k]) => k);
    expect(without, "queste carte non rivendicano nessuna consegna: non appartengono a questo banco").toEqual([]);
  });

  for (const [id, card] of Object.entries(BENCH)) {
    test(`[${id}] ${card.title.slice(0, 48)} — bocciata`, () => {
      const findings = card.reports.flatMap((r) => checkReport(r, realProbe));
      expect(
        findings.length,
        `nessuno dei ${card.reports.length} reports di questa card e' stato bocciato: ` +
          `il cancello l'avrebbe lasciata passare`,
      ).toBeGreaterThan(0);
    });
  }

  test("l'accusa e' specifica, non un rifiuto generico", () => {
    // A gate that always answers "nothing to verify" would pass the count test
    // above while saying nothing useful. At least one card has to be caught by
    // a check that actually looked something up.
    const codes = new Set(
      Object.values(BENCH).flatMap((c) => c.reports.flatMap((r) => checkReport(r, realProbe).map((x) => x.code))),
    );
    expect([...codes]).toContain("sha-missing");
    expect(
      codes.size,
      "un solo kind di rilievo su tutto il banco vuol dire che tre controlli su quattro non mordono",
    ).toBeGreaterThan(1);
  });
});

describe("e non boccia il lavoro vero", () => {
  // The expensive half. These describe work that IS in this repository, in the
  // same voice as the fixture, and must come through clean.
  test("un report con un commit vero e un simbolo committato passa", () => {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    // `bridgeFailureDetail` lives in `server/routes/terminal.ts` and IS
    // committed: that is what makes this invented report an honest one.
    const r = `Fatto (commit ${sha}). Il predicato sta in \`server/routes/terminal.ts\`, e \`bridgeFailureDetail\` e' la funzione che decide. Typecheck 0.`;
    expect(checkReport(r, realProbe)).toEqual([]);
  });

  test("un simbolo scritto ma NON ANCORA committato viene rilevato, ed e' right cosi'", () => {
    // Not a false positive. At review time the work has to be committed, and
    // `git log --all -S` looks at every ref, so an agent's branch is inside
    // that. A symbol that appears nowhere means it lives only in the worktree,
    // which is exactly the defect `review_needs_commit` exists to stop, seen
    // from another side. This test found it on its own: the first run cited a
    // symbol from this very file, not yet committed, and the check rejected
    // it.
    const invented = "simboloCheNonHoMaiScritto" + "Qui";
    const r = `Fatto (commit ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()}). Vedi \`${invented}\`.`;
    expect(checkReport(r, realProbe).map((x) => x.code)).toContain("symbol-never-written");
  });

  test("una migration vera, citata insieme a cio' che contiene, passa", () => {
    // 054-app-settings.sql is one of the two slots three reports claimed. Cited
    // HONESTLY - next to something it really contains - it must not trip.
    const body = realProbe.readMigration("054-app-settings.sql");
    const word = body.match(/\b(app_settings|[a-z_]{6,})\b/)?.[1] ?? "app_settings";
    const r = `Fatto: migration 054 aggiunge \`${word}\`.`;
    const findings = checkReport(r, realProbe).filter((x) => x.code.startsWith("migrazione"));
    expect(findings, `una citazione onesta di 054 e' stata accusata: ${JSON.stringify(findings)}`).toEqual([]);
  });

  test("un file citato con la line giusta passa, con quella sbagliata no", () => {
    const p = "server/services/deliveryReportChecks.ts";
    const lines = readFileSync(join(ROOT, p), "utf8").split("\n");
    const n = lines.findIndex((l) => l.includes("export function checkReport")) + 1;
    expect(n, "la funzione non c'e' piu': il test si sta misurando addosso").toBeGreaterThan(0);

    const right = checkReport(`Vedi \`${p}:${n}\`, \`checkReport\`.`, realProbe);
    expect(right.filter((x) => x.code === "line-lacks-symbol")).toEqual([]);

    const wrong = checkReport(`Vedi \`${p}:1\`, \`checkReport\`.`, realProbe);
    expect(
      wrong.some((x) => x.code === "line-lacks-symbol"),
      "una line sbagliata deve essere rilevata, o il controllo 3 non serve",
    ).toBe(true);
  });
});

describe("cosa il cancello dice di se stesso", () => {
  test("un report without NIENTE da verificare non e' un report promosso", () => {
    // "Fatto, tutto verde" is the shape that would slip through a gate that // allow-italian: the quoted report text is the data under test
    // only checks what it finds. Silence and success must not look alike.
    const r = checkReport("Fatto. Tutto verde, nessun problema.", realProbe);
    expect(r.map((x) => x.code)).toContain("nothing-to-check");
  });

  test("l'estrazione riconosce le forme che i reports usano davvero", () => {
    const c = extractClaims(
      "Fix applicati (commit cffc7a1). Migration rinumerata 054→055. Vedi `stall-judge.ts` e `dispatchIdleMin`.",
    );
    expect(c).toContainEqual({ kind: "sha", value: "cffc7a1" });
    expect(c).toContainEqual({ kind: "migrazione", number: "054" });
    expect(c, "il number DI ARRIVO e' la rivendicazione vera").toContainEqual({ kind: "migrazione", number: "055" });
    expect(c).toContainEqual({ kind: "file", path: "stall-judge.ts" });
    expect(c).toContainEqual({ kind: "simbolo", name: "dispatchIdleMin" });
  });

  test("una catena di sha e' due rivendicazioni, non una stringa", () => {
    const c = extractClaims("VERIFICA INDIPENDENTE OK — commit 60a4f445+cffc7a13, worktree pulito");
    expect(c.filter((x) => x.kind === "sha")).toHaveLength(2);
  });

  test("uno sha NUDO si riconosce: la gente non scrive sempre «commit» davanti", () => {
    // "il fix di fee32d7e (matchMedia)" is a delivery claim, and that sha does
    // not exist. Demanding the word "commit" first is a rule about prose style,
    // not about evidence, and it cost a real catch.
    const c = extractClaims("Verificato: il fix di fee32d7e (matchMedia) e' gia' nel worktree.");
    expect(c).toContainEqual({ kind: "sha", value: "fee32d7e" });
  });

  test("e non trasforma in sha tutto cio' che sembra esadecimale", () => {
    // The other side of it: widening the extraction is the fastest way to make
    // the gate accuse honest work. The shape has to earn it.
    const shas = (t: string) => extractClaims(t).filter((x) => x.kind === "sha");
    expect(shas("il colore #deadbe1 del tema"), "un colore non e' un commit").toEqual([]);
    expect(shas("la parola defaced e decade non sono commit"), "without cifre non e' uno sha").toEqual([]);
    expect(shas("il numero 12345678 di riferimento"), "without lettere non e' uno sha").toEqual([]);
    expect(shas("versione 1.2.3 e porta 13334"), "numeri corti non lo sono").toEqual([]);
  });

  test("`git` fra apici non e' un simbolo che qualcuno rivendica", () => {
    // Without the exclusion list every report "declares" git and bun, and the
    // fourth check turns into noise on honest work.
    const c = extractClaims("Ho lanciato `git` e `bun` e ho scritto `mioSimbolo`.");
    expect(c.filter((x) => x.kind === "simbolo").map((x) => (x as { name: string }).name)).toEqual(["mioSimbolo"]);
  });
});

/**
 * The REAL probe, and the distinction that nearly made all of this useless.
 *
 * `deliveryReportProbe.ts` is the impure half: it shells out to git. Its first
 * version caught every exception and returned `true` - fail open, so a machine
 * without git would not accuse anyone. But `git cat-file -e <sha>` exiting
 * non-zero IS the answer "that commit does not exist", and it arrives as an
 * exception too. The most important check in the module was therefore dead in
 * production: every invented sha came back as existing.
 *
 * The bench never saw it, and could not: the bench injects its own probe. It
 * took wiring the thing into the service, and a test asserting a note appears,
 * for the defect to surface at all. That is the argument for these four
 * assertions living here rather than only in the pure bench.
 */
describe("la sonda vera distingue «no» da «non lo so»", () => {
  test("uno sha inventato non esiste, e lo dice", () => {
    expect(repoProbe.shaExists("0000000deadbee1")).toBe(false);
  });

  test("uno sha vero esiste", () => {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    expect(repoProbe.shaExists(head)).toBe(true);
  });

  test("un simbolo mai scritto non compare nella storia", () => {
    expect(repoProbe.symbolInHistory("simboloCheNessunoHaMaiScrittoQui" + "12345")).toBe(false);
  });

  test("un percorso citato per nome corto si risolve", () => {
    // The false positive that accused 20 existing paths: reports cite files
    // the way people talk about them, not from the repository root.
    expect(repoProbe.fileMatches("tasks.ts")).toBe(true);
    expect(repoProbe.fileMatches("questo/file/non/esiste.ts")).toBe(false);
  });
});
