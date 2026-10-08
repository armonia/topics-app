// Golden: the feed rows of BASE and HEAD on the same DB copy. HEAD's row must
// equal BASE's row minus FEED_OMITTED_TASK_FIELDS, keys in the same order.
// usage: bun run golden.ts <baseRepo> <headRepo> <dbPath> <out.json>
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
const [baseRepo, headRepo, dbPath, out] = process.argv.slice(2);
const args = { scope: "all", rootsOnly: true, includeOrphanSubtasks: true, doneLimit: 120 };
const db = new Database(dbPath!, { readonly: true });
const baseSvc = (await import(resolve(baseRepo!, "server/services/tasks.ts"))).createTaskService(db, {});
const headSvc = (await import(resolve(headRepo!, "server/services/tasks.ts"))).createTaskService(db, {});
const { toFeedTask, FEED_OMITTED_TASK_FIELDS } = await import(resolve(headRepo!, "shared/board-feed.ts"));
const before = JSON.parse(JSON.stringify(baseSvc.list(args))) as Array<Record<string, unknown>>;
const after = JSON.parse(JSON.stringify(headSvc.list(args).map(toFeedTask))) as Array<Record<string, unknown>>;
let diffs = 0;
const dropped = new Map<string, number>();
for (let i = 0; i < before.length; i++) {
  const expected: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(before[i]!)) {
    if (FEED_OMITTED_TASK_FIELDS.includes(k)) { dropped.set(k, (dropped.get(k) ?? 0) + 1); continue; }
    expected[k] = v;
  }
  if (JSON.stringify(expected) !== JSON.stringify(after[i])) { diffs++; if (diffs < 3) console.log("DIFF", JSON.stringify(expected).slice(0, 300), "\n   ", JSON.stringify(after[i]).slice(0, 300)); }
}
const res = { rows: before.length, rowsAfter: after.length, diffs, keysBefore: Object.keys(before[0] ?? {}).length, keysAfter: Object.keys(after[0] ?? {}).length, droppedKeys: Object.fromEntries(dropped), bytesBefore: JSON.stringify({ tasks: before }).length, bytesAfter: JSON.stringify({ tasks: after }).length };
console.log(JSON.stringify(res, null, 2));
writeFileSync(out!, JSON.stringify(res, null, 2));
