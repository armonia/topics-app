/**
 * A turn blocked on a person is alive and is NOT working (RGATE-12). One chat,
 * one label: the fourth source of the gate already says "waiting for a person",
 * so the same turn must not also pass for a stream.
 *
 * Own file because `quiescence.test.ts` already sits at the bloat threshold.
 *
 * @covers RGATE-12
 */
import { test, expect, describe } from "bun:test";
import { describeInFlight, splitOnPerson } from "./quiescence";

describe("splitOnPerson - a turn waiting for a person is not working", () => {
  const stream = (sessionKey: string) => ({ sessionKey, messageId: `m-${sessionKey}` });
  const waiting = (...keys: string[]) => (key: string) => keys.includes(key);

  test("the chat under an open question goes to the waiting side, whole", () => {
    const asking = stream("topic:asking");
    const { working, onPerson } = splitOnPerson([asking, stream("topic:busy")], (s) => s.sessionKey, waiting("topic:asking"));
    expect(onPerson).toEqual([asking]);
    expect(working.map((s) => s.sessionKey)).toEqual(["topic:busy"]);
  });

  test("with nobody waiting, nothing moves and the order is kept", () => {
    const { working, onPerson } = splitOnPerson(["topic:a", "topic:b", "topic:c"], (k) => k, () => false);
    expect(working).toEqual(["topic:a", "topic:b", "topic:c"]);
    expect(onPerson).toEqual([]);
  });

  test("bare session keys work too (the broker hands over no objects)", () => {
    const { working, onPerson } = splitOnPerson(["topic:a", "topic:b"], (k) => k, waiting("topic:b"));
    expect(working).toEqual(["topic:a"]);
    expect(onPerson).toEqual(["topic:b"]);
  });

  /** WHICH WAY THE DOUBT FALLS: an unreadable registry leaves the turn WORKING, never parked. */
  test("a predicate that throws leaves the turn working", () => {
    const { working, onPerson } = splitOnPerson([stream("topic:a")], (s) => s.sessionKey, () => { throw new Error("registro illeggibile"); });
    expect(working.map((s) => s.sessionKey)).toEqual(["topic:a"]);
    expect(onPerson).toEqual([]);
  });

  test("the parked side is what `describeInFlight` calls a chat stopped on a question", () => {
    const { working, onPerson } = splitOnPerson([stream("topic:asking")], (s) => s.sessionKey, waiting("topic:asking"));
    const busy = describeInFlight({
      cards: 0, streamKeys: working.map((s) => s.sessionKey), brokerOpenKeys: [],
      askOpenKeys: onPerson.map((s) => s.sessionKey),
    });
    expect(busy).toBe("1 chat ferma/e su una domanda (topic:asking)");
  });
});
