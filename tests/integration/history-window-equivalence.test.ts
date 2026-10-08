/**
 * `GET /api/history/:key` with a cap (`limit` > 0, or `before`) picks the window
 * on a SKELETON of the thread and reads the real rows only for the messages that
 * go out (`loadThreadSkeleton` / `loadThreadRows`), instead of loading the whole
 * session. The answer must be IDENTICAL to the one from the full read: same
 * messages, same `total`, same `promptNumber`s (counted on the WHOLE thread),
 * same `hasOrphanedMessage`.
 *
 * The test thread has everything that changes the count or the order:
 * alternative branches with a chosen active branch, a gateway context envelope
 * and a machine turn (neither is a prompt), a partial with text (kept, and
 * closed) and an empty one (dropped).
 *
 * The expected results (`history-window-equivalence.golden.json`) were produced
 * by the route BEFORE the change, with the full read. If the response format is
 * changed on purpose, regenerate them with `GOLDEN=1`.
 * @covers WIRE-09
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredMessage } from "../../server/types";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("history-window-equivalence");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

const GOLDEN = join(import.meta.dir, "history-window-equivalence.golden.json");
const SESSION = "topic:hwe";

function t(i: number): string {
  return new Date(Date.UTC(2026, 0, 3, 0, 0, i)).toISOString();
}

/** A thread of 40 turns plus the oddities. Fixed ids: the answer is deterministic. */
function thread(): StoredMessage[] {
  const msgs: StoredMessage[] = [];
  let parent: string | null = null;
  let n = 0;
  const push = (m: Partial<StoredMessage> & { id: string; role: "user" | "assistant" }) => {
    msgs.push({ content: `testo ${m.id}`, timestamp: t(n++), parentId: parent, ...m } as StoredMessage);
    parent = m.id;
  };
  for (let i = 0; i < 20; i++) {
    push({ id: `u${i}`, role: "user" });
    push({ id: `a${i}`, role: "assistant" });
  }
  // A fork: two answers to the same question, the person picks the second.
  push({ id: "u20", role: "user" });
  const fork = parent;
  msgs.push({ id: "a20-0", role: "assistant", content: "ramo zero", timestamp: t(n++), parentId: fork, branchIndex: 0 } as StoredMessage);
  msgs.push({ id: "a20-1", role: "assistant", content: "ramo uno", timestamp: t(n++), parentId: fork, branchIndex: 1 } as StoredMessage);
  parent = "a20-1";
  // A gateway context envelope and a machine turn: no number.
  push({ id: "uctx", role: "user", content: "[Chat messages since your last reply - ecco]" });
  push({ id: "actx", role: "assistant" });
  push({
    id: "umach", role: "user", content: "continua",
    blocks: [{ kind: "goal-nudge", text: "continua" } as never],
  });
  push({ id: "amach", role: "assistant" });
  for (let i = 21; i < 40; i++) {
    push({ id: `u${i}`, role: "user" });
    push({ id: `a${i}`, role: "assistant" });
  }
  // A partial with text (stays), then an empty partial (goes away).
  push({ id: "u40", role: "user" });
  push({ id: "apart", role: "assistant", content: "risposta a meta", partial: true });
  push({ id: "u41", role: "user" });
  push({ id: "aempty", role: "assistant", content: "", partial: true });
  return msgs;
}

const REQUESTS = [
  "?limit=5",
  "?limit=5&offset=3",
  "?limit=500",
  "?limit=3&before=u30",
  "?limit=0&before=u30",
  "?limit=4&before=actx",
  "?limit=2&before=unknown-id",
];

async function responses(): Promise<Record<string, unknown>> {
  const { createHistoryRouter } = await import("../../server/routes/history");
  const ctx = await createTestAppContext();
  ctx.saveLocalMessages(SESSION, thread());
  ctx.db.prepare("INSERT OR REPLACE INTO active_branches (parent_id, session_key, active_branch_index) VALUES (?, ?, ?)").run("u20", SESSION, 1);
  const router = createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => { throw new Error("no provider: the thread is all local"); },
  });
  const path = `/api/history/${encodeURIComponent(SESSION)}`;
  const out: Record<string, unknown> = {};
  for (const q of REQUESTS) {
    const url = new URL(`http://h${path}${q}`);
    const resp = (await router(new Request(url), url, path, "GET"))!;
    const body = JSON.parse(await resp.text());
    // The fields that decide order, numbering and branch annotations: the whole
    // wire shape of a message is covered by the other history-* tests.
    out[q] = {
      status: resp.status,
      total: body.total,
      hasOrphanedMessage: body.hasOrphanedMessage,
      isStreaming: body.isStreaming,
      messages: (body.messages as Array<StoredMessage & { promptNumber?: number }>).map((m) => [m.id, m.promptNumber ?? null, !!m.partial, m.siblingCount ?? null, m.activeBranchIndex ?? null, m.content]),
    };
  }
  return out;
}

describe("capped history: the window is identical to the full read", () => {
  test("same messages, total, promptNumber and orphan on seven requests", async () => {
    const got = await responses();
    if (process.env.GOLDEN === "1") {
      writeFileSync(GOLDEN, JSON.stringify(got) + "\n");
      return;
    }
    expect(existsSync(GOLDEN)).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(JSON.parse(JSON.stringify(got))).toEqual(golden);
  });
});
