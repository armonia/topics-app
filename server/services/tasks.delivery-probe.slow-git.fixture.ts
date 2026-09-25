/**
 * Run by `tasks.delivery-probe.test.ts` in a process of its own, with a slow
 * fake `git` first on PATH: a synchronous git, the thing under test, resolves
 * `git` against the PATH the process started with. The fake stamps
 * `start-<symbol>` and `end-<symbol>` in $MARKS around every `log -S`; this
 * side records the loop's beats. A git run on the loop leaves no beat between
 * its two stamps, whatever the load; one run off the loop leaves plenty.
 *
 *   single    one report, with a symbol git takes 3 s over and never finds
 *   multirow  that symbol in an older comment of the turn, and the delivery
 *             with a symbol git finds at once
 *   race      turn 1 delivers the slow symbol, the card goes back to work,
 *             turn 2 delivers the one git finds at once
 *
 * Prints one JSON line: `{ mode, beatsWhileGitRan, notes }`.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTaskService } from "./tasks";
import { freshDb, PID } from "./tasks-test-db";

const [root, mode] = [process.argv[2]!, process.argv[3] ?? "single"];
const marks = process.env.MARKS!;
const db = freshDb();
const s = createTaskService(db, { repoRootFor: () => root });
const t = s.create({ projectId: PID, text: "Una card", status: "in_progress" });

const beats: number[] = [];
const beat = setInterval(() => beats.push(Date.now()), 10);
const deliver = (summary: string) =>
  s.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review", summary } });

if (mode === "multirow") {
  s.addComment({ taskId: t.id, author: "agent-1", content: "Aggiunto `slowSymbolNeverWritten` nel modulo." });
  // A later timestamp for the delivery, so it reads as the newest row.
  await new Promise((r) => setTimeout(r, 30));
  deliver("Nuovo `foundSymbolHere` nel modulo.");
} else if (mode === "race") {
  deliver("Turno 1: aggiunto `slowSymbolNeverWritten` nel modulo.");
  s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "in_progress" } });
  deliver("Turno 2: nuovo `foundSymbolHere` nel modulo.");
} else {
  deliver("Nuovo `slowSymbolNeverWritten` nel modulo.");
}

// Until the slow git is over, and then long enough for whatever its answer
// makes this side do.
const slowEnd = join(marks, "end-slowSymbolNeverWritten");
const until = Date.now() + 20_000;
while (!existsSync(slowEnd) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
await new Promise((r) => setTimeout(r, 300));
clearInterval(beat);

let beatsWhileGitRan: number | null = null;
try {
  const from = statSync(join(marks, "start-slowSymbolNeverWritten")).mtimeMs;
  const to = statSync(slowEnd).mtimeMs;
  beatsWhileGitRan = beats.filter((b) => b > from && b < to).length;
} catch { /* git was never asked: null says so */ }
const notes = s.get(t.id)!.comments.filter((c) => c.kind === "review-note").map((c) => c.content);
console.log(JSON.stringify({ mode, beatsWhileGitRan, notes }));
