/**
 * Backlog triage: twice a day, on every board that switched it on, a cheap
 * model sorts each backlog card into one of four outcomes.
 *
 *  - `todo`: an agent can do it with no decision from a person, no open card
 *    blocks it, and it still applies. Moving it costs nothing by itself: the
 *    dispatcher's own brakes (spend cap, memory brake) decide when it runs.
 *  - `ask`: it needs a person (spend, anything public, anything irreversible,
 *    real people's data, visual taste). The card goes to `review` with the
 *    question and the options, where a person reads it, not buried in a thread.
 *  - `done`: it was already done. It closes ONLY with a proof (a commit that is
 *    on the main branch, or the id of a finished card) that the code found AND
 *    a second model confirmed. Without both, the card stays.
 *  - `stay`: blocked, or an idea that is not ready, with the reason in a line.
 *
 * Off by default (`board_settings.backlog_triage`). Nothing here names a person,
 * a machine or a path: the repo path of a board comes from its project row.
 */
import type { Database } from "bun:sqlite";
import { spawnSync } from "child_process";
import type { TaskService } from "./tasks";
import { tryGetProvider } from "../providers";
import type { CompletionOptions } from "../providers/types";

const BATCH_SIZE = 10;
const MAX_CARDS_PER_BOARD = 80;
const MODEL_TIMEOUT_MS = 120_000;
const CHECK_EVERY_MS = 10 * 60_000;
/** The two slots of the day, as local hours. */
const TRIAGE_HOURS = [7, 19] as const;
/** The cheap tier for the sorting; the check of a proof asks the provider's own default, a different model. */
const CHEAP_MODEL: Record<string, string> = { "claude-code": "claude-haiku-4-5" };

type TriageAction = "todo" | "ask" | "done" | "stay";
type Tier = "triage" | "verify";

export interface TriageVerdict {
  id: string;
  action: TriageAction;
  /** One line: why the card goes where it goes. */
  reason: string;
  /** `ask`: the question for the person and the options, the recommended one first. */
  question?: string;
  options?: string[];
  /** `done`: `commit:<sha>` or `card:<id>`. */
  proof?: string;
}

interface TriageCard {
  id: string;
  text: string;
  description: string | null;
  createdAt: string;
  blockedBy: string | null;
  /** A step of another card: nobody dispatches it from the backlog, so it has to be detached before it can move. */
  parentTaskId: string | null;
  /** The parent's state: `done`, `archived` or a live status. Null for a card with no parent. */
  parentState: string | null;
}

export interface TriageReport { todo: number; ask: number; done: number; stay: number }

export interface TriageDeps {
  now?: () => number;
  /** One model call: `triage` is the cheap tier, `verify` the provider's own default. Throws when no model answers. */
  ask?: (prompt: string, tier: Tier) => Promise<string>;
  /** Is this commit reachable from the main branch of the board's repo? */
  commitOnMain?: (boardId: string, sha: string) => boolean;
  /**
   * Is there a model different from the sorting one to check a proof? Without it no card closes.
   * Defaults to what the connected provider can do; true when `ask` is injected.
   */
  hasSecondModel?: () => boolean;
}

type Svc = Pick<TaskService, "update" | "addComment">;

const BY = "backlog-triage";

/** True when the connected provider has a cheap tier, so the check of a proof (its default) is a different model. */
function providerHasSecondModel(getProvider: typeof tryGetProvider = tryGetProvider): boolean {
  const name = getProvider()?.name;
  return !!name && name in CHEAP_MODEL;
}

/** The JSON array a model answered, tolerant of a fence around it; anything else is no verdict. */
export function parseVerdicts(answer: string): TriageVerdict[] {
  const text = answer.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  let raw: unknown;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: TriageVerdict[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r.id !== "string" || !["todo", "ask", "done", "stay"].includes(String(r.action))) continue;
    out.push({
      id: r.id, action: r.action as TriageAction, reason: String(r.reason ?? "").slice(0, 240),
      question: typeof r.question === "string" ? r.question : undefined,
      options: Array.isArray(r.options) ? r.options.map(String).filter(Boolean) : undefined,
      proof: typeof r.proof === "string" ? r.proof.trim() : undefined,
    });
  }
  return out;
}

function buildTriagePrompt(cards: TriageCard[]): string {
  const lines = cards.map((c) => `- id ${c.id} | created ${c.createdAt.slice(0, 10)} | ${c.blockedBy ? `blocked by open card ${c.blockedBy} | ` : ""}${c.parentTaskId ? "subtask | " : ""}${c.text}${c.description ? ` :: ${c.description.slice(0, 500).replace(/\s+/g, " ")}` : ""}`);
  return [
    "You sort the backlog cards of a task board. For EACH card below answer with one JSON object; reply with ONE JSON array and nothing else.",
    'Fields: {"id": string, "action": "todo"|"ask"|"done"|"stay", "reason": one line, "question": string, "options": string[], "proof": string}.',
    "- todo: an agent can do it with no decision from a person, no open card blocks it, and it still applies today.",
    "- ask: it needs a person (spend, anything public, anything irreversible, real people's data, visual taste). Give `question` (one line) and `options` (2 to 4, the recommended first).",
    "- done: it was already done. `proof` is REQUIRED: `commit:<sha>` of a commit on the main branch or `card:<id>` of the finished card that did it. No proof you can name means stay, not done.",
    "- A card whose blocker is already done is NOT blocked: it does not wake up by itself, so it is todo like any other workable card. A subtask is sorted like any card.",
    "- stay: blocked by an open card, or an idea that is not ready. `reason` says which.",
    "",
    ...lines,
  ].join("\n");
}

/** The ask of the live server: the connected provider, the cheap model for sorting, its default for the check. */
function makeTriageAsk(getProvider: typeof tryGetProvider = tryGetProvider) {
  return async (prompt: string, tier: Tier): Promise<string> => {
    const provider = getProvider();
    if (!provider?.connected) throw new Error("no model connected");
    const options: CompletionOptions = { timeoutMs: MODEL_TIMEOUT_MS, isolated: true, purpose: "backlog-triage" };
    const cheap = CHEAP_MODEL[provider.name];
    if (tier === "triage" && cheap) options.model = cheap;
    const out = await provider.complete([{ role: "user", content: prompt }], options);
    return out.content ?? "";
  };
}

function defaultCommitOnMain(db: Database): NonNullable<TriageDeps["commitOnMain"]> {
  return (boardId, sha) => {
    const row = db.query("SELECT path FROM projects WHERE id = ?").get(boardId) as { path: string | null } | null;
    if (!row?.path || !/^[0-9a-f]{7,40}$/i.test(sha)) return false;
    return spawnSync("git", ["merge-base", "--is-ancestor", sha, "main"], { cwd: row.path, timeout: 10_000 }).status === 0;
  };
}

/** The card a `card:<id>` proof names: finished, on the same board, and not the card being closed. */
function finishedCard(db: Database, boardId: string, ref: string, selfId: string): { id: string; text: string } | null {
  if (!/^[A-Za-z0-9-]{4,36}$/.test(ref)) return null;
  const rows = db.query("SELECT id, text FROM tasks WHERE project_id = ? AND status = 'done' AND id LIKE ? AND id != ? LIMIT 2").all(boardId, `${ref}%`, selfId) as { id: string; text: string }[];
  return rows.length === 1 ? rows[0]! : null;
}

/**
 * The proof of a `done` verdict. TWO checks, and both must pass: the code finds the proof (the commit is on
 * main, the card is finished), then a second model, asked without the first one's reasoning, says whether
 * that proof really covers the card. A card that fails either stays in the backlog.
 */
async function proofHolds(db: Database, boardId: string, card: TriageCard, v: TriageVerdict, deps: Required<Pick<TriageDeps, "ask" | "commitOnMain" | "hasSecondModel">>): Promise<boolean> {
  // The same model for sorting and checking is no second opinion: no proof holds.
  if (!deps.hasSecondModel()) return false;
  const m = /^(commit|card):(\S+)$/.exec(v.proof ?? "");
  if (!m) return false;
  let evidence: string;
  if (m[1] === "commit") {
    if (!deps.commitOnMain(boardId, m[2]!)) return false;
    evidence = `commit ${m[2]} is on the main branch`;
  } else {
    const done = finishedCard(db, boardId, m[2]!, card.id);
    if (!done) return false;
    evidence = `card "${done.text}" is finished`;
  }
  const answer = await deps.ask(
    `A backlog card says:\n${card.text}${card.description ? `\n${card.description.slice(0, 800)}` : ""}\n\nProof offered that it is already done: ${evidence}.\nDoes this proof really cover the whole card? Answer with YES or NO on the first line.`,
    "verify",
  );
  return /^\s*yes\b/i.test(answer);
}

function apply(db: Database, svc: Svc, taskId: string, parentTaskId: string | null, action: TriageAction, reason: string, v: TriageVerdict): void {
  if (action === "todo") {
    // A subtask in the backlog is a dead end: detach it in its own update, then move it, as two separate patches.
    if (parentTaskId) svc.update({ taskId, actor: "agent", by: BY, patch: { parentTaskId: null }, statusReason: "detached from its parent so an agent can take it" });
    svc.update({ taskId, actor: "agent", by: BY, patch: { status: "todo" }, statusReason: reason || "workable by an agent" });
  } else if (action === "ask") {
    // The question goes to the thread once, with its options, and the card is handed over with the system
    // signature, not through the agent delivery gate: no summary, no approval row, no "unreadable delivery" warning.
    svc.addComment({ taskId, author: BY, content: v.question!, questionOptions: v.options });
    const ts = new Date().toISOString();
    db.query(
      "UPDATE tasks SET status = 'review', dispatch_state = 'needs_input', review_at = ?, human_ask = ?, " +
        "delivered_by = 'system', delivered_reason = 'backlog_triage', updated_at = ? WHERE id = ? AND status = 'backlog'",
    ).run(ts, v.question!, ts, taskId);
  } else if (action === "done") {
    // The rule that only a human closes a card is met by the verified proof, not skipped: the proof is in the comment.
    svc.addComment({ taskId, author: BY, kind: "service", content: `Already done. Proof: ${v.proof}. ${reason}` });
    svc.update({ taskId, actor: "human", by: BY, patch: { status: "done" }, statusReason: "already done, proof verified" });
  } else {
    svc.addComment({ taskId, author: BY, kind: "service", once: true, content: `Stays in the backlog: ${reason || "not ready"}` });
  }
}

/** Sorts one board's backlog. Returns what moved; a model that cannot be asked leaves the cards where they are. */
export async function triageBoard(db: Database, svc: Svc, boardId: string, deps: TriageDeps = {}): Promise<TriageReport> {
  const ask = deps.ask ?? makeTriageAsk();
  const commitOnMain = deps.commitOnMain ?? defaultCommitOnMain(db);
  const hasSecondModel = deps.hasSecondModel ?? (deps.ask ? () => true : () => providerHasSecondModel());
  const report: TriageReport = { todo: 0, ask: 0, done: 0, stay: 0 };
  const rows = db.query(
    `SELECT t.id, t.text, t.description, t.created_at AS createdAt,
            (SELECT b.id FROM tasks b WHERE b.id = t.blocked_by_task_id AND b.status != 'done' AND b.archived = 0) AS blockedBy, t.parent_task_id AS parentTaskId,
            (SELECT CASE WHEN p.archived = 1 THEN 'archived' ELSE p.status END FROM tasks p WHERE p.id = t.parent_task_id) AS parentState
       FROM tasks t WHERE t.project_id = ? AND t.status = 'backlog' AND t.archived = 0
      ORDER BY t.created_at ASC LIMIT ?`,
  ).all(boardId, MAX_CARDS_PER_BOARD) as TriageCard[];

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const byId = new Map(batch.map((c) => [c.id, c]));
    let verdicts: TriageVerdict[];
    try { verdicts = parseVerdicts(await ask(buildTriagePrompt(batch), "triage")); } catch { continue; }
    for (const v of verdicts) {
      const card = byId.get(v.id);
      if (!card) continue;
      try {
        let action = v.action;
        let reason = v.reason;
        // A blocker still open is a fact of the database, not something the model may overrule.
        if (action === "todo" && card.blockedBy) { action = "stay"; reason = `blocked by an open card (${card.blockedBy.slice(0, 8)})`; }
        // Detaching a step from a live parent would make it a root card the dispatcher launches while the parent works on it.
        if (action === "todo" && card.parentTaskId && card.parentState !== "done" && card.parentState !== "archived") {
          action = "stay"; reason = "subtask of a live parent";
        }
        if (action === "done" && !(await proofHolds(db, boardId, card, v, { ask, commitOnMain, hasSecondModel }))) {
          action = "stay"; reason = "looks done but no verified proof";
        }
        if (action === "ask" && !(v.question && v.options?.length)) { action = "stay"; reason = reason || "needs a person but no question was written"; }
        apply(db, svc, card.id, card.parentTaskId, action, reason, v);
        report[action]++;
      } catch (e) {
        console.warn("[backlog-triage] card skipped:", card.id, e instanceof Error ? e.message : e);
      }
    }
  }
  return report;
}

/** The half-day slot `ms` falls in (`YYYY-MM-DD@HH`), or null before the first slot of the day. */
function slotKey(ms: number): string | null {
  const d = new Date(ms);
  const hour = [...TRIAGE_HOURS].reverse().find((h) => d.getHours() >= h);
  if (hour === undefined) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}@${String(hour).padStart(2, "0")}`;
}

/** One round: every board that switched it on and has not been sorted in the current slot. */
export async function runBacklogTriage(db: Database, svc: Svc, deps: TriageDeps = {}): Promise<Record<string, TriageReport>> {
  const now = (deps.now ?? Date.now)();
  const slot = slotKey(now);
  const out: Record<string, TriageReport> = {};
  if (!slot) return out;
  const boards = db.query("SELECT project_id AS id FROM board_settings WHERE backlog_triage = 1").all() as { id: string }[];
  for (const { id } of boards) {
    const claimed = db.query("INSERT OR IGNORE INTO backlog_triage_runs (board_id, slot, at) VALUES (?, ?, ?)").run(id, slot, new Date(now).toISOString()).changes > 0;
    if (!claimed) continue;
    const report = await triageBoard(db, svc, id, deps);
    db.query("UPDATE backlog_triage_runs SET summary = ? WHERE board_id = ? AND slot = ?").run(JSON.stringify(report), id, slot);
    out[id] = report;
  }
  return out;
}

/** Boot: look every 10 minutes whether a slot is due. A failure is logged and never reaches anything else. */
export function startBacklogTriage(db: Database, svc: Svc): void {
  const safeRun = () => void runBacklogTriage(db, svc).catch((e) => console.warn("[backlog-triage] round failed:", e instanceof Error ? e.message : e));
  setTimeout(() => {
    safeRun();
    setInterval(safeRun, CHECK_EVERY_MS).unref?.();
  }, 90_000).unref?.();
}
