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
 *
 * Rule 1-bis speaks to WHOEVER REVIEWS a mute card, and its own gate is
 * `review-card-is-mute` in `scripts/board-doctor.ts`, so it is out too.
 *
 * `N-bis` rules count like the rest, and the enumeration below has counted them
 * since 2026-09-16. Before that it only read bare digits, and a rule added as
 * `5-bis.` (the recommended option, which speaks to the agent) walked under the
 * gate without tripping it: the document promised it, the envelope was free not
 * to carry it, and deleting it from the dispatcher left this file green (checked:
 * 11 pass / 0 fail with zero occurrences of `RECOMMENDED_OPTION_RULE` in
 * `task-dispatcher.ts`). The number is not the point; forcing every new rule to
 * declare who it speaks to is.
 */
const REPO = join(import.meta.dir, "..", "..");
const dispatcher = readFileSync(join(REPO, "server/services/task-dispatcher.ts"), "utf8");
const doc = readFileSync(join(REPO, "docs/board-protocol.md"), "utf8");
const board = readFileSync(join(REPO, "shared/board.ts"), "utf8");
const mcp = readFileSync(join(REPO, "server/mcp/topics-mcp-server.ts"), "utf8");

/** The source of ONE tool definition, from its `name:` to the next one's. */
function mcpTool(nome: string): string {
  const from = mcp.indexOf(`name: "${nome}",`);
  if (from < 0) return "";
  const next = mcp.indexOf('\n    name: "', from + 1);
  return mcp.slice(from, next < 0 ? mcp.length : next);
}

/** The `options:` property line of one tool, where its description lives. */
function mcpOptionsLine(nome: string): string {
  return mcpTool(nome).split("\n").find((l) => /^\s*options: \{/.test(l)) ?? "";
}

/**
 * `in_constant` exists only for the rules the envelope does NOT spell out by
 * hand but interpolates from `shared/board.ts` (here: the recommended option).
 * For those the sign comes in two pieces, the same shape the `CODE_GATES_RULE`
 * test uses below: the dispatcher must INTERPOLATE the constant (removing it is
 * the measured failure), and the constant must SAY what the document promises,
 * or the name would sit there wrapped around a rewritten sentence.
 *
 * `in_mcp` is the OTHER HALF of the same promise, and it was missing until
 * 2026-09-16: rule 5-bis says the constant is read by the kickoff envelope AND
 * by the `options` descriptions of the two comment tools, while the gate only
 * read the dispatcher. Measured mutant: with the interpolation removed from BOTH
 * descriptions in `server/mcp/topics-mcp-server.ts` (and the import with it,
 * `grep -c RECOMMENDED_OPTION_RULE` = 0) the suite stayed at 368 pass / 0 fail.
 * That half is the one that carries the weight: on the live DB 1,446 of the
 * 1,451 comments with a ```question fence are NOT the first comment of their
 * task, so the kickoff is turns behind and the tool description is the copy
 * still in front of the agent when it writes the options.
 */
const REGOLE_CHE_PARLANO_ALL_AGENTE: Array<{ n: string; nel_doc: string; nell_envelope: RegExp; in_constant?: string; in_mcp?: { tools: string[]; nella_descrizione: RegExp } }> = [
  { n: "1", nel_doc: "Consegna = lavoro COMMITTATO sul branch", nell_envelope: /status="review"/ },
  { n: "2", nel_doc: "La consegna include l'ULTIMO MIGLIO", nell_envelope: /LAST MILE/i },
  { n: "3", nel_doc: "Ogni claim con EVIDENZA verificabile", nell_envelope: /evidence/i },
  { n: "4", nel_doc: "Anteprima = evidenza DUREVOLE", nell_envelope: /PREVIEW/ },
  { n: "5", nel_doc: "Azioni sull'ambiente dell'umano: mai senza ok esplicito", nell_envelope: /HUMAN'S ENVIRONMENT/i },
  { n: "5-bis", nel_doc: "Quando chiedi una decisione, la TUA scelta va per prima", nell_envelope: /`  \$\{RECOMMENDED_OPTION_RULE\}`/, in_constant: "first element of `options`", in_mcp: { tools: ["comment_task", "comment_global_task"], nella_descrizione: /\$\{RECOMMENDED_OPTION_RULE\}/ } },
  { n: "7", nel_doc: "Lavoro futuro fuori scope → task top-level nel backlog", nell_envelope: /top-level task with NO parent/i },
];

describe("docs/board-protocol.md e l'envelope dicono le stesse regole", () => {
  for (const r of REGOLE_CHE_PARLANO_ALL_AGENTE) {
    test(`regola ${r.n} sta in entrambi`, () => {
      expect(doc).toContain(r.nel_doc);
      expect(dispatcher).toMatch(r.nell_envelope);
      if (r.in_constant) expect(board).toContain(r.in_constant);
      for (const tool of r.in_mcp?.tools ?? []) {
        expect(mcpOptionsLine(tool)).toMatch(r.in_mcp!.nella_descrizione);
      }
    });
  }

  /**
   * The list of MCP surfaces above is a DECISION, and this is the proof that the
   * document has not quietly grown another one: 5-bis names its surfaces by tool
   * name, and naming a third without gating it is exactly the failure this file
   * exists for — one more copy of the rule free to drift or disappear.
   */
  test("la 5-bis non nomina superfici MCP che il cancello non legge", () => {
    const frase = doc.match(/descrizioni di `options` in ([^.]*)\./);
    expect(frase).not.toBeNull();
    const named = [...frase![1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    const gated = REGOLE_CHE_PARLANO_ALL_AGENTE.find((r) => r.n === "5-bis")!.in_mcp!.tools;
    expect(named).toEqual(gated);
  });

  test("il documento non promette piu' di quanto l'envelope porti", () => {
    // If anyone adds a numbered rule to the document, this test stays red until
    // they decide who it speaks to: to the agent means the list above plus the
    // envelope, to the server means a note saying it does not belong there. It
    // counts `N-bis` too, because one of those has already walked under the gate.
    const numerate = [...doc.matchAll(/^(\d+(?:-bis)?)\. \*\*/gm)].map((m) => m[1]);
    expect(numerate).toEqual(["1", "1-bis", "2", "3", "4", "5", "5-bis", "6", "7", "8"]);
  });

  test("ogni regola del documento che parla all'agente e' ancorata, o e' annotata come non sua", () => {
    // The list above is the DECISION; this is the proof that no rule of the
    // document is left without one. The three exclusions are named one by one in
    // the file header, each with the gate that covers it instead of this one.
    const numerate = [...doc.matchAll(/^(\d+(?:-bis)?)\. \*\*/gm)].map((m) => m[1]);
    const anchored = new Set(REGOLE_CHE_PARLANO_ALL_AGENTE.map((r) => r.n));
    const NOT_FOR_THE_AGENT = ["1-bis", "6", "8"];
    expect(numerate.filter((n) => !anchored.has(n))).toEqual(NOT_FOR_THE_AGENT);
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
