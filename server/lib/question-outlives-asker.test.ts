/**
 * The pure half of answering a question whose asker is gone: which call is the question, whether anybody
 * is still blocked on it, the words the model reads, and the answer a restart
 * left on the row.
 *
 * @covers ASK-11
 */
import { describe, expect, test } from "bun:test";
import {
  answerRecordedOnRow, askerStillThere, answerAsNextMessage, openQuestionsOnRows, questionTexts, storedToolCall,
  routeAnswer, liveQuestionCallId,
} from "./question-outlives-asker";

const identity = (v: unknown) => (typeof v === "string" ? v : null);
const Q = { question: "Which branch?", header: "Branch", options: [{ label: "main" }, { label: "next" }] };
const ask = (over: Record<string, unknown> = {}) => ({
  id: "toolu_1", name: "mcp__topics__ask_user_question", status: "waiting_for_input",
  args: { questions: [Q] }, userInputSchema: { kind: "questions", questions: [Q] }, ...over,
});
const rowWith = (id: string, calls: unknown[]) => ({
  id, tool_calls: null, blocks: JSON.stringify(calls.map((toolCall) => ({ kind: "tool", toolCall }))),
});

describe("answerAsNextMessage", () => {
  test("quotes each question with its answer under it, and says why it is a message", () => {
    const text = answerAsNextMessage(["Which branch?", "Ship now?"], { "Which branch?": "main", "Ship now?": "yes" });
    expect(text.split("\n")[0]).toMatch(/earlier/);
    expect(text).toContain("> Which branch?\nmain");
    expect(text).toContain("> Ship now?\nyes");
    expect(text.indexOf("Which branch?")).toBeLessThan(text.indexOf("Ship now?"));
  });

  test("an answer to a question the schema did not carry is still delivered", () => {
    expect(answerAsNextMessage([], { "free text": "do it" })).toContain("> free text\ndo it");
  });

  test("a multi-line question stays quoted on every line", () => {
    expect(answerAsNextMessage(["a\nb"], { "a\nb": "x" })).toContain("> a\n> b\nx");
  });
});

describe("askerStillThere", () => {
  test("an open ask is the asker; a call marked gone is nobody", () => {
    expect(askerStillThere({ pendingAsk: true, call: null })).toBe(true);
    expect(askerStillThere({ pendingAsk: true, call: { askerGone: true } })).toBe(true);
    expect(askerStillThere({ pendingAsk: false, call: { askerGone: true } })).toBe(false);
  });

  test("with no mark the asker may still come back: a child that survived a restart polls again", () => {
    expect(askerStillThere({ pendingAsk: false, call: {} })).toBe(true);
    expect(askerStillThere({ pendingAsk: false, call: null })).toBe(true);
  });
});

describe("reading the question off the rows", () => {
  test("storedToolCall finds the call in the timeline or in the column", () => {
    expect(storedToolCall([rowWith("r1", [ask()])], "toolu_1", identity)?.status).toBe("waiting_for_input");
    const column = { id: "r2", tool_calls: JSON.stringify([ask({ id: "toolu_2" })]), blocks: null };
    expect(storedToolCall([column], "toolu_2", identity)?.id).toBe("toolu_2");
    expect(storedToolCall([column], "missing", identity)).toBeNull();
  });

  test("questionTexts prefers the painted schema, then the tool's arguments", () => {
    expect(questionTexts(ask())).toEqual(["Which branch?"]);
    expect(questionTexts(ask({ userInputSchema: undefined }))).toEqual(["Which branch?"]);
    expect(questionTexts(null)).toEqual([]);
  });

  test("openQuestionsOnRows lists only questions still waiting, once each", () => {
    const rows = [
      rowWith("r1", [ask({ id: "open" }), ask({ id: "done", status: "success" }), { id: "bash", name: "Bash", status: "waiting_for_input" }]),
      rowWith("r0", [ask({ id: "open" })]),
    ];
    expect(openQuestionsOnRows(rows, identity).map((o) => [o.rowId, o.call.id])).toEqual([["r1", "open"]]);
  });
});

describe("answerRecordedOnRow: the answer a restart left behind", () => {
  const answered = ask({ status: "running", userResponse: { kind: "questions", answers: { "Which branch?": "next" } } });

  test("the newest question, answered and not yet returned, gives its answer to the same question", () => {
    expect(answerRecordedOnRow([rowWith("r1", [answered])], [Q], identity)).toEqual({ "Which branch?": "next" });
  });

  test("never feeds a different question, a waiting one, or an older one", () => {
    expect(answerRecordedOnRow([rowWith("r1", [answered])], [{ question: "Another?" }], identity)).toBeNull();
    expect(answerRecordedOnRow([rowWith("r1", [ask()])], [Q], identity)).toBeNull();
    // A newer question sits above the answered one: only the newest counts.
    const rows = [rowWith("r2", [ask({ id: "toolu_new" })]), rowWith("r1", [answered])];
    expect(answerRecordedOnRow(rows, [Q], identity)).toBeNull();
  });
});

describe("routeAnswer: the click goes to its own question and nowhere else", () => {
  const texts = ["Which branch?"];

  test("with no live ask: an open question with nobody goes as a message, an unmarked one to its asker, a closed one nowhere", () => {
    expect(routeAnswer({ toolCallId: "toolu_1", clicked: ask({ askerGone: true }), open: undefined })).toBe("message");
    expect(routeAnswer({ toolCallId: "toolu_1", clicked: ask(), open: undefined })).toBe("asker");
    expect(routeAnswer({ toolCallId: "toolu_1", clicked: ask({ status: "success" }), open: undefined })).toBe("not-current");
    expect(routeAnswer({ toolCallId: "toolu_1", clicked: ask({ status: "success", askerGone: true }), open: undefined })).toBe("not-current");
  });

  test("a live leg of ANOTHER question never takes it: an orphaned panel goes as a message, a live one waits its turn", () => {
    const other = { questions: ["Which database?"] };
    expect(routeAnswer({ toolCallId: "toolu_1", clicked: ask({ askerGone: true }), open: other, legCallId: "toolu_2" })).toBe("message");
    expect(routeAnswer({ toolCallId: "toolu_1", clicked: ask({ askerGone: true }), open: other })).toBe("message");
    expect(routeAnswer({ toolCallId: "toolu_1", clicked: ask(), open: other })).toBe("not-current");
    // A wait that named its panel (the outbound gate): only that panel.
    expect(routeAnswer({ toolCallId: "toolu_1", clicked: ask(), open: { toolCallId: "send_1" } })).toBe("not-current");
    expect(routeAnswer({ toolCallId: "send_1", clicked: null, open: { toolCallId: "send_1" } })).toBe("asker");
  });

  test("the same question asked again: the leg is the NEW panel's, the old one goes as a message", () => {
    const open = { questions: texts };
    expect(routeAnswer({ toolCallId: "toolu_old", clicked: ask({ id: "toolu_old", askerGone: true }), open, legCallId: "toolu_new" })).toBe("message");
    expect(routeAnswer({ toolCallId: "toolu_new", clicked: ask({ id: "toolu_new" }), open, legCallId: "toolu_new" })).toBe("asker");
    // Not painted yet: the texts decide, and an orphaned panel is not the leg's.
    expect(routeAnswer({ toolCallId: "toolu_old", clicked: ask({ id: "toolu_old", askerGone: true }), open })).toBe("message");
    expect(routeAnswer({ toolCallId: "toolu_1", clicked: ask(), open })).toBe("asker");
  });

  test("a marked panel whose own leg is polling is still answered by that leg", () => {
    expect(routeAnswer({ toolCallId: "toolu_1", clicked: ask({ askerGone: true }), open: { questions: texts }, legCallId: "toolu_1" })).toBe("asker");
  });

  test("liveQuestionCallId: the newest waiting question with the leg's texts", () => {
    const rows = [
      rowWith("r2", [ask({ id: "toolu_new" }), ask({ id: "toolu_other", args: { questions: [{ question: "Other?" }] }, userInputSchema: undefined })]),
      rowWith("r1", [ask({ id: "toolu_old", askerGone: true })]),
    ];
    expect(liveQuestionCallId(rows, texts, identity)).toBe("toolu_new");
    expect(liveQuestionCallId(rows, ["Other?"], identity)).toBe("toolu_other");
    expect(liveQuestionCallId(rows, ["Nobody asked this?"], identity)).toBeNull();
    expect(liveQuestionCallId(rows, undefined, identity)).toBeNull();
  });
});
