/**
 * @covers ASK-01
 *
 * THE 503 ON A GOOD ANSWER.
 *
 * The human answered the panel, the POST reached the server, and the reply came
 * back `provider topics does not support user input`. Nothing was wrong with
 * the answer: the lookup that decides where to send it read only the LAST row
 * of the session, and after a restart the last row is the interruption notice,
 * not the question. Not finding it, the route tried the provider path, which
 * the native runtime does not have.
 */
import { describe, expect, test } from "bun:test";
import { rowsCarryAsk, type AskHaystackRow } from "./ask-answer-routing";

const decode = (v: unknown) => (typeof v === "string" ? v : null);
const ID = "toolu_01Sd41TjzoJUW7UWVvPzUbAH";

const askRow: AskHaystackRow = {
  tool_calls: JSON.stringify([{ id: ID, name: "ask_user_question", status: "waiting_for_input" }]),
};
const noticeRow: AskHaystackRow = {
  tool_calls: null,
  blocks: JSON.stringify([{ type: "text", text: "turn interrupted by a server restart" }]),
};

describe("rowsCarryAsk", () => {
  test("la domanda e' l'ultima riga: si riconosce", () => {
    expect(rowsCarryAsk([askRow], ID, decode)).toBe(true);
  });

  /** The measured case: a notice landed under the question. */
  test("un cartello scritto SOTTO la domanda non la nasconde", () => {
    expect(rowsCarryAsk([noticeRow, askRow], ID, decode)).toBe(true);
  });

  test("una sessione senza quella domanda dice di no", () => {
    expect(rowsCarryAsk([noticeRow], ID, decode)).toBe(false);
  });

  /**
   * The id alone is not enough: another tool could carry it. Both halves have
   * to be there, or an answer would be routed to a rendez-vous nobody opened.
   */
  test("lo stesso id su un tool che non e' la domanda non basta", () => {
    const other: AskHaystackRow = {
      tool_calls: JSON.stringify([{ id: ID, name: "bash", status: "running" }]),
    };
    expect(rowsCarryAsk([other], ID, decode)).toBe(false);
  });

  test("una domanda di un ALTRO turno non risponde per questa", () => {
    const otherAsk: AskHaystackRow = {
      tool_calls: JSON.stringify([{ id: "toolu_altro", name: "ask_user_question" }]),
    };
    expect(rowsCarryAsk([otherAsk], ID, decode)).toBe(false);
  });
});
