/**
 * Reading back a JSON state file that `writeFileAtomic` wrote.
 *
 * `null` when there is no file (the normal first start) or when it cannot be
 * used. A file that does not parse, or parses to something that is not an
 * object, is logged and moved aside to `<file>.corrupt-<epochMs>`: dropping it
 * inside a bare `catch {}` lost what it held without a trace, and the first
 * save of the new run overwrote the only evidence (SRV-06, `scripts.json`).
 */
import { existsSync, readFileSync, renameSync } from "node:fs";

export function readJsonStateFile(file: string, label: string): object | null {
  let raw: string;
  try {
    if (!existsSync(file)) return null;
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    console.error(`[${label}] cannot read ${file}; starting empty:`, err);
    return null;
  }
  let problem: unknown = null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
    if (data === null || typeof data !== "object") problem = `not an object (${raw.length} bytes)`;
  } catch (err) {
    problem = err;
  }
  if (problem === null) return data as object;
  const aside = `${file}.corrupt-${Date.now()}`;
  let moved = true;
  try { renameSync(file, aside); } catch { moved = false; }
  console.error(
    `[${label}] ${file} is unreadable (${raw.length} bytes); what it held is lost.`
      + (moved ? ` Kept as ${aside}.` : " Could not move it aside."),
    problem,
  );
  return null;
}
