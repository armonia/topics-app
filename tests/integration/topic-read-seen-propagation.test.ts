/**
 * Reading a topic is ONE gesture that must switch off TWO counters, and every
 * connected window must hear about both.
 *
 * `POST /api/topics/:id/read` zeroes the topic's unread (the sidebar badge, and
 * through `chromeAttentionTotal` the dock/tray number) AND marks every bell row
 * whose subject is that topic as seen, broadcasting `unread:updated {0}` and
 * `notification:seen {unseen}` on the chat WebSocket. Before the second half
 * existed the bell stayed lit after the chat was read: two counters about the
 * same fact saying different things, and the one left on had no natural gesture
 * to clear it.
 *
 * THE REAL SERVER, as a child process: the in-process router harness stubs
 * `broadcastToAll` to a no-op, and the frames on the socket are the claim here.
 * The unread is raised the way the e2e suite raises it, with a system message;
 * the bell row is written through the same POST the banner path uses.
 *
 * @covers UNREAD-01, NOTIF-SEEN-01
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { testTmpDir, spawnRealServer, type RealServer } from "./helpers";

const ROOT = testTmpDir("topic-read-seen");
let server: RealServer;

type Frame = Record<string, unknown> & { type: string };

/** A chat socket that keeps every frame it receives. */
async function openChatSocket(): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const frames: Frame[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  ws.onmessage = (ev) => {
    try { frames.push(JSON.parse(String(ev.data)) as Frame); } catch { /* non-JSON frame */ }
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket timed out")), 10_000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket failed")); };
  });
  return { ws, frames };
}

/** Wait for a frame matching `pred` to land, from index `from` on. No fixed sleep:
 *  the poll ends the moment the frame is there. */
async function waitForFrame(frames: Frame[], from: number, pred: (f: Frame) => boolean, what: string): Promise<Frame> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const hit = frames.slice(from).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no ${what} frame within 10 s; saw: ${frames.slice(from).map((f) => f.type).join(", ") || "(nothing)"}`);
}

async function postJson<T = unknown>(pathname: string, body?: unknown): Promise<T> {
  const res = await fetch(`${server.baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${pathname} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function getJson<T = unknown>(pathname: string): Promise<T> {
  const res = await fetch(`${server.baseUrl}${pathname}`);
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}`);
  return (await res.json()) as T;
}

interface NotificationRow { id: string; targetKind: string | null; targetId: string | null; seenAt: string | null }
interface NotificationsPage { rows: NotificationRow[]; unseen: number }
type Unread = Record<string, { unreadCount?: number } | undefined>;

beforeAll(async () => {
  server = await spawnRealServer(ROOT);
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("POST /api/topics/:id/read propagates 'seen' to both counters and to every socket", () => {
  test("zeroes the unread, clears the topic's bell rows, broadcasts unread:updated and notification:seen", async () => {
    const { ws, frames } = await openChatSocket();
    try {
      const topic = await postJson<{ id: string }>("/api/topics", { name: "read-propagation" });
      // Another topic with its own bell row: reading the first must not touch it.
      const other = await postJson<{ id: string }>("/api/topics", { name: "read-propagation-other" });

      // Raise the unread the way a real message does (assistant message -> updateUnreadCount).
      await postJson(`/api/topics/${topic.id}/system-message`, { content: "hello from the test" });
      await waitForFrame(frames, 0, (f) => f.type === "unread:updated" && f.topicId === topic.id && f.unreadCount === 1, "unread:updated{1}");
      expect((await getJson<Unread>("/api/unread"))[topic.id]?.unreadCount).toBe(1);

      // Two bell rows about this topic (distinct dedupe keys), one about the other.
      for (const [target, key] of [[topic.id, "turn-1"], [topic.id, "turn-2"], [other.id, "turn-1"]] as const) {
        const r = await postJson<{ recorded: boolean }>("/api/notifications", {
          kind: "completion", title: `finished ${key}`, body: "", dedupeKey: `${target}:${key}`,
          targetKind: "topic", targetId: target,
        });
        expect(r.recorded).toBe(true);
      }
      const before = await getJson<NotificationsPage>("/api/notifications");
      const mine = before.rows.filter((r) => r.targetKind === "topic" && r.targetId === topic.id);
      expect(mine).toHaveLength(2);
      expect(mine.every((r) => r.seenAt === null)).toBe(true);
      expect(before.unseen).toBeGreaterThanOrEqual(3);

      // THE GESTURE. Everything below is what one read must produce.
      const mark = frames.length;
      const read = await postJson<{ ok: boolean }>(`/api/topics/${topic.id}/read`);
      expect(read.ok).toBe(true);

      // Counter 1: the unread is zero, and every window was told.
      const unreadFrame = await waitForFrame(frames, mark, (f) => f.type === "unread:updated" && f.topicId === topic.id, "unread:updated{0}");
      expect(unreadFrame.unreadCount).toBe(0);
      expect((await getJson<Unread>("/api/unread"))[topic.id]?.unreadCount ?? 0).toBe(0);

      // Counter 2: the bell rows of THIS topic are seen, the other topic's is not,
      // and the broadcast carries the new unseen count.
      const seenFrame = await waitForFrame(frames, mark, (f) => f.type === "notification:seen", "notification:seen");
      const after = await getJson<NotificationsPage>("/api/notifications");
      expect(after.rows.filter((r) => r.targetId === topic.id).every((r) => r.seenAt !== null)).toBe(true);
      expect(after.rows.filter((r) => r.targetId === other.id).every((r) => r.seenAt === null)).toBe(true);
      expect(after.unseen).toBe(before.unseen - 2);
      expect(seenFrame.unseen).toBe(after.unseen);
    } finally {
      ws.close();
    }
  }, 90_000);

  test("a second read of an already-read topic is silent: no unread:updated, no notification:seen", async () => {
    const { ws, frames } = await openChatSocket();
    try {
      const topic = await postJson<{ id: string }>("/api/topics", { name: "read-twice" });
      await postJson(`/api/topics/${topic.id}/system-message`, { content: "once" });
      await postJson("/api/notifications", {
        kind: "completion", title: "finished", body: "", dedupeKey: `${topic.id}:once`, targetKind: "topic", targetId: topic.id,
      });
      await postJson(`/api/topics/${topic.id}/read`);
      await waitForFrame(frames, 0, (f) => f.type === "notification:seen", "first notification:seen");

      // Second read: the route answers ok and must produce nothing on the wire.
      // Proven with a marker frame: a `ping` sent AFTER the read is answered in
      // order on this connection, so a `pong` with no seen/unread frame before it
      // is the absence, without waiting on a clock.
      const mark = frames.length;
      expect((await postJson<{ ok: boolean }>(`/api/topics/${topic.id}/read`)).ok).toBe(true);
      ws.send(JSON.stringify({ type: "ping" }));
      await waitForFrame(frames, mark, (f) => f.type === "pong", "pong");
      const noise = frames.slice(mark).filter((f) => f.type === "notification:seen" || (f.type === "unread:updated" && f.topicId === topic.id));
      expect(noise).toEqual([]);
    } finally {
      ws.close();
    }
  }, 90_000);
});
