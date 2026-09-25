/**
 * Run by `tasks.delivery-probe.test.ts` in a process of its own, with a slow
 * fake `git` first on PATH: a card goes to review with a report that declares
 * a symbol, and the loop is sampled every 10 ms from the update to the note.
 * Prints one JSON line: `{ note, worstLagMs }`.
 */
import { createTaskService } from "./tasks";
import { freshDb, PID } from "./tasks-test-db";

const root = process.argv[2]!;
const db = freshDb();
const s = createTaskService(db, { repoRootFor: () => root });
const t = s.create({ projectId: PID, text: "Una card", status: "in_progress" });

let worstLagMs = 0;
let last = performance.now();
const beat = setInterval(() => {
  const now = performance.now();
  worstLagMs = Math.max(worstLagMs, now - last - 10);
  last = now;
}, 10);

s.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review", summary: "Nuovo `slowSymbolNeverWritten` nel modulo." } });

const note = () => s.get(t.id)!.comments.find((c) => c.kind === "review-note")?.content ?? null;
const until = Date.now() + 8_000;
while (!note() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
// One more beat, so that an update that held the loop is counted even when its
// note was already there when it returned.
await new Promise((r) => setTimeout(r, 30));
clearInterval(beat);
console.log(JSON.stringify({ note: note(), worstLagMs: Math.round(worstLagMs) }));
