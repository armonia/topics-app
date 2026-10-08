import { Database } from "bun:sqlite";
const db = new Database(":memory:");
for (const n of [62, 63]) {
  db.run(`DROP TABLE IF EXISTS t`);
  db.run(`CREATE TABLE t (${Array.from({ length: n }, (_, i) => `c${i} TEXT`).join(", ")})`);
  const names = db.prepare("SELECT * FROM t").columnNames;
  console.log(Bun.version, n, names.slice(0, 3).join(","), "...", names.at(-1), names.length);
}
