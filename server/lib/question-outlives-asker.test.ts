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
  test("an open ask is the asker; a call marked gone is nobody, whatever runs on the session", () => {
    expect(askerStillThere({ pendingAsk: true, call: null, streaming: false, turnAlive: null })).toBe(true);
    expect(askerStillThere({ pendingAsk: false, call: { askerGone: true }, streaming: true, turnAlive: true })).toBe(false);
  });

  test("a live turn is given the benefit of the doubt: its child polls again after a restart", () => {
    expect(askerStillThere({ pendingAsk: false, call: {}, streaming: false, turnAlive: true })).toBe(true);
    expect(askerStillThere({ pendingAsk: false, call: {}, streaming: true, turnAlive: null })).toBe(true);
    expect(askerStillThere({ pendingAsk: false, call: {}, streaming: false, turnAlive: null })).toBe(false);
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
