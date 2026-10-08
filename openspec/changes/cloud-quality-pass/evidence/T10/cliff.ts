import { Database } from "bun:sqlite";
const db = new Database(":memory:");
const N = 80;
db.run(`CREATE TABLE t (${Array.from({ length: N }, (_, i) => `c${i} TEXT`).join(", ")})`);
const ins = db.query(`INSERT INTO t VALUES (${Array.from({ length: N }, () => "?").join(",")})`);
for (let r = 0; r < 150; r++) ins.run(...Array.from({ length: N }, (_, i) => `v${r}_${i}`));
for (const n of [58, 59, 60, 61, 62, 63, 64]) {
  const s = db.query(`SELECT ${Array.from({ length: n }, (_, i) => `c${i}`).join(", ")} FROM t`);
  for (let i = 0; i < 100; i++) s.all();
  const xs: number[] = [];
  for (let i = 0; i < 500; i++) { const t0 = performance.now(); s.all(); xs.push(performance.now() - t0); }
  xs.sort((a, b) => a - b);
  console.log(n, xs[250]!.toFixed(3));
}
{
  const s = db.query(`SELECT ${Array.from({ length: 75 }, (_, i) => `c${i}`).join(", ")} FROM t`);
  class Row {}
  const sa = s.as(Row);
  for (const [label, fn] of [["all75", () => s.all()], ["as75", () => sa.all()], ["values75", () => s.values()]] as const) {
    for (let i = 0; i < 100; i++) fn();
    const xs: number[] = [];
    for (let i = 0; i < 500; i++) { const t0 = performance.now(); fn(); xs.push(performance.now() - t0); }
    xs.sort((a, b) => a - b);
    console.log(label, xs[250]!.toFixed(3));
  }
}
