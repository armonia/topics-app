import { Database } from "bun:sqlite";
const db = new Database(process.argv[2]!);
const cols = (db.query("PRAGMA table_info(tasks)").all() as any[]).map((c) => c.name);
console.log("columns", cols.length);
const lean = cols.filter((n) => n !== "checks_json" && n !== "description" && !["interrupted_by","interrupted_notified_at","nudge_claimed_at","nudge_fingerprint","nudge_repeats"].includes(n));
const where = `WHERE archived = 0 AND (parent_task_id IS NULL OR (status != 'done' AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id = tasks.parent_task_id AND p.archived = 0 AND p.status != 'done'))) AND (status != 'done' OR id IN (SELECT id FROM tasks WHERE archived = 0 AND status = 'done' ORDER BY COALESCE(completed_at, updated_at) DESC LIMIT 120)) ORDER BY updated_at DESC`;
const sql = `SELECT ${lean.join(", ")}, substr(description, 1, 800) AS description_preview FROM tasks ${where}`;
const st = db.query(sql);
const st2 = db.query(`SELECT id FROM tasks ${where}`);
const names = [...lean, "description_preview"];
const mk = new Function("v", `return {${names.map((n, i) => `${n}: v[${i}]`).join(", ")}};`) as (v: any[]) => any;
function bench(label: string, fn: () => unknown) {
  for (let i = 0; i < 200; i++) fn();
  const xs: number[] = [];
  for (let i = 0; i < 1000; i++) { const t0 = performance.now(); fn(); xs.push(performance.now() - t0); }
  xs.sort((a, b) => a - b);
  console.log(label.padEnd(28), "p50", xs[500]!.toFixed(3), "p95", xs[950]!.toFixed(3));
}
bench("ids only", () => st2.all());
bench(".all() objects", () => st.all());
bench(".values()", () => st.values());
bench(".values() + literal mapper", () => st.values().map(mk));
console.log("lean cols", lean.length);
const loopMk = (v: any[]) => { const o: any = {}; for (let i = 0; i < names.length; i++) o[names[i]!] = v[i]; return o; };
bench(".values() + loop mapper", () => st.values().map(loopMk));
for (const n of [30, 50, 60, 63, 64, 65, 70]) {
  const s = db.query(`SELECT ${lean.slice(0, n).join(", ")} FROM tasks ${where}`);
  bench(`.all() ${n} cols`, () => s.all());
}
const r1 = st.all() as any[]; const r2 = st.values().map(mk);
console.log("same json", JSON.stringify(r1) === JSON.stringify(r2), "same keys order", JSON.stringify(Object.keys(r1[0])) === JSON.stringify(Object.keys(r2[0])));
