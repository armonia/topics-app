/**
 * WHO THE LANDING AUDIT ASKS on a pass (landing-audit-pass.ts): alive cards,
 * delivered (review/done), carrying a delivery, without a witnessed landing.
 *
 * A WITNESS counts for "it landed", and only for that: content that is on main
 * stays there, so checking again would put a deduction over a fact. "It did NOT
 * land" is a fact about an INSTANT, the land that failed, and says nothing
 * about the next day, when a person may have cherry-picked that work by hand.
 * Keeping it out of the audit forever froze the accusation: on 13/08 two cards
 * said "not on main" with their commit an ANCESTOR of main, in Done for days.
 *
 * And then the SECOND SET, the opposite of the first: cards with no recorded
 * delivery that ALREADY carry an accusation. Without a commit there is nothing
 * to verify, which was the reason for the filter; but `markLandPending` stamps
 * `unlanded` as soon as the land is ASKED, and counts on this pass to correct
 * itself. While the filter kept them out the stamp was final: on 18/08, 13
 * topics-app cards stuck on "not on main" with no delivery, the oldest for six
 * days, two of them with the land's merge on main. An accusation nobody can
 * sustain any more is WITHDRAWN, and that is the audit's work as much as
 * writing it.
 *
 * Out of tasks.ts on 15/10, when the size gate stopped it one line under its
 * ceiling.
 */
import type { Database } from "bun:sqlite";

/** How long a settled landing verdict (landed, unverifiable) stays out of the audit pass. */
export const SETTLED_LANDING_RECHECK_MS = 24 * 60 * 60_000;

export interface LandingAuditCandidate {
  id: string;
  projectId: string;
  deliveryBranch: string | null;
  deliveryCommit: string | null;
}

interface CandidateRow {
  id: string;
  project_id: string;
  delivery_branch: string | null;
  delivery_commit: string | null;
}

export function listLandingAuditCandidates(db: Database, nowIso: string): LandingAuditCandidate[] {
  return db.prepare<CandidateRow, [string]>(
    `SELECT id, project_id, delivery_branch, delivery_commit
       FROM tasks
      WHERE archived = 0
        -- A BRANCH IS A DELIVERY, no less than a commit is. debtVerdict
        -- asks the branch first (classifyBranchLanding) and only falls back
        -- to the commit once the branch is gone: the verdict logic already
        -- knew how to answer for a card carrying only a branch, and it was
        -- this line that never asked it.
        --
        -- What that cost, measured on this board on 2026-08-21: 27 done
        -- cards with a branch and no commit, invisible to the audit for
        -- their whole life. Looked at afterwards, of the first twelve
        -- branches none was still alive and exactly one merge could be
        -- found on main: the evidence had already evaporated. The value is
        -- not in recovering those. It is that from now on such a card gets
        -- asked WHILE its branch exists, the only moment the question has
        -- an answer.
        --
        -- NULL and unverifiable are not the same state: the first says
        -- nobody ever asked, the second says we asked and the evidence is
        -- gone. The second is a measurement; the first is a hole.
        AND (
          delivery_commit IS NOT NULL
          OR (delivery_branch IS NOT NULL AND delivery_branch <> '')
          OR landing_state = 'unlanded'
        )
        AND status IN ('review', 'done')
        -- A DECISION is not measured again: superseded says "not on main,
        -- and that is fine". The audit asks the repo, and the repo would
        -- answer unlanded again, erasing the choice on every pass.
        AND COALESCE(landing_state, '') <> 'superseded'
        AND NOT (COALESCE(landing_witnessed, 0) = 1 AND landing_state = 'landed')
        -- A SETTLED verdict is asked again once a day, not every pass.
        -- 'landed' only changes if main reverts the work, 'unverifiable'
        -- only if the vanished evidence comes back; meanwhile every 30-min
        -- pass, and every boot, re-asked them all: on 15/10 one pass took
        -- 303 cards (144 landed, 145 unverifiable, 14 unlanded) and about
        -- 900 git processes, the bulk of the server's 1,048 git in 15
        -- minutes. 'unlanded' and never-asked cards keep the 30-min pace:
        -- those are the ones a person acts on.
        AND NOT (
          landing_state IN ('landed', 'unverifiable')
          AND landing_checked_at IS NOT NULL
          AND landing_checked_at > ?
        )`,
  ).all(new Date(Date.parse(nowIso) - SETTLED_LANDING_RECHECK_MS).toISOString()).map((r) => ({
    id: r.id,
    projectId: r.project_id,
    deliveryBranch: r.delivery_branch ?? null,
    deliveryCommit: r.delivery_commit ?? null,
  }));
}
