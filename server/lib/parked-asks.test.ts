/**
 * A parked question holds the restart - and stops holding it when it is over.
 *
 * The two tests that matter are the two halves of the same promise. If an open
 * question does not park its session, the restart cuts a panel a person was
 * about to answer (2026-08-28, 19:05, topic:4c935add). If an ANSWERED or a
 * long-dead one keeps parking it, what has been built is not a deferral, it is
 * a block: a restart that never arrives and nobody can explain.
 *
 * @covers HOLD-05
 */
import { test, expect, describe } from "bun:test";
import { sessionsParkedOnQuestion } from "./parked-asks";

const NOW = 1_800_000_000_000;
const ASK_LIFETIME_MS = 24 * 60 * 60 * 1000;

const toolCalls = (status: string, startedAt?: number) =>
  JSON.stringify([{
    id: "toolu_1",
    name: "mcp__topics__ask_user_question",
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
  }]);

const parked = (rows: Parameters<typeof sessionsParkedOnQuestion>[0]) =>
  sessionsParkedOnQuestion(rows, { now: NOW, ttlMs: ASK_LIFETIME_MS });

describe("sessionsParkedOnQuestion - chi sta aspettando una persona", () => {
  test("una domanda aperta parcheggia la sua sessione", () => {
    expect(parked([
      { sessionKey: "topic:4c935add", toolCalls: toolCalls("waiting_for_input", NOW - 60_000), blocks: null },
    ])).toEqual(["topic:4c935add"]);
  });

  /**
   * THE HALF THAT KEEPS IT A DEFERRAL. Answering flips the tool's status
   * (`/api/chat/tool-response` writes `running`), and from that instant the row
   * holds nothing: the turn is working again and the other sources speak for
   * it.
   */
  test("una domanda GIA' RISPOSTA non trattiene piu' niente", () => {
    expect(parked([
      { sessionKey: "topic:4c935add", toolCalls: toolCalls("running", NOW - 60_000), blocks: null },
    ])).toEqual([]);
    expect(parked([
      { sessionKey: "topic:4c935add", toolCalls: toolCalls("success", NOW - 60_000), blocks: null },
    ])).toEqual([]);
  });

  /**
   * THE OTHER FLOOR. A row that outlived the ask TTL is a question no human
   * attention is coming back to; holding the restart on it forever would be the
   * block, not the deferral.
   */
  test("una domanda piu' vecchia del TTL non trattiene", () => {
    expect(parked([
      { sessionKey: "topic:old", toolCalls: toolCalls("waiting_for_input", NOW - ASK_LIFETIME_MS - 1), blocks: null },
    ])).toEqual([]);
  });

  /**
   * THE ROW IS THE ONLY SOURCE THAT SURVIVES A RESTART, and after the restart
   * the question is no longer the last message of the session: the "turn
   * interrupted" notice has been written underneath it. So the window is
   * scanned, not just its bottom row.
   */
  test("la domanda non e' l'ultima riga: la si trova lo stesso", () => {
    expect(parked([
      { sessionKey: "topic:4c935add", toolCalls: null, blocks: null },
      { sessionKey: "topic:4c935add", toolCalls: toolCalls("waiting_for_input", NOW - 5_000), blocks: null },
    ])).toEqual(["topic:4c935add"]);
  });

  test("una sessione sola, anche con due righe aperte", () => {
    expect(parked([
      { sessionKey: "topic:a", toolCalls: toolCalls("waiting_for_input", NOW - 1_000), blocks: null },
      { sessionKey: "topic:a", toolCalls: toolCalls("waiting_for_input", NOW - 2_000), blocks: null },
      { sessionKey: "topic:b", toolCalls: toolCalls("waiting_for_input", NOW - 3_000), blocks: null },
    ])).toEqual(["topic:a", "topic:b"]);
  });

  /**
   * With no timestamp the wait exists all the same (`waitingAskStartedAt` says
   * so plainly): a panel on screen does not stop being on screen because
   * nobody wrote down when it opened.
   */
  test("una domanda senza `startedAt` trattiene ugualmente", () => {
    expect(parked([
      { sessionKey: "topic:senza-ora", toolCalls: toolCalls("waiting_for_input"), blocks: null },
    ])).toEqual(["topic:senza-ora"]);
  });

  test("il permesso e' lo stesso fatto: la chat aspetta te", () => {
    expect(parked([
      { sessionKey: "topic:perm", toolCalls: toolCalls("awaiting_permission", NOW - 1_000), blocks: null },
    ])).toEqual(["topic:perm"]);
  });

  test("una sessione senza chiave non e' parcheggiabile", () => {
    expect(parked([
      { sessionKey: null, toolCalls: toolCalls("waiting_for_input", NOW), blocks: null },
    ])).toEqual([]);
  });

  test("niente righe, niente da trattenere", () => {
    expect(parked([])).toEqual([]);
  });
});
