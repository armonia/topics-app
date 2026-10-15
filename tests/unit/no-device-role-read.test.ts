/** Runtime authorization never queries the legacy device role. @covers GUEST-06 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..", "..");
function readsDeviceRole(source: string): boolean {
  const sqlLiterals = source.matchAll(/\b(?:query|prepare)\s*\(\s*(["'`])([\s\S]*?)\1/gs);
  for (const match of sqlLiterals) {
    const sql = match[2];
    const selectStart = sql.match(/^\s*SELECT\b/i)?.[0].length;
    if (selectStart === undefined) continue;
    let depth = 0;
    let fromIndex = -1;
    for (let i = selectStart; i < sql.length; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      else if (depth === 0 && /^FROM\s+/i.test(sql.slice(i))) {
        fromIndex = i;
        break;
      }
    }
    if (fromIndex < 0 || !/^FROM\s+devices\b/i.test(sql.slice(fromIndex))) continue;
    const columns = sql.slice(selectStart, fromIndex).trim().split(",").map((column) => column.trim());
    if (columns.some((column) => /^(?:[a-z_]\w*\.)?(?:role|\*)(?:\s+AS\s+[a-z_]\w*)?$/i.test(column))) return true;
  }
  return false;
}

describe("devices.role is not a runtime input", () => {
  it("the guard recognizes role reads and ignores writes or other role columns", () => {
    expect(readsDeviceRole('db.query("SELECT role FROM devices WHERE id = ?")')).toBe(true);
    expect(readsDeviceRole('db.query("SELECT d.role FROM devices d WHERE d.id = ?")')).toBe(true);
    expect(readsDeviceRole('db.query("SELECT * FROM devices WHERE id = ?")')).toBe(true);
    expect(readsDeviceRole('db.query("UPDATE devices SET role = ? WHERE id = ?")')).toBe(false);
    expect(readsDeviceRole('db.query("SELECT m.role FROM org_members m JOIN devices d ON d.person_id = m.person_id")')).toBe(false);
  });

  it("no production server source selects devices.role", () => {
    const files = new Glob("server/**/*.ts").scanSync({ cwd: ROOT });
    const offenders = ["server.ts", ...files]
      .filter((path) => !path.endsWith(".test.ts"))
      .filter((path) => readsDeviceRole(readFileSync(join(ROOT, path), "utf8")));
    expect(offenders).toEqual([]);
  });
});
