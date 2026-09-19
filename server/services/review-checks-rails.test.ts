/**
 * THE INVENTORY OF THE STATIC RAILS: which gates the board measures, against
 * which ones CI measures.
 *
 * Split out of `review-checks.test.ts` on 2026-09-19, and the reason is the same
 * gate that caught it: adding the CI comparison pushed that file to 876 lines and
 * `check:bloat` said so. Raising its baseline would have bought nothing, because
 * these tests are a different subject anyway. The other file is about EXECUTING a
 * check (timeouts, slots, tails, verdicts); this one never runs a command. It
 * reads three files as TEXT (the chain constant, `.github/workflows/ci.yml`,
 * `package.json`) and answers one question: does the list the board measures
 * still match the list CI measures, and does every name in it exist?
 *
 * @covers KANBAN-15
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { MAX_CHECKS, STATIC_RAILS_CHECK, parseReviewChecks, serializeReviewChecks } from "./review-checks";

/**
 * THE STATIC RAILS FIT IN ONE SLOT, AND EVERY LINK IS A REAL SCRIPT.
 *
 * Measured 2026-09-03 on the live board: six slots, none of them
 * identifier-language, comment-language, untraced-tests or spec-coverage, and
 * main's CI finding the red after the land. The chain is the cure the settings
 * PATCH itself suggests ("unisci due comandi in uno solo"), and this file is
 * where its spelling lives, so the test pins two things: the four missing
 * gates are IN it, and every `bun run X` it names exists in package.json.
 * A chain that names a script nobody has is a slot that goes 1 on `bun run`
 * before measuring anything, indistinguishable from a red.
 *
 * AND SINCE 2026-09-19 IT PINS THE LIST AGAINST CI, which is the only assertion
 * here that could have caught what happened next: the chain was rewritten on the
 * live board to eleven links while the constant stayed at six, and the CI step
 * meanwhile ran eighteen. Nothing compared the two sets, so the gap was found by
 * a person reading both files. The test below reads the `Static guard rails`
 * step of the `check` job in `.github/workflows/ci.yml` and requires every
 * `check:*` in it to be EITHER a link of the chain OR an entry of
 * `NOT_IN_THE_CHAIN` with the reason written next to it. A rail added to CI is
 * then a red here until somebody decides, in writing, which of the two it is.
 */
describe("static-rails: la catena dei cancelli statici", () => {
  const links = STATIC_RAILS_CHECK.cmd.split(" && ");
  const scripts = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")).scripts as Record<string, string>;

  /** The script each link runs, with its arguments dropped. */
  const gates = links.map((l) => /^bun run ([\w:-]+)/.exec(l)?.[1] ?? l);

  /**
   * The rails the CI step runs that the chain does NOT, each with the reason.
   * An entry here is a DECISION; the test only refuses the third state, a rail
   * that is in neither place because nobody looked.
   */
  const NOT_IN_THE_CHAIN: Record<string, string> = {
    // Already a slot of its own on the board: in the chain it would run twice
    // per delivery, and it is the slowest static gate (a full knip pass).
    "check:deadcode": "own slot on the board",
    // Run on both sides with DIFFERENT pieces, deliberately: `data`/`home` read
    // the committer's name and home path (meaningless on a runner), and
    // `dependencies` is the one piece that needs the network.
    "check:security": "both sides, different --only",
  };

  test("porta i sei cancelli con cui la catena e' nata", () => {
    for (const gate of [
      "check:emdash",
      "check:migrations",
      "check:identifier-language",
      "check:comment-language",
      "check:untraced-tests",
      "check:spec-coverage",
    ]) {
      expect(gates).toContain(gate);
    }
  });

  test("porta gli otto che il passo della CI misurava e la board no", () => {
    // The 11-against-18 gap, closed 2026-09-19. Named one by one and not
    // derived from CI: if somebody deletes a rail from the workflow, this must
    // still say what the board decided to measure.
    for (const gate of [
      "check:any",
      "check:any-budget",
      "check:ref-callbacks",
      "check:nul",
      "check:eslint-disable",
      "check:typography",
      "check:tmp-canonical",
      "check:module-mock-restore",
    ]) {
      expect(gates).toContain(gate);
    }
  });

  test("nessun cancello della fila statica della CI resta fuori senza una ragione scritta", () => {
    const ci = readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8").split("\n");
    const start = ci.findIndex((l) => /^ {6}- name: Static guard rails/.test(l));
    expect(start, "lo step `Static guard rails` non c'e' piu' in ci.yml").toBeGreaterThanOrEqual(0);
    let end = ci.length;
    for (let i = start + 1; i < ci.length; i++) {
      if (/^ {6}- name: /.test(ci[i]!)) { end = i; break; }
    }
    const inCi = [...new Set(
      ci.slice(start, end)
        .filter((l) => !/^\s*#/.test(l))
        .flatMap((l) => [...l.matchAll(/bun run (check:[\w:-]+)/g)].map((m) => m[1]!)),
    )];
    // Without this the test would pass on a step whose commands all vanished.
    expect(inCi.length).toBeGreaterThanOrEqual(15);
    const unexplained = inCi.filter((g) => !gates.includes(g) && !(g in NOT_IN_THE_CHAIN));
    expect(unexplained).toEqual([]);
  });

  test("ogni anello e' uno script dichiarato in package.json", () => {
    for (const link of links) {
      // Arguments allowed (`check:security --only=...`), but the script name
      // has to be a real one: a chain naming a script nobody has exits 1 on
      // `bun run` before measuring anything, indistinguishable from a red.
      const m = /^bun run ([\w:-]+)(?: [^&]*)?$/.exec(link);
      expect(m, link).not.toBeNull();
      expect(scripts[m![1]!], link).toBeDefined();
    }
  });

  test("sta nei sei slot insieme agli altri cinque, e sopravvive al round-trip della config", () => {
    const six = [
      { name: "typecheck", cmd: "bun run typecheck" },
      { name: "lint", cmd: "bun run lint" },
      { name: "check:deadcode", cmd: "bun run check:deadcode" },
      STATIC_RAILS_CHECK,
      { name: "test:unit", cmd: "bun run test:unit" },
    ];
    expect(six.length).toBeLessThanOrEqual(MAX_CHECKS);
    expect(parseReviewChecks(serializeReviewChecks(six))).toEqual(six);
  });
});

/**
 * THE PANEL SHOWS THE CAP THAT IS ENFORCED, not a number somebody typed once.
 *
 * `BoardSettingsPanel` drew `{checks.length}/5` as a literal. The cap became
 * SIX on 12/08/2026 and that literal did not move, so the live board - which
 * declares six checks - has been rendering "6/5": a limit shown one BELOW the
 * one the server applies, on the very field whose silent truncation is the
 * reason `MAX_CHECKS` is written down at all. A person reading it would drop a
 * check they were entitled to keep.
 *
 * A text scan and not a render: the defect is a hardcoded number in the JSX, and
 * that is exactly what this reads. Mounting the panel would prove the same thing
 * through a client test runner this file does not have.
 */
describe("il pannello mostra il tetto vero", () => {
  const panel = readFileSync(
    join(import.meta.dir, "../../client/src/components/Board/BoardSettingsPanel.tsx"),
    "utf8",
  );

  test("il contatore dei check viene da MAX_CHECKS, non da una cifra scritta a mano", () => {
    expect(panel).toContain("{checks.length}/{MAX_CHECKS}");
    expect(/\{checks\.length\}\/\d/.test(panel), "una cifra a mano accanto a checks.length").toBe(false);
  });

  test("e lo importa davvero", () => {
    expect(/import \{[^}]*\bMAX_CHECKS\b[^}]*\} from '\.\.\/\.\.\/lib\/board'/.test(panel)).toBe(true);
  });
});
