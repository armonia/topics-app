/**
 * THE DECISION behind a permanent "this Mac only" pin, and the one sweep that
 * applies it.
 *
 * TWO DIFFERENT QUESTIONS, not one:
 *  - WHO pinned it: the dispatcher (its mac-only branch, which writes its own
 *    `kind: "service"` comment) or a PERSON (the PATCH route, the composer
 *    checkbox, the TaskDetail toggle, all of which reach `tasks.ts`'s
 *    `update`/`create` and leave a differently worded one). Read from the
 *    comment thread, not guessed.
 *  - WHETHER THE WORK STILL NEEDS THIS MAC: `namesMacOnlyPaths` alone only
 *    catches a literal path (`~/`, `/Users/`, `launchd`...), and misses a card
 *    that touches the Mac through a NAME rather than a path: the tray icon,
 *    the local hub port, a launchd agent described in prose. `MAC_ONLY_WORK`
 *    below is deliberately broader for that reason. It is not the dispatcher's
 *    own eligibility gate, which stays narrow on purpose (a false keep there
 *    strands a card that would have run fine elsewhere; a false keep here just
 *    leaves a pin standing one pass longer).
 *
 * The classifier lives HERE, and `scripts/stay-local-audit.ts` imports it, so
 * the audit and the sweep can never disagree about a card.
 *
 * The sweep writes: it clears the pin and leaves ONE service comment saying
 * why, in the language of the board. A kept pin gets nothing written at all,
 * because ~60 cards do not need a comment that says "unchanged".
 *
 * IDEMPOTENT, twice over: a cleared card no longer matches the query, and a
 * card that already carries the sweep's own reason comment is skipped even if
 * somebody pinned it again afterwards. Re-pinning by hand is a person's call,
 * and the sweep must not undo it on the next boot.
 */
import { namesMacOnlyPaths } from "./dispatch-overflow";

export type StayLocalVerdict = "KEEP" | "DROP";
export type StayLocalOrigin = "dispatcher" | "person" | "unknown";

/** What the sweep decides for one card, plus the line it would write. */
export interface StayLocalDecision {
  verdict: "keep" | "clear";
  reason: string;
}

/**
 * Names this Mac's own FEATURES, not just its paths: the tray icon, the local
 * hub port, a launchd agent described in words rather than a path. Broader
 * than `namesMacOnlyPaths` on purpose (see the module doc above).
 */
const MAC_ONLY_WORK = /\btray\b|\bmenu ?bar\b|\bsystray\b|\bhub\b|:3360\b|\blaunchd\b|\blaunchagents\b|\blaunchctl\b|\bdock\b|\bkeychain\b|\bfinder\b/i;

/** The classifier alone, with no DB/IO: does EITHER check say the permanent
 *  pin still answers to a reason that touches this Mac itself? */
export function classifyStayLocal(task: { text?: string | null; description?: string | null }): StayLocalVerdict {
  if (namesMacOnlyPaths(task)) return "KEEP";
  const haystack = `${task.text ?? ""}\n${task.description ?? ""}`;
  return MAC_ONLY_WORK.test(haystack) ? "KEEP" : "DROP";
}

/**
 * The dispatcher's own permanent pin writes a `kind: "service"` comment naming
 * a mac-only path (the dispatcher marker below). Every OTHER permanent pin,
 * set by a person through the PATCH route, the composer checkbox or the
 * TaskDetail toggle, reaches `tasks.ts`'s `update`/`create`, which writes the
 * person-marker prefix below. A row with NEITHER predates both write paths:
 * `"unknown"`, not a guess either way.
 */
export function classifyOrigin(comments: { kind?: string | null; content: string }[]): StayLocalOrigin {
  const service = comments.filter((c) => c.kind === "service");
  if (service.some((c) => c.content.includes("usa file che stanno solo su questo Mac"))) return "dispatcher";
  if (service.some((c) => c.content.startsWith("«Solo Mac», senza scadenza:"))) return "person";
  return "unknown";
}

/**
 * The opening of the line the sweep writes when it clears a pin. Also the
 * marker that makes a second pass skip the card: a card carrying this already
 * had its decision, whatever its pin says today.
 */
export const STAY_LOCAL_CLEARED_PREFIX = "Pin «solo Mac» tolto:"; // allow-italian: user-facing board comment

/** How the reason line names whoever set the pin. */
function originPhrase(origin: StayLocalOrigin): string {
  if (origin === "dispatcher") return "pin messo dal dispatcher"; // allow-italian: user-facing board comment
  if (origin === "person") return "pin messo da una persona"; // allow-italian: user-facing board comment
  return "non si sa chi abbia messo il pin"; // allow-italian: user-facing board comment
}

/**
 * The whole decision for one card: keep the permanent pin, or clear it, and
 * the single line that says why in the language of the board.
 */
export function decideStayLocal(
  task: { id?: string; text?: string | null; description?: string | null },
  comments: { kind?: string | null; content: string }[],
): StayLocalDecision {
  const origin = originPhrase(classifyOrigin(comments));
  if (classifyStayLocal(task) === "KEEP") {
    return {
      verdict: "keep",
      reason: `Pin «solo Mac» tenuto: il testo nomina qualcosa che sta solo su questo Mac (${origin}).`, // allow-italian: user-facing board comment
    };
  }
  return {
    verdict: "clear",
    reason: `${STAY_LOCAL_CLEARED_PREFIX} il testo non nomina niente che stia solo su questo Mac (${origin}). Rimettilo con un clic se serve.`, // allow-italian: user-facing board comment
  };
}

/** The slice of `bun:sqlite` the sweep needs, so a test can hand it anything. */
export interface StayLocalSweepDb {
  query(sql: string): { all(...args: unknown[]): unknown[] };
  run(sql: string, params?: unknown[]): unknown;
}

/** One pass of the sweep, counted. */
export interface StayLocalSweepResult {
  scanned: number;
  kept: number;
  cleared: number;
  /** Already decided by an earlier pass: carries the reason comment already. */
  skipped: number;
}

/** The permanent pins: no expiry means nothing will ever lift them. */
export const PERMANENT_PINS_SQL =
  "SELECT id, text, description FROM tasks WHERE stay_local = 1 AND stay_local_until IS NULL";

/**
 * Applies `decideStayLocal` to every permanent pin on `db`.
 *
 * Pure with respect to the rest of the server: no broadcast, no service
 * layer, no clock of its own (`now`/`generateId` are injected so a test is
 * deterministic, same as `runBootPartialSweep`).
 */
export function runStayLocalSweep(
  db: StayLocalSweepDb,
  opts: { generateId?: () => string; now?: () => string } = {},
): StayLocalSweepResult {
  const generateId = opts.generateId ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => new Date().toISOString());

  const rows = db.query(PERMANENT_PINS_SQL).all() as {
    id: string;
    text: string | null;
    description: string | null;
  }[];

  const result: StayLocalSweepResult = { scanned: rows.length, kept: 0, cleared: 0, skipped: 0 };

  for (const row of rows) {
    const comments = db
      .query("SELECT kind, content FROM task_comments WHERE task_id = ? ORDER BY created_at ASC")
      .all(row.id) as { kind: string | null; content: string }[];

    if (comments.some((c) => c.content.startsWith(STAY_LOCAL_CLEARED_PREFIX))) {
      result.skipped += 1;
      continue;
    }

    const decision = decideStayLocal(row, comments);
    if (decision.verdict === "keep") {
      result.kept += 1;
      continue;
    }

    const stamp = now();
    db.run(
      "UPDATE tasks SET stay_local = 0, updated_at = ? WHERE id = ? AND stay_local = 1 AND stay_local_until IS NULL",
      [stamp, row.id],
    );
    db.run(
      "INSERT INTO task_comments (id, task_id, author, content, created_at, kind) VALUES (?, ?, 'system', ?, ?, 'service')",
      [generateId(), row.id, decision.reason, stamp],
    );
    result.cleared += 1;
  }

  return result;
}
