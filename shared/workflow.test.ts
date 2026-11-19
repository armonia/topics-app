/**
 * The board workflow as pure rules: the one set of columns, the column of a
 * card, who waits on a person.
 *
 * @covers KANBAN-102
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_PERSON_PATHS,
  STAGE_CI,
  WORKFLOW_COLUMNS,
  agentAskInThread,
  asksOnlyApproval,
  awaitsHuman,
  awaitsHumanSql,
  columnOfTask,
  isApprovalOnly,
  parseCiPhase,
  parsePersonPaths,
  personPathsFromText,
  personPathsToText,
  resolveWorkflowRules,
} from "./workflow";

describe("the columns", () => {
  test("the five of before, plus the CI phase that only named cards enter", () => {
    const wf = { columns: WORKFLOW_COLUMNS };
    expect(wf.columns.map((c) => c.id)).toEqual(["backlog", "todo", "in_progress", "review", "ci", "done"]);
    expect(wf.columns.filter((c) => c.id !== STAGE_CI).every((c) => c.id === c.base)).toBe(true);
    // A card with no stage never lands in CI: its review stays the review of before.
    expect(columnOfTask(wf.columns, { status: "review" })?.id).toBe("review");
    expect(columnOfTask(wf.columns, { status: "review", stage: STAGE_CI })?.id).toBe(STAGE_CI);
  });

  test("a card in the CI phase waits on nobody", () => {
    expect(awaitsHuman({ status: "review", stage: STAGE_CI })).toBe(false);
    expect(awaitsHuman({ status: "review", stage: null })).toBe(true);
    expect(awaitsHuman({ status: "in_progress" })).toBe(false);
    expect(awaitsHumanSql(true)).toContain(`'${STAGE_CI}'`);
  });
});

describe("columnOfTask", () => {
  test("a card with no stage sits in the default column of its status", () => {
    const cols = WORKFLOW_COLUMNS;
    expect(columnOfTask(cols, { status: "review" })?.id).toBe("review");
    expect(columnOfTask(cols, { status: "backlog" })?.id).toBe("backlog");
    expect(columnOfTask(cols, { status: "todo", stage: null })?.id).toBe("todo");
  });

  test("a stage the status contradicts, or the workflow does not have, is ignored", () => {
    const cols = WORKFLOW_COLUMNS;
    expect(columnOfTask(cols, { status: "todo", stage: STAGE_CI })?.id).toBe("todo");
    // A stage of a removed workflow: the card stays in the column of its status.
    for (const stage of ["ai_review", "human_review", "triage"]) {
      expect(columnOfTask(cols, { status: "review", stage })?.id).toBe("review");
      expect(awaitsHuman({ status: "review", stage })).toBe(true);
    }
  });
});

describe("resolveWorkflowRules: the CI switch inherits, the paths add up", () => {
  test("no rows: the CI measures after the land, no board paths", () => {
    expect(resolveWorkflowRules({})).toEqual({ ciPhase: "after", personPaths: [] });
  });
  test("the project's mode wins over the global one; null inherits", () => {
    expect(resolveWorkflowRules({ global: { ciPhase: "off" } }).ciPhase).toBe("off");
    expect(resolveWorkflowRules({ global: { ciPhase: "off" }, project: { ciPhase: "before" } }).ciPhase).toBe("before");
    expect(resolveWorkflowRules({ global: { ciPhase: "before" }, project: { ciPhase: null } }).ciPhase).toBe("before");
  });
  test("the three modes read as themselves, the old booleans as before and off", () => {
    expect(resolveWorkflowRules({ project: { ciPhase: "before" } }).ciPhase).toBe("before");
    expect(resolveWorkflowRules({ project: { ciPhase: "after" } }).ciPhase).toBe("after");
    expect(resolveWorkflowRules({ project: { ciPhase: "off" } }).ciPhase).toBe("off");
    expect(resolveWorkflowRules({ project: { ciPhase: true } }).ciPhase).toBe("before");
    expect(resolveWorkflowRules({ project: { ciPhase: false } }).ciPhase).toBe("off");
    // A value nobody knows inherits instead of switching the CI off by accident.
    expect(resolveWorkflowRules({ global: { ciPhase: "before" }, project: { ciPhase: "later" as never } }).ciPhase).toBe("before");
    expect(parseCiPhase("later")).toBeNull();
  });
  test("the global paths come first, then the project's", () => {
    const g = { pattern: "a/**", why: "g" }; const p = { pattern: "b/**", why: "p" };
    expect(resolveWorkflowRules({ global: { personPaths: [g] }, project: { personPaths: [p] } }).personPaths).toEqual([g, p]);
  });
});

describe("person paths as text and as data", () => {
  test("one per line, `pattern # why`; blank and comment lines skipped; no why = this board", () => {
    const paths = personPathsFromText("client/src/** # interfaccia\n\n# a note\n  scripts/**  \n");
    expect(paths).toEqual([{ pattern: "client/src/**", why: "interfaccia" }, { pattern: "scripts/**", why: "this board" }]);
    expect(personPathsFromText(personPathsToText(paths))).toEqual(paths);
  });
  test("a list that is not one is refused, not read as empty", () => {
    expect(parsePersonPaths([{ pattern: "a/**", why: "x" }])).toEqual([{ pattern: "a/**", why: "x" }]);
    expect(parsePersonPaths("a/**")).toBeNull();
    expect(parsePersonPaths([{ pattern: "", why: "x" }])).toBeNull();
    expect(parsePersonPaths(Array.from({ length: MAX_PERSON_PATHS + 1 }, () => ({ pattern: "a", why: "b" })))).toBeNull();
  });
});


/**
 * "Do you approve?" is not a question: the texts are the agents' own, copied from
 * the board's database (cards named in the comments).
 */
describe("isApprovalOnly / asksOnlyApproval", () => {
  const q = (question: string, ...options: string[]) => ({ question, options });

  test.each([
    // 9c055516, d4a17f12: a report with no "?" above the land button.
    ["a report then land (9c055516)", q("Il commit 4743f70fc (regex cargo in server/lib/heavy-command.ts: tauri build/run, nextest, bench, install, +toolchain nella coda heavy-slot) è nel ramo, albero pulito, test heavy-slot 5 pass / 0 fail riverificati ora. Non è ancora in main. Memlog e drv.py restano fuori repo.", "Landa su main", "Da rivedere")],
    ["a report then land (d4a17f12)", q("Portato il lavoro (voce «Supporto e community», URL in lib/externalLinks.ts, spec con fix drawer a 375px, USERMENU-11) su main aggiornato. Il rosso e2e su #1192 era sul commit 743c03b3, precedente al fix del drawer; typecheck e untraced-tests verdi. E2E da misurare sulla CI al nuovo commit.", "Landa su main (consigliata)")],
    ["an ok? above the land button", q("Barra verde. Ok?", "Landa su main (consigliata)")],
    ["the land action at green CI", q("Fatto.", "Landa su main a CI verde")],
    ["land or send back (f34ae59e)", q("Test di regressione aggiunto, tutti i cancelli verdi.", "Landa su main (consigliata)", "Da rivedere")],
    ["a bare ok", q("Ok?")],
    ["a bare land-or-change", q("Landa su main (consigliata) o cosa cambiare?")],
    ["ok to land", q("Ok a landare a CI verde?")],
  ])("%s is approval only", (_n, block) => {
    expect(isApprovalOnly(block)).toBe(true);
  });

  test.each([
    // 0d6384ff: an option the board cannot execute is a choice for the person.
    ["a second road", q("Come procedo?", "Landa su main", "Prima lancia l'e2e sul PC con pw-remote e mandami gli screenshot")],
    // 2fbdd455: a pick between two cards.
    ["a pick between cards", q("Landa su main, oppure dammi un parere?", "Landa su main (consigliata)", "Prima decido su c325cd9a")],
    // 0d6384ff, 13/11: a summary with "Ok, o cosa cambiare?" at the end still names what the person must look at.
    ["a summary ending in ok-or-change", q("Cosa vedrà Attilio: Approva su ramo non unito → riga «usa Landa su main». Ok, o cosa cambiare?")],
    ["an option with a condition of its own", q("Fatto.", "Landa su main se la PR #12 è unita")],
    // A product choice above land/send-back buttons is not a courtesy.
    ["a product choice above land buttons", q("La conservazione passa da 30 a 90 giorni: approvi questa scelta?", "Landa su main (consigliata)", "Da rivedere")],
    // 6242e44e, 17/11.
    ["a real question above land (6242e44e)", q("Ramo ripartito da main aggiornato (la PR #1193 era chiusa) con dentro il lavoro già pronto: «Ti chiede», barra Rimanda/Chiudi, riassunto «Per te». Typecheck, emdash e lingua verdi; unit li misura la CI. Foto desktop/telefono già allegate; i testi del riassunto in foto sono scritti a mano: vanno bene?", "Landa su main")],
    ["an interface question above land (0d6384ff)", q("I quattro bottoni ora dicono ciò che fanno?", "Landa su main (consigliata)")],
  ])("%s is a question", (_n, block) => {
    expect(isApprovalOnly(block)).toBe(false);
  });

  test.each([
    // The `human_ask` left on 25f0e2a5, b2b33bf0 and 48588f6e: each a real doubt, whatever its tail.
    "Ho toccato anche .github/workflows/ci.yml (runner a ubuntu-24.04) perché la CI era rotta per tutti: ti va bene dentro questa PR?",
    "Conferma la definizione di «vietato»: slots 0, oppure nodo offline senza hook di accensione (il tetto cloud non è un campo di machines).",
    "Lo script confronta gli errori TS 5 vs TS 7, non le versioni nei package.json come da brief. Va bene così?",
    "Guarda l'anteprima prima/dopo dei bottoni: dicono ora ciò che fanno? Rispondi «ok» o cosa cambiare.",
  ])("a human_ask with a doubt in it asks: %s", (text) => {
    expect(asksOnlyApproval(text)).toBe(false);
  });

  test("a human_ask of approval words only does not ask", () => {
    expect(asksOnlyApproval("Landa su main a CI verde (consigliata)?")).toBe(true);
    expect(asksOnlyApproval("Va bene così? Rispondi «ok» o dimmi cosa cambiare.")).toBe(true);
    expect(asksOnlyApproval("")).toBe(false);
  });

  test("agentAskInThread reads an approval-only fence as a delivery", () => {
    const fence = (body: string) => [{ author: "agent:t1", kind: "comment", content: "```question\n" + body + "\n```" }];
    expect(agentAskInThread(fence("Fatto, barra verde.\n- Landa su main (consigliata)\n- Da rivedere"))).toBeNull();
    expect(agentAskInThread(fence("Come procedo?\n- Landa su main\n- Lancio io l'e2e sul PC"))).toBe("Come procedo?");
  });
});
