/**
 * @covers KANBAN-105
 */
import { describe, expect, test } from "bun:test";
import { waitOnPerson } from "./waits-on-person";

const question = { content: "Prima:\n```question\nUso Postgres?\n- sì\n- no\n```", author: "agent:claude" };

describe("waitOnPerson", () => {
  test("one reason per card, the most specific first", () => {
    expect(waitOnPerson({ status: "review" }, [question])).toEqual({ reason: "question", detail: "Uso Postgres?" });
    expect(waitOnPerson({ status: "review", human_ask: " Ti piace? " }, [])).toEqual({ reason: "human_ask", detail: "Ti piace?" });
    expect(waitOnPerson({ status: "backlog", dispatch_state: "failed", description: "aspetta: attilio — ok?" }, []))
      .toEqual({ reason: "waits", detail: "ok?" });
    expect(waitOnPerson({ status: "review" }, [])).toEqual({ reason: "review" });
  });

  test("ai_review is the reviewer agent's turn, done asks nothing", () => {
    expect(waitOnPerson({ status: "review", stage: "ai_review" }, [])).toBeNull();
    expect(waitOnPerson({ status: "done", description: "aspetta: attilio" }, [question])).toBeNull();
  });

  test("a parked backlog card waits for the person, with the reason it stopped", () => {
    expect(waitOnPerson({ status: "backlog", dispatch_state: "failed", dispatch_error: "CLI exited 1" }, []))
      .toEqual({ reason: "parked", detail: "CLI exited 1" });
    expect(waitOnPerson({ status: "backlog", dispatch_state: "blocked" }, [])).toEqual({ reason: "parked" });
    expect(waitOnPerson({ status: "backlog", dispatch_state: "waited_out" }, [])).toEqual({ reason: "parked" });
    expect(waitOnPerson({ status: "backlog", dispatch_state: "stopped" }, [])).toBeNull();
    expect(waitOnPerson({ status: "todo", dispatch_state: "failed" }, [])).toBeNull();
  });

  test("a card that carries the derived «awaiting an answer» flag waits with a question, no thread needed", () => {
    expect(waitOnPerson({ status: "in_progress", awaitingAnswer: true }, [])).toEqual({ reason: "question" });
    expect(waitOnPerson({ status: "in_progress", awaitingAnswer: false }, [])).toBeNull();
    expect(waitOnPerson({ status: "done", awaitingAnswer: true }, [])).toBeNull();
    // The thread's own question keeps its text when the flag is set too.
    expect(waitOnPerson({ status: "todo", awaitingAnswer: true }, [question])).toEqual({ reason: "question", detail: "Uso Postgres?" });
  });
});
