/**
 * A card in AI review wakes whoever has to close it (rule of 28/10, whoever
 * opens a card closes it): its opener's chat when it can take a turn, the coordinator when
 * it cannot or when there is no chat at all (`agent:api`, schedules), and
 * nobody when neither exists, with the event and the activity row every time.
 *
 * @covers KANBAN-102
 */
import { test, expect, describe } from "bun:test";
import { aiReviewWakeText, createAiReviewNotices, type AiReviewNotice, type AiReviewNoticeDeps } from "./ai-review-notice";

const card: AiReviewNotice = {
  taskId: "t1", projectId: "p1", title: "Rename the <route>", createdBy: "agent:session", openerTopicId: "opener",
};

function harness(over: Partial<AiReviewNoticeDeps> = {}) {
  const posts: Array<{ sessionKey: string; content: string; dispatched: unknown }> = [];
  const events: Array<Record<string, unknown>> = [];
  const rows: Array<Record<string, unknown>> = [];
  let answer = (): Response => new Response("{}", { status: 200 });
  const deps: AiReviewNoticeDeps = {
    route: async (req) => {
      const body = (await req.json()) as { sessionKey: string; messages: Array<{ content: string }>; dispatched: unknown };
      posts.push({ sessionKey: body.sessionKey, content: body.messages[0]!.content, dispatched: body.dispatched });
      return answer();
    },
    isBusy: () => false,
    sessionKeyOfTopic: (id) => (id === "opener" ? "sk-opener" : null),
    canWake: () => "wake",
    coordinatorSessionKey: () => "sk-coordinator",
    broadcast: (m) => { events.push(m as unknown as Record<string, unknown>); },
    recordActivity: (e) => { rows.push(e as unknown as Record<string, unknown>); },
    pollMs: 1,
    ...over,
  };
  return { n: createAiReviewNotices(deps), posts, events, rows, setAnswer: (f: () => Response) => { answer = f; } };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("who is woken", () => {
  test("the opener's chat, marked as the board's, with the way to close", async () => {
    const h = harness();
    h.n.request(card);
    await settle();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ sessionKey: "sk-opener", dispatched: true });
    expect(h.posts[0]!.content).toContain("update_task(status='done'");
    expect(h.posts[0]!.content).toContain("human_ask");
    expect(h.events[0]).toMatchObject({ type: "task:ai-review", taskId: "t1", notified: "opener", reminder: false });
    expect(h.rows[0]).toMatchObject({ category: "board", entityId: "t1" });
  });

  test("a card with no chat behind it (agent:api) goes to the coordinator", async () => {
    const h = harness();
    h.n.request({ ...card, createdBy: "agent:api", openerTopicId: null });
    await settle();
    expect(h.posts.map((p) => p.sessionKey)).toEqual(["sk-coordinator"]);
    expect(h.posts[0]!.content).toContain("update_global_task(status='done'");
  });

  test("an opener chat that can no longer take a turn hands it to the coordinator", async () => {
    const h = harness({ canWake: (sk) => (sk === "sk-opener" ? "row" : "wake") });
    h.n.request(card);
    await settle();
    expect(h.posts.map((p) => p.sessionKey)).toEqual(["sk-coordinator"]);
  });

  test("a reminder goes to the coordinator even when the opener has a chat", async () => {
    const h = harness();
    h.n.request({ ...card, reminder: true });
    await settle();
    expect(h.posts.map((p) => p.sessionKey)).toEqual(["sk-coordinator"]);
    expect(h.events[0]).toMatchObject({ reminder: true, notified: "coordinator" });
  });

  test("nobody to wake: the event and the activity row still go out", async () => {
    const h = harness({ coordinatorSessionKey: () => null });
    h.n.request({ ...card, openerTopicId: null });
    await settle();
    expect(h.posts).toEqual([]);
    expect(h.events[0]).toMatchObject({ notified: null });
    expect(h.rows).toHaveLength(1);
  });
});

describe("the wake never cuts into a turn", () => {
  test("a busy session is waited for; a 409 stream_in_flight is retried", async () => {
    let busy = true;
    const h = harness({ isBusy: () => busy });
    let refusals = 1;
    h.setAnswer(() => (refusals-- > 0
      ? new Response(JSON.stringify({ code: "stream_in_flight" }), { status: 409 })
      : new Response("{}", { status: 200 })));
    h.n.request(card);
    await settle();
    expect(h.posts).toEqual([]);
    busy = false;
    await settle();
    expect(h.posts).toHaveLength(2);
  });
});

describe("a failed wake is not the end of the notice", () => {
  test("the opener is retried, then the coordinator is woken in its place", async () => {
    const h = harness({ attempts: 2, retryMs: 1 });
    let calls = 0;
    h.setAnswer(() => (++calls <= 2 ? new Response("boom", { status: 500 }) : new Response("{}", { status: 200 })));
    h.n.request(card);
    await settle();
    expect(h.posts.map((p) => p.sessionKey)).toEqual(["sk-opener", "sk-opener", "sk-coordinator"]);
    expect(h.posts[2]!.content).toContain("update_global_task(status='done'");
    expect(h.rows.filter((r) => r.title === "AI review notice not delivered")).toEqual([]);
  });

  test("the coordinator is retried too: a single 500 does not lose the notice", async () => {
    const h = harness({ attempts: 3, retryMs: 1 });
    let calls = 0;
    h.setAnswer(() => (++calls === 1 ? new Response("boom", { status: 500 }) : new Response("{}", { status: 200 })));
    h.n.request({ ...card, createdBy: "agent:api", openerTopicId: null });
    await settle();
    expect(h.posts.map((p) => p.sessionKey)).toEqual(["sk-coordinator", "sk-coordinator"]);
  });

  test("nobody could be woken: a warning row says so, with the reasons", async () => {
    const h = harness({ attempts: 2, retryMs: 1 });
    h.setAnswer(() => new Response("boom", { status: 500 }));
    h.n.request(card);
    await settle();
    expect(h.posts).toHaveLength(4);
    const lost = h.rows.find((r) => r.title === "AI review notice not delivered");
    expect(lost).toMatchObject({ level: "warn", entityId: "t1" });
    expect(String(lost!.detail)).toContain("opener: the chat route answered 500");
    expect(String(lost!.detail)).toContain("coordinator: the chat route answered 500");
  });
});

test("the card's title is data: quoted, its `<` neutralised", () => {
  const text = aiReviewWakeText(card, "opener");
  expect(text).toContain('title="Rename the <\\route>"');
  expect(text.startsWith("<card-ai-review ")).toBe(true);
});
