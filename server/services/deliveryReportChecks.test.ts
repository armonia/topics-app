/**
 * The bench is the 14 cards, not an invented example.
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

const ROOT = join(import.meta.dir, "..", "..");

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
  fileExists: (p) => existsSync(join(ROOT, p)),
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
  test("il banco esiste e non e' vuoto", () => {
    // Without this the whole file is vacuous: an empty fixture makes every
    // loop below pass while checking nothing.
    const cards = Object.keys(BENCH);
    expect(cards.length).toBeGreaterThanOrEqual(8);
    expect(Object.values(BENCH).every((c) => c.reports.length > 0)).toBe(true);
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
  test("un report senza NIENTE da verificare non e' un report promosso", () => {
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

  test("`git` fra apici non e' un simbolo che qualcuno rivendica", () => {
    // Without the exclusion list every report "declares" git and bun, and the
    // fourth check turns into noise on honest work.
    const c = extractClaims("Ho lanciato `git` e `bun` e ho scritto `mioSimbolo`.");
    expect(c.filter((x) => x.kind === "simbolo").map((x) => (x as { name: string }).name)).toEqual(["mioSimbolo"]);
  });
});
