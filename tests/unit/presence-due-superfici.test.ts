/**
 * @covers PRESENCE-13
 *
 * TWO SURFACES, ONE NUMBER — the bench that was missing.
 *
 * The defect (task bbf68c9c): Discord presence said "16 open sessions" by
 * counting rows of `topics WHERE archived = 0`, which are CONTAINERS; the
 * status bar showed fleet sessions, which are PROCESSES with a pid. And the
 * Claude sessions Topics did not start appeared in neither. Neither number was
 * wrong on its own, and that is exactly why no test could catch it: each one
 * was consistent with itself.
 *
 * The cure on main is not a third counter, it is ONE source
 * (`computePresenceCounts`) read by both. That makes the guarantee STRUCTURAL,
 * and this file plants it: not "the two numbers are equal today" — that can
 * only be proved with Discord switched on — but "the two cannot diverge,
 * because they call the same function with the same inputs".
 *
 * The case that keeps it non-vacuous is the last one: it looks for the
 * DIVERGENT pattern, i.e. someone recounting open topics on their own outside
 * the source. That is how the defect would come back, and without that case
 * this file would survive its own regression.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..", "..");
const SERVER = readFileSync(join(ROOT, "server.ts"), "utf8");
const STATUS = readFileSync(join(ROOT, "server/routes/status.ts"), "utf8");

/** The call arguments, normalised: the comparison is what matters. */
function callArguments(src: string): string | null {
  const i = src.indexOf("computePresenceCounts(");
  if (i < 0) return null;
  let depth = 0;
  for (let j = i + "computePresenceCounts".length; j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")") {
      depth--;
      if (depth === 0) {
        return src
          .slice(i + "computePresenceCounts(".length, j)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "")
          .replace(/\s+/g, "")
          // `status.ts:57` destructures `{ db, activeStreams } = ctx`, `server.ts`
          // writes `ctx.db`: it is the SAME object, and a comparison that goes red
          // on that prefix would report cosmetics instead of a divergence.
          .replace(/\bctx\./g, "")
          .replace(/,$/, "");
      }
    }
  }
  return null;
}

describe("presence · due superfici, un numero", () => {
  test("la barra di stato legge computePresenceCounts", () => {
    expect(callArguments(STATUS), "la barra ha smesso di leggere la fonte comune").not.toBeNull();
  });

  test("la presenza Discord legge la STESSA funzione", () => {
    expect(callArguments(SERVER), "la presenza Discord ha smesso di leggere la fonte comune").not.toBeNull();
  });

  test("IL PATTO: le due superfici passano gli STESSI ingressi", () => {
    expect(callArguments(SERVER)).toBe(callArguments(STATUS)!);
  });

  test("il pattern DIVERGENTE non e' tornato: nessuno riconta i topic aperti fuori dalla fonte", () => {
    // `archived = 0` on `topics` was the Discord presence count, and it is the
    // exact shape the defect would come back in. It lives ONCE, in
    // `profile-stats.ts`, which IS the source.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith(".ts") || p.includes(".test.")) continue;
        const src = readFileSync(p, "utf8");
        // COUNTS, not "reads". The first version looked for any
        // `FROM topics ... archived = 0` and caught
        // `ui-state-orphan-cleanup.ts`, which selects ids in order to clean
        // up: that is not a second counter, and a gate that calls it one
        // teaches people to ignore it.
        if (/COUNT\([\s\S]{0,40}?FROM\s+topics\b[\s\S]{0,120}?archived\s*=\s*0/i.test(src)) {
          offenders.push(p.slice(ROOT.length + 1));
        }
      }
    };
    walk(join(ROOT, "server"));
    expect(
      offenders,
      "un secondo conteggio dei topic aperti: e' la forma in cui le due superfici tornano a divergere",
    ).toEqual(["server/services/profile-stats.ts"]);
  });
});
