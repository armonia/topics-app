/**
 * @covers KANBAN-59
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `docs/board-protocol.md` si presenta come LA COPIA CANONICA del protocollo e
 * afferma che l'envelope di `buildKickoff` «porta gia' queste regole». Il 16/08
 * ne portava meta': delle otto regole, la 2 (ultimo miglio) e la 5 (mai toccare
 * l'ambiente dell'umano senza ok) non c'erano proprio, e chi manteneva il
 * dispatcher leggeva quel documento come specifica e trovava un'altra cosa.
 *
 * Un documento che dice il falso SU SE STESSO costa piu' di un documento
 * assente, perche' lo si crede.
 *
 * Questo non e' un diff testuale — le due copie sono in lingue diverse apposta
 * (l'envelope in inglese perche' e' un contratto di runtime nel codice, il
 * documento in italiano perche' il suo lettore e' una persona) e allinearne le
 * PAROLE sarebbe la cosa sbagliata. Si ancora ogni regola che parla ALL'AGENTE a
 * un segno che deve esistere nell'envelope. Le regole 6 e 8 non sono qui apposta:
 * parlano al server e alla UI, e non hanno niente da fare in un kickoff.
 */
const REPO = join(import.meta.dir, "..", "..");
const dispatcher = readFileSync(join(REPO, "server/services/task-dispatcher.ts"), "utf8");
const doc = readFileSync(join(REPO, "docs/board-protocol.md"), "utf8");
const board = readFileSync(join(REPO, "shared/board.ts"), "utf8");

const REGOLE_CHE_PARLANO_ALL_AGENTE: Array<{ n: number; nel_doc: string; nell_envelope: RegExp }> = [
  { n: 1, nel_doc: "Consegna = lavoro COMMITTATO sul branch", nell_envelope: /status="review"/ },
  { n: 2, nel_doc: "La consegna include l'ULTIMO MIGLIO", nell_envelope: /LAST MILE/i },
  { n: 3, nel_doc: "Ogni claim con EVIDENZA verificabile", nell_envelope: /evidence/i },
  { n: 4, nel_doc: "Anteprima = evidenza DUREVOLE", nell_envelope: /PREVIEW/ },
  { n: 5, nel_doc: "Azioni sull'ambiente dell'umano: mai senza ok esplicito", nell_envelope: /HUMAN'S ENVIRONMENT/i },
  { n: 7, nel_doc: "Lavoro futuro fuori scope → task top-level nel backlog", nell_envelope: /top-level task with NO parent/i },
];

describe("docs/board-protocol.md e l'envelope dicono le stesse regole", () => {
  for (const r of REGOLE_CHE_PARLANO_ALL_AGENTE) {
    test(`regola ${r.n} sta in entrambi`, () => {
      expect(doc).toContain(r.nel_doc);
      expect(dispatcher).toMatch(r.nell_envelope);
    });
  }

  test("il documento non promette piu' di quanto l'envelope porti", () => {
    // Se qualcuno aggiunge una nona regola numerata al documento, questo test
    // rossegga finche' non decide a chi parla: se all'agente entra nella lista
    // qui sopra e nell'envelope, se al server si annota che non ci va.
    const numerate = [...doc.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
    expect(numerate).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("posta e Google: il documento e l'envelope dicono la stessa cosa, e la stringa e' UNA", () => {
    // Rule 5-bis speaks to the agent, so it must be in both. And as with the
    // preview rule, the envelope does not REWRITE it: it imports it from
    // `shared/board.ts`, because two copies of a rule become two rules the
    // moment somebody edits one.
    expect(doc).toContain("Posta e Google sono STRUMENTI");
    expect(board).toContain("MAIL AND GOOGLE ARE TOOLS");
    expect(dispatcher).toContain("${OUTBOUND_TOOLS_RULE}");
  });

  test("both say the e2e of a delivery runs on the pull request CI, never here", () => {
    expect(doc).toContain("`github-ci:e2e`");
    expect(dispatcher).toContain("E2E RUNS ON GITHUB CI, NEVER HERE");
  });

  test("both say the unit suite of a delivery is read from the pull request CI when the board declares it", () => {
    expect(doc).toContain("`github-ci:unit`");
    expect(doc).toContain("UNIT TESTS RUN ON GITHUB CI, NEVER HERE");
    expect(dispatcher).toContain("UNIT TESTS RUN ON GITHUB CI, NEVER HERE");
  });

  test("both say no agent runs e2e on this machine, whatever the board declares", () => {
    expect(doc).toContain("E2E NEVER RUNS ON THIS MACHINE");
    expect(board).toContain("E2E NEVER RUNS ON THIS MACHINE (decided 2026-09-15)");
    expect(dispatcher).toContain("`- ${CODE_GATES_RULE}`");
  });

  test("both say a board without the CI row measures no e2e, and the agent says so", () => {
    expect(doc).toContain("E2E IS NOT MEASURED BY THIS BOARD");
    expect(dispatcher).toContain("E2E IS NOT MEASURED BY THIS BOARD");
  });
});
