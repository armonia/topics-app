/**
 * THE POSTURE IS THE MEASUREMENT, and getting it wrong flips a verdict.
 *
 * `scripts/delivery-claims-audit.ts` re-runs the delivery-report checks over
 * the reports this board has actually written, to answer the only question
 * that decides whether a check may BLOCK a delivery: how often does it accuse
 * work that is independently known to be real (`landing_state='landed'`).
 *
 * That measurement was run twice by hand and the two runs disagreed. The first
 * fed the checks the WHOLE thread; the gate in `annotateDeliveryClaims` reads
 * the last 3 agent comments of the current turn. On the whole thread a card is
 * accused for a working note written days before the delivery, which the gate
 * never looks at. One check went from "1% on landed cards" to "zero false
 * positives in the entire history" on that difference alone.
 *
 * So the two postures are not a convenience flag, they are the thing under
 * test, and these are the properties that must not drift:
 *
 *   - a false claim OUTSIDE the review window is invisible to the gate and
 *     visible to the thread posture: that gap is the number the script exists
 *     to print;
 *   - a card counts ONCE per code, however loudly the code fires: the question
 *     is "would this card have been stopped", not "how many lines were wrong";
 *   - `nothing-to-check` is not an accusation.
 *
 * The probe is injected, so what these assert is the counting, not the git
 * history of the day they run.
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { RepoProbe } from "../../server/services/deliveryReportChecks";
import { audit, loadCards, type CardReports } from "../../scripts/delivery-claims-audit";

/** Everything exists, nothing is ever accused. */
const cleanProbe: RepoProbe = {
  shaExists: () => true,
  migrations: () => ["054-app-settings.sql"],
  fileMatches: () => true,
  readMigration: () => "",
  readLine: () => "x",
  symbolInHistory: () => true,
};

/** Every sha is a bad object; the rest checks out. */
const noShaProbe: RepoProbe = { ...cleanProbe, shaExists: () => false };

function card(over: Partial<CardReports>): CardReports {
  return { taskId: "t", text: "card", landed: false, all: [], window: [], ...over };
}

describe("audit", () => {
  it("sees in the thread posture the false claim the review window hides", () => {
    const old = "Appunto di lavoro: commit 60a4f445 non era quello giusto."; // allow-italian: a delivery report of this board, in its own language
    const recent = "Consegnato. Nessuna rivendicazione verificabile qui."; // allow-italian: idem
    const cards = [card({ all: [old, recent], window: [recent] })];

    const review = audit(cards, "review", noShaProbe);
    const thread = audit(cards, "thread", noShaProbe);

    expect(review.accused.size).toBe(0);
    expect([...thread.accused.values()][0]!.codes).toContain("sha-missing");
  });

  it("counts a card once per code, however many reports fire it", () => {
    const cards = [
      card({
        landed: true,
        all: ["commit 60a4f445", "commit cffc7a13", "commit 6dc39750"],
        window: ["commit 60a4f445", "commit cffc7a13", "commit 6dc39750"],
      }),
    ];
    const r = audit(cards, "review", noShaProbe);
    const sha = r.codes.find((c) => c.code === "sha-missing")!;
    expect(sha.landed).toBe(1);
    expect(sha.rest).toBe(0);
    expect(r.totals).toEqual({ landed: 1, rest: 0 });
  });

  it("does not accuse a report whose claims all resolve", () => {
    const cards = [card({ window: ["commit 60a4f445 su `server/services/tasks.ts`"] })]; // allow-italian: idem
    expect(audit(cards, "review", cleanProbe).accused.size).toBe(0);
  });

  it("does not count `nothing-to-check` as an accusation", () => {
    const cards = [card({ window: ["Fatto, guarda la board."] })]; // allow-italian: idem
    const r = audit(cards, "review", noShaProbe);
    expect(r.accused.size).toBe(0);
    expect(r.totals.rest).toBe(1);
  });
});

describe("loadCards", () => {
  it("takes the last 3 agent comments since the turn entered in_progress", () => {
    const dir = mkdtempSync(join(tmpdir(), "claims-audit-"));
    const path = join(dir, "topics.db");
    try {
      const db = new Database(path);
      db.run("CREATE TABLE tasks (id TEXT, text TEXT, landing_state TEXT)");
      db.run(
        "CREATE TABLE task_comments (task_id TEXT, author TEXT, kind TEXT, content TEXT, created_at TEXT)",
      );
      db.run("INSERT INTO tasks VALUES ('a', 'una carta', 'landed')"); // allow-italian: idem
      const add = (author: string, kind: string, content: string, at: string) =>
        db.run("INSERT INTO task_comments VALUES ('a', ?, ?, ?, ?)", [author, kind, content, at]);
      add("agent 1", "comment", "vecchio", "2025-01-01"); // allow-italian: idem
      add("system", "status", "todo → in_progress", "2025-01-02");
      add("agent 1", "comment", "uno", "2025-01-03"); // allow-italian: idem
      add("agent 1", "comment", "due", "2025-01-04"); // allow-italian: idem
      add("agent 1", "comment", "tre", "2025-01-05"); // allow-italian: idem
      add("agent 1", "comment", "quattro", "2025-01-06"); // allow-italian: idem
      add("user", "comment", "un commento umano", "2025-01-07"); // allow-italian: idem
      db.close();

      const cards = loadCards(path);
      expect(cards).toHaveLength(1);
      expect(cards[0]!.landed).toBe(true);
      expect(cards[0]!.window).toEqual(["due", "tre", "quattro"]);
      expect(cards[0]!.all).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
