/**
 * Seeing a chat is ONE gesture that must switch off TWO counters, and every
 * connected window must hear about it.
 *
 * `POST /api/attention/seen` (the one seen door, ATTN-06) zeroes the chat's
 * unread AND marks every history row whose subject is that chat as seen, and
 * says so on the chat WebSocket in ONE frame: `attention:updated`, whose row
 * carries the unread at zero. Before the second half existed the bell stayed
 * lit after the chat was read: two counters about the same fact saying
 * different things. The old door (`POST /api/topics/:id/read`) and its two
 * frames (`unread:updated`, `notification:seen`) went with the client that
 * read them (notifications-redesign, tasks.md 6.2).
 *
 * THE REAL SERVER, as a child process: the in-process router harness stubs
 * `broadcastToAll` to a no-op, and the frames on the socket are the claim here.
 * The unread is raised the way the e2e suite raises it, with a system message;
 * the history rows are written through the log's public POST.
 *
 * @covers UNREAD-01, NOTIF-SEEN-01, NOTIF-ONE-01
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

/** The seen door, for one chat, with what the client was showing. */
async function seeChat(topicId: string): Promise<{ ok: boolean; rows: { subject: string; unread: number }[] }> {
  return postJson(`/api/attention/seen`, { items: [{ subject: `topic:${topicId}`, epoch: 0, turnAt: null }] });
}

const isChatFrame = (topicId: string) => (f: Frame) =>
  f.type === "attention:updated" && (f.row as { subject?: string } | undefined)?.subject === `topic:${topicId}`;

describe("POST /api/attention/seen propagates 'seen' to both counters and to every socket", () => {
  test("zeroes the unread, clears the chat's history rows, and announces it in the chat's attention frame", async () => {
    const { ws, frames } = await openChatSocket();
    try {
      const topic = await postJson<{ id: string }>("/api/topics", { name: "read-propagation" });
      // Another topic with its own row: seeing the first must not touch it.
      const other = await postJson<{ id: string }>("/api/topics", { name: "read-propagation-other" });

      // Raise the unread the way a real message does (assistant message -> updateUnreadCount).
      await postJson(`/api/topics/${topic.id}/system-message`, { content: "hello from the test" });
      expect((await getJson<Unread>("/api/unread"))[topic.id]?.unreadCount).toBe(1);

      // Two rows about this topic (distinct dedupe keys), one about the other.
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
      // `unseen` counts SUBJECTS: two rows of one chat are one thing to look at.
      expect(before.unseen).toBeGreaterThanOrEqual(2);

      // THE GESTURE. Everything below is what one seen must produce.
      const mark = frames.length;
      const seen = await seeChat(topic.id);
      expect(seen.ok).toBe(true);
      expect(seen.rows.map((r) => [r.subject, r.unread])).toEqual([[`topic:${topic.id}`, 0]]);

      // Counter 1: the unread is zero, and every window was told, in the chat's attention frame.
      const frame = await waitForFrame(frames, mark, isChatFrame(topic.id), "attention:updated of the chat");
      expect((frame.row as { unread: number }).unread).toBe(0);
      expect((await getJson<Unread>("/api/unread"))[topic.id]?.unreadCount ?? 0).toBe(0);

      // Counter 2: the rows of THIS topic are seen, the other topic's is not.
      const after = await getJson<NotificationsPage>("/api/notifications");
      expect(after.rows.filter((r) => r.targetId === topic.id).every((r) => r.seenAt !== null)).toBe(true);
      expect(after.rows.filter((r) => r.targetId === other.id).every((r) => r.seenAt === null)).toBe(true);
      expect(after.unseen).toBe(before.unseen - 1);
    } finally {
      ws.close();
    }
  }, 90_000);

  test("a second seen of an already seen chat announces again and changes nothing (defect E)", async () => {
    const { ws, frames } = await openChatSocket();
    try {
      const topic = await postJson<{ id: string }>("/api/topics", { name: "read-twice" });
      await postJson(`/api/topics/${topic.id}/system-message`, { content: "once" });
      await postJson("/api/notifications", {
        kind: "completion", title: "finished", body: "", dedupeKey: `${topic.id}:once`, targetKind: "topic", targetId: topic.id,
      });
      await seeChat(topic.id);
      await waitForFrame(frames, 0, isChatFrame(topic.id), "first attention:updated");
      const seenOnce = await getJson<NotificationsPage>("/api/notifications");

      // The door ALWAYS answers on the wire, even with nothing left to clear:
      // a window that sent a seen must hear the server's row back.
      const mark = frames.length;
      expect((await seeChat(topic.id)).ok).toBe(true);
      const again = await waitForFrame(frames, mark, isChatFrame(topic.id), "second attention:updated");
      expect((again.row as { unread: number }).unread).toBe(0);
      expect((await getJson<NotificationsPage>("/api/notifications")).unseen).toBe(seenOnce.unseen);
    } finally {
      ws.close();
    }
  }, 90_000);
});
