/**
 * WHAT DOES THE DELIVERY-REPORT GATE ACCUSE, AND HOW OFTEN IS IT WRONG.
 *
 * `deliveryReportChecks.ts` answers "does the evidence this report cites
 * EXIST". Whether that answer is worth acting on is a different question, and
 * it has exactly one honest form: run the checks over the delivery reports this
 * board has actually produced, and split them by a control group whose work is
 * independently known to be real.
 *
 * The control group is `landing_state='landed'`: the card's commits were
 * verified present in main. A check that accuses those at the same rate as the
 * rest measures nothing; a check that accuses them MORE is anti-correlated with
 * the defect and must never be promoted to a block.
 *
 * WHY THIS IS A FILE AND NOT A PASTE IN A THREAD. The measurement that decides
 * whether a check blocks a delivery has to be re-runnable by whoever doubts it,
 * on the day they doubt it. It was run twice by hand before this script
 * existed, and the two runs disagreed - the first read the WHOLE thread where
 * the gate reads the last few lines of the current turn, and the posture alone
 * flipped the verdict on one of the four checks.
 *
 * THE TWO POSTURES, and the difference is the whole point:
 *   - `review`  - what `annotateDeliveryClaims` reads today: the last 3 agent
 *                 comments written since the turn entered `in_progress`.
 *   - `thread`  - every agent comment on the card, oldest to newest.
 * A claim that is false in the thread but outside the review window is one the
 * gate does not see. That gap is a number, and this prints it.
 *
 * Read-only, on a copy or on the live file: it opens the database `readonly`
 * and runs `git` read verbs only.
 *
 * Run:
 *   bun run scripts/delivery-claims-audit.ts --db <path/to/topics.db>
 *   bun run scripts/delivery-claims-audit.ts --code migration-belongs-elsewhere --list
 *   bun run scripts/delivery-claims-audit.ts --json
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { statusEventEnters } from "../shared/board";
import { checkReport, type Finding, type RepoProbe } from "../server/services/deliveryReportChecks";
import { repoProbe } from "../server/services/deliveryReportProbe";

/** Posture: which slice of the thread the checks are fed. */
export type Posture = "review" | "thread";

/** One card's agent speech, oldest first, with the turn boundary resolved. */
export interface CardReports {
  taskId: string;
  text: string;
  landed: boolean;
  /** Every agent comment, oldest first. */
  all: string[];
  /** The last 3 agent comments of the current turn: what the gate reads. */
  window: string[];
}

/** Counts for one check code, per group. */
export interface CodeTally {
  code: string;
  landed: number;
  rest: number;
}

export interface AuditResult {
  posture: Posture;
  totals: { landed: number; rest: number };
  codes: CodeTally[];
  /** taskId -> the codes it was accused of, for `--list`. */
  accused: Map<string, { landed: boolean; text: string; codes: string[] }>;
}

const CODES = [
  "sha-missing",
  "migration-missing",
  "migration-belongs-elsewhere",
  "file-missing",
  "line-lacks-symbol",
  "symbol-never-written",
] as const;

/**
 * The turn boundary, read the same way the service reads it: the newest status
 * comment that ENTERS `in_progress`. `null` means the card never had one, and
 * then the whole thread is the current turn.
 */
function lastTurnStart(rows: Array<{ kind: string; content: string; created_at: string }>): string | null {
  let latest: string | null = null;
  for (const r of rows) {
    if (r.kind !== "status") continue;
    if (!statusEventEnters(r.content, "in_progress")) continue;
    if (latest === null || r.created_at > latest) latest = r.created_at;
  }
  return latest;
}

/** Load every card that has at least one agent comment. */
export function loadCards(dbPath: string): CardReports[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tasks = db
      .query<{ id: string; text: string; landing_state: string | null }, []>(
        "SELECT id, text, landing_state FROM tasks",
      )
      .all();
    const comments = db
      .query<{ task_id: string; kind: string; content: string; created_at: string }, []>(
        `SELECT task_id, kind, content, created_at FROM task_comments
          WHERE author NOT IN ('user', 'system')
          ORDER BY created_at ASC`,
      )
      .all();
    const byTask = new Map<string, Array<{ kind: string; content: string; created_at: string }>>();
    for (const c of comments) {
      const list = byTask.get(c.task_id);
      if (list) list.push(c);
      else byTask.set(c.task_id, [c]);
    }
    const out: CardReports[] = [];
    for (const t of tasks) {
      const rows = byTask.get(t.id);
      if (!rows) continue;
      const speech = rows.filter((r) => r.kind === "comment");
      if (speech.length === 0) continue;
      const start = lastTurnStart(rows);
      const inTurn = start === null ? speech : speech.filter((r) => r.created_at >= start);
      out.push({
        taskId: t.id,
        text: t.text,
        landed: t.landing_state === "landed",
        all: speech.map((r) => r.content),
        // The service takes the 3 NEWEST of the turn.
        window: inTurn.slice(-3).map((r) => r.content),
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Run the checks over every card in one posture.
 *
 * The probe is a parameter and defaults to the real repository one: the count
 * this script prints is only worth reading when it comes from real git, but the
 * counting itself is what a test can pin down, and it must not depend on the
 * history of the day it runs.
 */
export function audit(
  cards: readonly CardReports[],
  posture: Posture,
  probe: RepoProbe = repoProbe,
): AuditResult {
  const tally = new Map<string, CodeTally>();
  for (const code of CODES) tally.set(code, { code, landed: 0, rest: 0 });
  const accused = new Map<string, { landed: boolean; text: string; codes: string[] }>();
  let landedTotal = 0;
  let restTotal = 0;

  for (const card of cards) {
    const reports = posture === "review" ? card.window : card.all;
    if (reports.length === 0) continue;
    if (card.landed) landedTotal++;
    else restTotal++;
    const findings: Finding[] = reports.flatMap((r) => checkReport(r, probe));
    // One card counts ONCE per code, however many times the code fired: the
    // question is "would this card have been stopped", not "how loud was it".
    const codes = [...new Set(findings.map((f) => f.code))].filter((c) => c !== "nothing-to-check");
    if (codes.length === 0) continue;
    accused.set(card.taskId, { landed: card.landed, text: card.text, codes });
    for (const c of codes) {
      const row = tally.get(c);
      if (!row) continue;
      if (card.landed) row.landed++;
      else row.rest++;
    }
  }

  return {
    posture,
    totals: { landed: landedTotal, rest: restTotal },
    codes: [...tally.values()],
    accused,
  };
}

function pct(n: number, total: number): string {
  if (total === 0) return "-";
  return `${Math.round((n / total) * 100)}%`;
}

function render(r: AuditResult): string {
  const lines: string[] = [];
  lines.push(`posa ${r.posture} - ${r.totals.landed} atterrate, ${r.totals.rest} resto`); // allow-italian: output of an Italian-facing report
  lines.push("controllo                      atterrate        resto"); // allow-italian: idem
  for (const c of r.codes) {
    const a = `${c.landed} (${pct(c.landed, r.totals.landed)})`;
    const b = `${c.rest} (${pct(c.rest, r.totals.rest)})`;
    lines.push(`${c.code.padEnd(30)} ${a.padEnd(16)} ${b}`);
  }
  return lines.join("\n");
}

export function defaultDbPath(): string {
  return process.env.DATA_DIR
    ? join(process.env.DATA_DIR, "topics.db")
    : join(import.meta.dir, "..", "data", "topics.db");
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dbPath = flag("--db") ?? defaultDbPath();
  if (!existsSync(dbPath)) {
    console.error(`nessun database in ${dbPath} - passa --db <path>`); // allow-italian: operator-facing message of an Italian-facing script
    process.exit(2);
  }
  const only = flag("--code");
  const list = argv.includes("--list");

  const cards = loadCards(dbPath);
  const results = (["review", "thread"] as const).map((p) => audit(cards, p));

  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        results.map((r) => ({
          posture: r.posture,
          totals: r.totals,
          codes: r.codes,
          accused: [...r.accused].map(([id, v]) => ({ id, ...v })),
        })),
        null,
        2,
      ),
    );
    return;
  }

  for (const r of results) {
    console.log(render(r));
    if (only) {
      const hits = [...r.accused].filter(([, v]) => v.codes.includes(only));
      console.log(`  ${only}: ${hits.length}`);
      if (list) {
        for (const [id, v] of hits) {
          console.log(`  - ${id.slice(0, 8)} ${v.landed ? "[ATTERRATA]" : "[resto]"} ${v.text.slice(0, 70)}`); // allow-italian: idem
        }
      }
    }
    console.log("");
  }
}

if (import.meta.main) main();
