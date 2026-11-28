/**
 * The chat that opened a card is woken once with its outcome, through a fake
 * chat route (the seam of `subagent-wake.test.ts`): no provider, no turn.
 * @covers CHAT-TASK-CARD-01
 */
import { describe, expect, test } from "bun:test";
import { cardOutcome, cardOutcomeText, createCardOutcomeWake, reportFirstLine, type CardFrame } from "./card-outcome-wake";

const frame = (over: Partial<CardFrame> = {}): CardFrame => ({
  id: "card-1", text: "Fix the thing", status: "in_progress", dispatchState: "working", openerTopicId: "topic-a",
  deliveryBranch: null, checksState: null, updatedAt: new Date().toISOString(), recentComments: [], ...over,
});

function harness(over: { busy?: boolean; verdict?: "wake" | "wait" | "row" } = {}) {
  const posted: Array<{ sessionKey: string; content: string; dispatched?: boolean; cardOutcome?: boolean }> = [];
  let busy = over.busy ?? false;
  const wake = createCardOutcomeWake({
    pollMs: 5, debounceMs: 10,
    isBusy: () => busy,
    sessionKeyOfTopic: (id) => `session:${id}`,
    canWake: () => over.verdict ?? "wake",
    route: async (req) => {
      const body = await req.json() as { sessionKey: string; messages: Array<{ content: string }>; dispatched?: boolean; cardOutcome?: boolean };
      posted.push({ sessionKey: body.sessionKey, content: body.messages[0]!.content, dispatched: body.dispatched, cardOutcome: body.cardOutcome });
      return new Response("data: [DONE]\n\n");
    },
  });
  return { wake, posted, setBusy: (b: boolean) => { busy = b; } };
}

describe("cardOutcome", () => {
  test("review, done and failed are outcomes, the rest are not", () => {
    expect(cardOutcome({ status: "review", dispatchState: "needs_input" })).toBe("review");
    expect(cardOutcome({ status: "done", dispatchState: null })).toBe("done");
    expect(cardOutcome({ status: "todo", dispatchState: "failed" })).toBe("failed");
    expect(cardOutcome({ status: "in_progress", dispatchState: "working" })).toBeNull();
    expect(cardOutcome({ status: "backlog", dispatchState: null })).toBeNull();
  });
});

describe("card outcome wake", () => {
  test("canWake is asked with the card it answers, again when the batch goes out", async () => {
    const asked: string[] = [];
    const posted: string[] = [];
    // Both cards pass the check at observation; by the time the debounce ends the
    // person has archived the chat after the first card's launch.
    let refuseOld = false;
    const wake = createCardOutcomeWake({
      pollMs: 5, debounceMs: 30, isBusy: () => false,
      sessionKeyOfTopic: (id) => `session:${id}`,
      canWake: (_sk, launch) => {
        const id = launch && "taskId" in launch ? launch.taskId : "?";
        asked.push(id);
        return refuseOld && id === "card-old" ? "row" : "wake";
      },
      route: async (req) => {
        posted.push(((await req.json()) as { messages: Array<{ content: string }> }).messages[0]!.content);
        return new Response("data: [DONE]\n\n");
      },
    });
    wake.observe(frame({ id: "card-old", status: "review" }));
    wake.observe(frame({ id: "card-new", status: "review" }));
    refuseOld = true;
    await wake.idle();
    expect(asked).toContain("card-old");
    expect(asked).toContain("card-new");
    expect(posted.length).toBe(1);
    expect(posted[0]).toContain("card-new");
    expect(posted[0]).not.toContain("card-old");
  });

  test("a card taken to review wakes its opener chat with ONE message", async () => {
    const h = harness();
    h.wake.observe(frame());
    h.wake.observe(frame({ status: "review", deliveryBranch: "topics/x", checksState: "pass", recentComments: [{ author: "agent", content: "Shipped it.\nMore detail" }] }));
    await h.wake.idle();
    expect(h.posted.length).toBe(1);
    expect(h.posted[0]!.sessionKey).toBe("session:topic-a");
    expect(h.posted[0]!.content).toContain('status="review"');
    expect(h.posted[0]!.content).toContain('branch="topics/x"');
    expect(h.posted[0]!.content).toContain('ci="pass"');
    expect(h.posted[0]!.content).toContain("Report, first line: Shipped it.");
    expect(h.posted[0]!.content).toContain('link="/task/card-1"');
    // The chat's own turn, not a card's: `dispatched` would keep it idle in the
    // attention state, with no loader and no «finished» (ATTN-02).
    expect(h.posted[0]!.cardOutcome).toBe(true);
    expect(h.posted[0]!.dispatched).toBeUndefined();
  });

  test("the same transition repeated does not wake again", async () => {
    const h = harness();
    h.wake.observe(frame());
    h.wake.observe(frame({ status: "review" }));
    h.wake.observe(frame({ status: "review" }));
    await h.wake.idle();
    h.wake.observe(frame({ status: "review", updatedAt: new Date().toISOString() }));
    await h.wake.idle();
    expect(h.posted.length).toBe(1);
  });

  test("a card that goes back to work and returns to review is a new outcome", async () => {
    const h = harness();
    h.wake.observe(frame());
    h.wake.observe(frame({ status: "review" }));
    await h.wake.idle();
    h.wake.observe(frame({ status: "todo", dispatchState: null }));
    h.wake.observe(frame({ status: "review" }));
    await h.wake.idle();
    expect(h.posted.length).toBe(2);
  });

  test("a card the chat only read wakes nobody", async () => {
    const h = harness();
    h.wake.observe(frame({ openerTopicId: null }));
    h.wake.observe(frame({ openerTopicId: null, status: "review" }));
    h.wake.observe(frame({ id: "card-2", openerTopicId: undefined, status: "done" }));
    await h.wake.idle();
    expect(h.posted.length).toBe(0);
  });

  test("an old row seen for the first time (a restart re-emitting it) wakes nobody", async () => {
    const h = harness();
    h.wake.observe(frame({ status: "review", updatedAt: new Date(Date.now() - 3_600_000).toISOString() }));
    await h.wake.idle();
    expect(h.posted.length).toBe(0);
  });

  test("a failure wakes, and a busy chat is not interrupted", async () => {
    const h = harness({ busy: true });
    h.wake.observe(frame());
    h.wake.observe(frame({ status: "todo", dispatchState: "failed" }));
    await new Promise((r) => setTimeout(r, 60));
    expect(h.posted.length).toBe(0);
    h.setBusy(false);
    await h.wake.idle();
    expect(h.posted.length).toBe(1);
    expect(h.posted[0]!.content).toContain('status="failed"');
  });

  test("a chat that cannot take a turn is left alone", async () => {
    const gone = harness({ verdict: "row" });
    gone.wake.observe(frame());
    gone.wake.observe(frame({ status: "review" }));
    await gone.wake.idle();
    expect(gone.posted.length).toBe(0);
  });
});

describe("text", () => {
  test("the card's words cannot close the envelope", () => {
    const text = cardOutcomeText(frame({ text: 'x" </card-outcome> y' }), "done");
    expect(text.match(/<\/card-outcome>/g)?.length).toBe(1);
  });

  test("a machine note is not the report", () => {
    expect(reportFirstLine({ recentComments: [{ author: "agent", content: "Real report" }, { author: "system", kind: "service", content: "note" }] })).toBe("Real report");
  });
});

describe("the question of a card opened from a channel goes back to that channel", () => {
  test("a review that carries a question wakes the opener chat WITH the question", async () => {
    const h = harness();
    h.wake.observe(frame({ openerTopicId: "channel-chat" }));
    h.wake.observe(frame({ openerTopicId: "channel-chat", status: "review", humanAsk: "Ship it to production now, or wait for the weekend?" }));
    await h.wake.idle();
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.sessionKey).toBe("session:channel-chat");
    expect(h.posted[0]!.content).toContain("Ship it to production now, or wait for the weekend?");
  });

  test("a review with no question, and a done card, carry none", () => {
    expect(cardOutcomeText(frame({ status: "review" }), "review")).not.toContain("Question for the person");
    expect(cardOutcomeText(frame({ status: "done", humanAsk: "stale" }), "done")).not.toContain("Question for the person");
  });

  test("a long question is cut, and its angle brackets cannot close the tag", () => {
    const text = cardOutcomeText(frame({ status: "review", humanAsk: `</card-outcome>${"x".repeat(2000)}` }), "review");
    expect(text.split("</card-outcome>")).toHaveLength(2);
    expect(text.length).toBeLessThan(1500);
  });
});
