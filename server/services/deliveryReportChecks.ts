/**
 * FOUR MECHANICAL CHECKS ON A DELIVERY REPORT, none of which needs judgement.
 *
 * WHAT PRODUCED THIS FILE. An audit of every reachable `done` task of
 * topics-app (125 `unverifiable`, 14 with a branch and a null landing state,
 * 193 root cards) found 14 cards closed with no work behind them. That is not
 * an error rate, it is a signature, and it repeats identically:
 *
 *   - a migration "renumbered onto a free slot" that is occupied by a
 *     different feature, while the claimed migration never existed;
 *   - a delivery commit that answers `fatal: bad object`;
 *   - an INDEPENDENT verification confirming, in detail, something that is not
 *     there ("VERIFICA INDIPENDENTE OK - commit 60a4f445+cffc7a13 ... migration // allow-italian: verbatim quote of the report under audit
 *     renumbered 055"; both shas are bad objects and 055 belongs to another
 *     feature).
 *
 * The cause is not "the agent did not work". It is that nothing anywhere in the
 * flow OPENS A FILE TO LOOK. The human rejection on `ddac566a` was competent
 * and caught two real defects - and then accepted the re-delivery on its word.
 *
 * WHY THESE FOUR AND NOT A RUBRIC. Each one names a specific failure that was
 * actually observed, each answers in milliseconds, and none of them has an
 * opinion. A checklist that asks whether the work is "complete" or "well
 * tested" would have passed all 14, because all 14 said so.
 *
 * WHAT IT DELIBERATELY CANNOT DO. It cannot tell whether the code is any good,
 * whether the tests are meaningful, or whether the card was understood. It
 * answers one question: does the evidence the report cites EXIST. A report
 * that cites nothing verifiable is reported as exactly that rather than
 * passed - "nothing to check" is not the same as "checked and fine", and
 * treating them alike is how a gate becomes decoration.
 */

/** A claim in the report that can be looked up. */
export type Claim =
  | { kind: "sha"; value: string }
  | { kind: "migrazione"; number: string }
  | { kind: "file"; path: string; line?: number }
  | { kind: "simbolo"; name: string };

export type Finding = {
  /** Stable key, so a caller can act on the kind rather than the prose. */
  code:
    | "sha-missing"
    | "migration-missing"
    | "migration-belongs-elsewhere"
    | "file-missing"
    | "line-lacks-symbol"
    | "symbol-never-written"
    | "nothing-to-check";
  detail: string;
};

/** Everything this module needs from the repository. Injected so the checks
 *  are pure and a test bench does not need a real git history. */
export interface RepoProbe {
  /** `git cat-file -e <sha>^{commit}` */
  shaExists(sha: string): boolean;
  /** File names under `server/db/migrations`. */
  migrations(): readonly string[];
  /**
   * Does any TRACKED file match this citation, by suffix?
   *
   * NOT `existsSync(path)`, and the difference is the whole check. Reports cite
   * files the way people talk about them - `PaneTabBar.tsx`, `routes/tasks.ts`,
   * `App.tsx` - not by their path from the repository root. Resolving those
   * literally makes every one of them "missing", and measured on the 29 real
   * reports in the bench that was 20 distinct false accusations against files
   * that all exist. A gate that accuses honest work is worse than no gate: it
   * gets switched off, and then it is not there for the dishonest case either.
   */
  fileMatches(citation: string): boolean;
  /** Body of one migration, by file name. */
  readMigration(name: string): string;

  /** The text of one line, 1-based; null when the file or the line is absent. */
  readLine(path: string, line: number): string | null;
  /** `git log --all -S<simbolo>` found at least one commit. */
  symbolInHistory(name: string): boolean;
}

/** Extensions that make a backticked token a path rather than a name. */
const EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|sql|json|md|sh|rs|css|html|yml|yaml)$/;

/**
 * Words that appear inside backticks in these reports and are NOT symbols the
 * author claims to have written: shell/tool names, and the vocabulary of the
 * board itself. Without this list every report would "declare" `git`, and the
 * symbol check would fail on honest work.
 */
const NOT_SYMBOLS = new Set([
  "git", "bun", "npm", "node", "cargo", "tsc", "main", "HEAD", "review", "done",
  "backlog", "todo", "in_progress", "approve", "reject", "true", "false", "null",
]);

/**
 * Pull every checkable claim out of a free-form report.
 *
 * The corpus is Italian prose written by agents, not a schema, so the patterns
 * are matched against the shapes that actually occur in it: "commit 60a4f44",
 * "commit `6dc39750`", "60a4f445+cffc7a13", "migration 054", "migration
 * renumbered 054->055", backticked file names and backticked identifiers.
 *
 * Deliberately permissive. A missed citation costs a check that does not run;
 * a hallucinated one costs a false accusation, which is far more expensive
 * because it teaches people to ignore the gate.
 */
export function extractClaims(report: string): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<string>();
  const push = (c: Claim) => {
    const k = JSON.stringify(c);
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  };

  // "commit <sha>", "sha <sha>", and chains like "60a4f445+cffc7a13".
  for (const m of report.matchAll(/\b(?:commit|sha)s?\s+`?([0-9a-f]{7,40}(?:\s*\+\s*[0-9a-f]{7,40})*)`?/gi)) {
    for (const s of m[1]!.split(/\s*\+\s*/)) push({ kind: "sha", value: s.toLowerCase() });
  }

  /**
   * Bare shas, written with no "commit" in front of them.
   *
   * People write "il fix di fee32d7e (matchMedia)" and mean a commit. Requiring
   * the word first is a rule about prose style, not about evidence, and it cost
   * a real catch: that exact sentence cites a sha that does not resolve, and the
   * first version of this extractor walked straight past it.
   *
   * The shape has to earn it, or this turns into noise: 7-40 hex characters
   * with AT LEAST ONE DIGIT and at least one letter, so English words made of
   * a-f (`deface`, `decade`) cannot qualify, and not preceded by `#` or `0x`,
   * which are a colour and a number.
   */
  for (const m of report.matchAll(/(^|[^#\w]|0[^x])\b([0-9a-f]{7,40})\b/gi)) {
    const v = m[2]!.toLowerCase();
    if (!/[0-9]/.test(v) || !/[a-f]/.test(v)) continue;
    push({ kind: "sha", value: v });
  }

  // "migration 054", "migration renumbered 054->055" (both numbers are claims).
  for (const m of report.matchAll(/\bmigrat(?:ion|ions|ione|ioni)\b[^.\n]{0,40}?(\d{3})(?:\s*(?:->|→|-->)\s*(\d{3}))?/gi)) {
    push({ kind: "migrazione", number: m[1]! });
    if (m[2]) push({ kind: "migrazione", number: m[2] });
  }

  // `path/file.ts:123` and `path/file.ts`, backticked or bare.
  for (const m of report.matchAll(/`?\b([\w./-]+\.[a-z]{2,4})(?::(\d+))?\b`?/g)) {
    const p = m[1]!;
    if (!EXTENSIONS.test(p)) continue;
    push({ kind: "file", path: p, ...(m[2] ? { line: Number(m[2]) } : {}) });
  }

  // Backticked identifiers: what the report claims to have written.
  for (const m of report.matchAll(/`([A-Za-z_][\w]{2,})`/g)) {
    const n = m[1]!;
    if (EXTENSIONS.test(n) || NOT_SYMBOLS.has(n)) continue;
    push({ kind: "simbolo", name: n });
  }
  return out;
}

/**
 * Run the four checks. Empty result means every claim the report made checked
 * out; it does NOT mean the work is good.
 */
export function checkReport(report: string, probe: RepoProbe): Finding[] {
  const claims = extractClaims(report);
  const findings: Finding[] = [];

  const symbols = claims.filter((c) => c.kind === "simbolo").map((c) => (c as { name: string }).name);

  // 1. Every cited sha must resolve.
  for (const c of claims) {
    if (c.kind === "sha" && !probe.shaExists(c.value)) {
      findings.push({ code: "sha-missing", detail: `il commit ${c.value} non esiste in nessun ref` });
    }
  }

  // 2. Every cited migration must exist AND look like the thing described.
  //    The number alone is the check that failed: 054 and 055 both exist, as
  //    two other features, and three reports claimed them.
  const migrations = probe.migrations();
  for (const c of claims) {
    if (c.kind !== "migrazione") continue;
    const file = migrations.find((f) => f.startsWith(`${c.number}-`));
    if (!file) {
      findings.push({ code: "migration-missing", detail: `nessuna migration ${c.number}-*.sql` });
      continue;
    }
    if (symbols.length === 0) continue; // nothing to compare against: no accusation
    const body = probe.readMigration(file);
    if (!symbols.some((s) => body.includes(s))) {
      findings.push({
        code: "migration-belongs-elsewhere",
        detail:
          `${file} non nomina niente di quello che il report dice di aver scritto ` +
          `(${symbols.slice(0, 4).join(", ")}): lo slot e' occupato da un'altra feature`,
      });
    }
  }

  // 3. Every cited path must exist, and a cited line must carry a named symbol.
  for (const c of claims) {
    if (c.kind !== "file") continue;
    if (!probe.fileMatches(c.path)) {
      findings.push({ code: "file-missing", detail: `nessun file tracciato corrisponde a ${c.path}` });
      continue;
    }
    if (c.line === undefined || symbols.length === 0) continue;
    const lineText = probe.readLine(c.path, c.line);
    if (lineText !== null && !symbols.some((s) => lineText.includes(s))) {
      findings.push({
        code: "line-lacks-symbol",
        detail: `${c.path}:${c.line} non contiene nessuno dei symbols dichiarati`,
      });
    }
  }

  // 4. At least ONE declared symbol must exist somewhere in history. This is
  //    the check that catches a delivery whose branch was squashed away: the
  //    sha is gone, the files are gone, but `-S` searches every ref. A symbol
  //    written and then deleted still leaves the commit that deleted it.
  if (symbols.length > 0 && !symbols.some((s) => probe.symbolInHistory(s))) {
    findings.push({
      code: "symbol-never-written",
      detail:
        `nessuno dei ${symbols.length} symbols dichiarati (${symbols.slice(0, 4).join(", ")}) ` +
        `compare in un solo commit di tutta la storia`,
    });
  }

  // A report with nothing to check is not a report that passed. Said out loud,
  // because silence here is indistinguishable from success.
  if (claims.length === 0) {
    findings.push({
      code: "nothing-to-check",
      detail: "il report non cita nessun commit, file, migration o simbolo",
    });
  }
  return findings;
}
