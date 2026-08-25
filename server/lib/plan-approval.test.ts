/**
 * Il turno che propone un piano e non può consegnarlo.
 *
 * La forma dei blocchi qui sotto è quella vera: un `Write` in
 * `~/.claude/plans/<slug>.md` viene normalizzato a `detail.type = 'plan'`
 * (vedi `shared/plan-file.ts`), perché da quando la CLI non espone più
 * `ExitPlanMode` quello è l'unico canale rimasto al modello.
 *
 * @covers PERM-03
 */

import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "../types";
import {
  findPlanAwaitingApproval,
  planApprovalSchema,
  shouldAskPlanApproval,
  PLAN_APPROVE_LABEL,
  PLAN_REJECT_LABEL,
  isPlanApprovalAnswer,
  planDecisionFrom,
} from "./plan-approval";

const tool = (id: string, detail: unknown): ContentBlock =>
  ({ kind: "tool", toolCall: { id, name: "Write", args: {}, status: "success", detail } }) as ContentBlock;
const text = (t: string): ContentBlock => ({ kind: "text", text: t }) as ContentBlock;

describe("findPlanAwaitingApproval", () => {
  test("trova il piano in mezzo alle altre azioni", () => {
    const out = findPlanAwaitingApproval([
      tool("t1", { type: "shell", command: "ls" }),
      tool("t2", { type: "plan", text: "# Piano\n1. Fai questo" }),
      text("Ecco il piano."),
    ]);
    expect(out).toEqual({ toolCallId: "t2", text: "# Piano\n1. Fai questo" });
  });

  test("con due piani vince l'ULTIMO: il modello riscrive il file dopo aver letto altro", () => {
    const out = findPlanAwaitingApproval([
      tool("t1", { type: "plan", text: "primo tentativo" }),
      tool("t2", { type: "read", filePath: "/a.ts" }),
      tool("t3", { type: "plan", text: "piano rivisto" }),
    ]);
    expect(out?.toolCallId).toBe("t3");
  });

  test("nessun piano: il caso normale di ogni altro turno", () => {
    expect(findPlanAwaitingApproval([tool("t1", { type: "shell", command: "ls" })])).toBeNull();
    expect(findPlanAwaitingApproval([])).toBeNull();
  });

  test("un piano VUOTO non è una domanda", () => {
    expect(findPlanAwaitingApproval([tool("t1", { type: "plan", text: "   " })])).toBeNull();
    expect(findPlanAwaitingApproval([tool("t1", { type: "plan" })])).toBeNull();
  });
});

describe("shouldAskPlanApproval", () => {
  const plan = { toolCallId: "t", text: "x" };

  test("sì: turno concluso, plan mode, un piano c'è", () => {
    expect(shouldAskPlanApproval({ reason: "done", permissionMode: "plan", plan })).toBe(true);
  });

  test("no fuori da plan mode: lì un piano scritto è una nota di lavoro", () => {
    expect(shouldAskPlanApproval({ reason: "done", permissionMode: "acceptEdits", plan })).toBe(false);
    expect(shouldAskPlanApproval({ reason: "done", permissionMode: "bypassPermissions", plan })).toBe(false);
  });

  test("no su un turno interrotto o in errore: non ha proposto, ha smesso", () => {
    expect(shouldAskPlanApproval({ reason: "aborted", permissionMode: "plan", plan })).toBe(false);
    expect(shouldAskPlanApproval({ reason: "error", permissionMode: "plan", plan })).toBe(false);
  });

  test("no senza piano", () => {
    expect(shouldAskPlanApproval({ reason: "done", permissionMode: "plan", plan: null })).toBe(false);
  });
});

describe("planApprovalSchema", () => {
  test("è una domanda normale: il pannello che c'è già la sa rendere", () => {
    const s = planApprovalSchema();
    expect(s.kind).toBe("questions");
    if (s.kind !== "questions") throw new Error("kind");
    expect(s.questions).toHaveLength(1);
    expect(s.questions[0].options.map((o) => o.label)).toEqual([PLAN_APPROVE_LABEL, PLAN_REJECT_LABEL]);
  });

  test("approvare è consigliato, ma non preselezionato", () => {
    const s = planApprovalSchema();
    if (s.kind !== "questions") throw new Error("kind");
    const rec = s.questions[0].options.filter((o) => o.recommended);
    expect(rec).toHaveLength(1);
    expect(rec[0].label).toBe(PLAN_APPROVE_LABEL);
  });

  test("l'opzione dice che l'autonomia cambia: non deve succedere di nascosto", () => {
    const s = planApprovalSchema();
    if (s.kind !== "questions") throw new Error("kind");
    expect(s.questions[0].options[0].description).toContain("auto-apply");
  });
});

describe("riconoscere la decisione nella risposta", () => {
  const yes = { kind: "questions", answers: { "Approvo questo piano?": PLAN_APPROVE_LABEL } };
  const no = { kind: "questions", answers: { "Approvo questo piano?": PLAN_REJECT_LABEL } };
  const altro = { kind: "questions", answers: { "In che lingua scrivo i post?": "Italiano" } };

  test("sì e no si distinguono", () => {
    expect(isPlanApprovalAnswer(yes)).toBe(true);
    expect(planDecisionFrom(yes)).toBe(true);
    expect(planDecisionFrom(no)).toBe(false);
  });

  test("un'altra domanda non è una decisione sul piano", () => {
    expect(isPlanApprovalAnswer(altro)).toBe(false);
    expect(planDecisionFrom(altro)).toBeNull();
  });

  test("una risposta di testo libero non è una decisione", () => {
    expect(isPlanApprovalAnswer({ kind: "raw" })).toBe(false);
  });
});
