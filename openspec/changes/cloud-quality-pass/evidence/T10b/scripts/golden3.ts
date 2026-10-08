// T10b B3: on the same seeded DB, T10b's `list` deep-equals BASE's `list`
// (values and key order), for the feed call and a few other shapes of `list`;
// and, given a feed body served by T10b, that body is BASE's list minus the
// 19 FEED_OMITTED_TASK_FIELDS, key for key and in order.
// usage: bun run golden3.ts <baseRepo> <otherRepo> <dbPath> [feed.json]
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
const [baseRepo, otherRepo, dbPath, feedPath] = process.argv.slice(2);
const db = new Database(dbPath!, { readonly: true });
const baseSvc = (await import(resolve(baseRepo!, "server/services/tasks.ts"))).createTaskService(db, {});
const otherSvc = (await import(resolve(otherRepo!, "server/services/tasks.ts"))).createTaskService(db, {});
const calls: Array<Record<string, unknown>> = [
  { scope: "all", rootsOnly: true, includeOrphanSubtasks: true, doneLimit: 120 },
  { scope: "all", rootsOnly: true, doneLimit: 120 },
  { scope: "all" },
  { scope: "all", withDescription: true },
];
let bad = 0;
for (const args of calls) {
  const a = baseSvc.list(args) as Array<Record<string, unknown>>;
  const b = otherSvc.list(args) as Array<Record<string, unknown>>;
  const deep = Bun.deepEquals(a, b, true);
  const sameJson = JSON.stringify(a) === JSON.stringify(b);
  if (!deep || !sameJson) bad++;
  console.log(JSON.stringify({ bun: Bun.version, args, rows: a.length, keys: Object.keys(a[0] ?? {}).length, deepEqualStrict: deep, sameJsonKeyOrder: sameJson }));
  if (!deep) console.log("  first diff row:", JSON.stringify(a.find((r, i) => !Bun.deepEquals(r, b[i], true)))?.slice(0, 200));
}
if (feedPath) {
  const { FEED_OMITTED_TASK_FIELDS } = await import(resolve(otherRepo!, "shared/board-feed.ts"));
  const served = JSON.parse(readFileSync(feedPath, "utf8")).tasks as Array<Record<string, unknown>>;
  const expected = JSON.parse(JSON.stringify(baseSvc.list({ scope: "all", rootsOnly: true, includeOrphanSubtasks: true, doneLimit: 120 })))
    .map((t: Record<string, unknown>) => Object.fromEntries(Object.entries(t).filter(([k]) => !FEED_OMITTED_TASK_FIELDS.includes(k))));
  const same = JSON.stringify(served) === JSON.stringify(expected);
  if (!same) bad++;
  console.log(JSON.stringify({ bun: Bun.version, feedBody: feedPath, rows: served.length, keysServed: Object.keys(served[0] ?? {}).length, omitted: FEED_OMITTED_TASK_FIELDS.length, equalsBaseListMinusOmitted: same }));
}
console.log(bad === 0 ? "B3 OK" : `B3 RED: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
