/**
 * The sweeps of what the previous process left behind, and the holds that keep turns from being cut while they run.
 */
import { finalizeOrphanedRunningTools } from "../lib/boot-orphan-tools";
import { loadOwedAnswers } from "../lib/owed-answers";
import { aiBridgeEnabled } from "../providers/claude-code";
import { sessionKeyOfBrokerId, nativeDetachedEnabled, openRowSince } from "../providers/native/detached-turn";
import { classifyNativeBootSessions } from "../lib/boot-native-turns";
import { getAiBridgeClient } from "../lib/ai-bridge-client";
import { runBootPartialSweep } from "../lib/boot-partial-sweep";
import type { AfterTerminalsWs } from "./scope";
import { late } from "./late";
import { backfillProjectParents } from "../services/project-family-backfill";
import { worktreeRootDir } from "../services/worktree-manager";

export async function bootBootSweeps(scope: AfterTerminalsWs) {
  const { db, turnLedger } = scope;
  // Worktree-projects get their parent project (accorpa / separa). Idempotent and
  // cheap when there is nothing to do: one read of the projects table.
  try {
    const family = backfillProjectParents(db, { worktreeRoot: worktreeRootDir() });
    for (const a of family.assigned) console.log(`[Startup] project ${a.slug} is a worktree of ${a.parentSlug}: parent set, cards untouched`);
  } catch (err) {
    console.warn("[Startup] project family backfill failed:", err instanceof Error ? err.message : err);
  }
  // Startup: reset stale partial messages (via SQLite). BEFORE clearing,
  // capture which sessions were mid-turn: the chat-reattach boot sweep below
  // uses this set to tell a SURVIVING broker turn (detached by the previous
  // server's graceful shutdown — adopt it) from an idle child (reap it).
  // Reading partial=1 after this block would always see zero rows.
  //
  // Sessions whose child is still ALIVE in the detached ai-bridge daemon are
  // NOT stale — the turn survived the restart — so their partial rows are left
  // untouched. This keeps the mid-turn signal intact across RAPID successive
  // reloads: a boot that adopts and then dies before its adopted turn rewrote
  // the partial row must not blind the NEXT boot's sweep (observed live: the
  // sweep reaped a mid-turn child after a double reload). The adopted turn's
  // leftovers are cleared by the sweep when the turn ends.
  const midTurnAtBoot = new Set<string>();

  /** Le sessioni di chat il cui figlio è ANCORA VIVO nel broker a questo boot.
   *  Serve oltre al setaccio dei parziali: un figlio vivo può ancora consegnare
   *  il tool che ha in corso, quindi quel tool non è un orfano da bollare come
   *  interrotto (vedi finalizeOrphanedRunningTools). */
  const liveBrokerChatSessions = new Set<string>();

  /** Native turns whose process ended while no server was listening: the store holds their ending. */
  const nativeEndedWhileDown = new Set<string>();

  {
    console.log("[Startup] Checking for stale partial messages...");
    // `listConfirmed` = we got an AUTHORITATIVE alive-set from the broker. This is
    // the load-bearing invariant of reload-survival: resetting a partial row to
    // partial=0 is what later mints the "interrotto" marker, so we only do it for
    // a session the broker CONFIRMS is dead. If we cannot get a confirmed list
    // (daemon not yet connected during the boot race, a transient error), we
    // treat every mid-turn row as "possibly alive" and KEEP partial=1 — the
    // reattach sweep below (which lists again) reconciles survivors, and a
    // genuinely-dead one is cleaned by its .finally / the next boot. Never orphan
    // a possibly-live turn on an unconfirmed read.
    let listConfirmed = false;
    if (aiBridgeEnabled()) {
      for (let attempt = 0; attempt < 4 && !listConfirmed; attempt++) {
        try {
          await getAiBridgeClient().ensureConnected();
          const sessions = await getAiBridgeClient().list();
          liveBrokerChatSessions.clear();
          for (const s of sessions) if (s.alive && s.id.startsWith("topic:")) liveBrokerChatSessions.add(s.id);
          // A native turn runs in its own process under `native:<session key>`.
          // Alive = the turn goes on; dead with a journal = it ENDED while no
          // server was listening, and its ending is in the store for the
          // reattach to read. Either way its row is not a dead turn's - unless
          // detached turns are off, and then nothing re-adopts it (see
          // `classifyNativeBootSessions`).
          const native = classifyNativeBootSessions(
            sessions.flatMap((s) => { const sk = sessionKeyOfBrokerId(s.id); return sk ? [{ ...s, sessionKey: sk }] : []; }),
            nativeDetachedEnabled(),
            (sk) => openRowSince(sk, db),
          );
          for (const sk of native.alive) liveBrokerChatSessions.add(sk);
          for (const sk of native.endedWhileDown) nativeEndedWhileDown.add(sk);
          for (const id of native.kill) {
            console.log(`[Startup] forgetting native turn ${id}: ${nativeDetachedEnabled() ? "a dead store that is not its open row's turn" : "detached native turns are off, its chat is resumed from the database"}`);
            try { getAiBridgeClient().kill(id); } catch { /* daemon hiccup: its orphan grace collects it */ }
          }
          listConfirmed = true;
        } catch {
          await new Promise((r) => setTimeout(r, 250)); // daemon still coming up — retry
        }
      }
      if (!listConfirmed) {
        console.warn("[Startup] ai-bridge list() unavailable after retries — keeping ALL partial rows intact (reattach will reconcile); refusing to orphan possibly-live turns");
      }
    } else {
      listConfirmed = true; // bridge disabled → no detached survivors possible → safe to reset
    }
    // Popola midTurnAtBoot prima del sweep (il set serve al reattach successivo).
    for (const { sk } of db.query("SELECT DISTINCT session_key AS sk FROM messages WHERE partial = 1").all() as Array<{ sk: string }>) {
      midTurnAtBoot.add(sk);
    }
    let cleared = 0, kept = 0;
    try {
      // La logica kept/reset e l'inserimento della notifica sono in
      // boot-partial-sweep.ts (testabile in isolamento con un db in-memory).
      ({ cleared, kept } = runBootPartialSweep(db, {
        listConfirmed,
        liveSessions: new Set([...liveBrokerChatSessions, ...[...nativeEndedWhileDown].filter((sk) => midTurnAtBoot.has(sk))]),
      }));
    } catch { /* capture is best-effort; the sweep degrades to reaping */ }
    console.log(`[Startup] partial sweep: reset ${cleared}, kept ${kept} (mid-turn ${midTurnAtBoot.size}, broker-alive ${liveBrokerChatSessions.size}, listConfirmed=${listConfirmed})`);
  }


  // A SESSION THAT MAY STILL BE MID-TURN IS NOT FREE UNTIL THE BOOT SAYS SO.
  // `Bun.serve` answers before the reattach below has registered a surviving
  // turn, and before the resume sweep has resent an interrupted one: a message
  // sent in that window reached a child in the middle of its turn, or jumped
  // ahead of the turn the sweep was about to resume. The ledger holds these
  // sessions open ("boot") until each one is decided; the resume sweep's own
  // resend passes the hold (`routes/chat.ts`).
  const brokerBootHolds = new Set([...liveBrokerChatSessions, ...[...nativeEndedWhileDown].filter((sk) => midTurnAtBoot.has(sk))]);

  const resumeBootHolds = new Set([...midTurnAtBoot].filter((sk) => !brokerBootHolds.has(sk)));

  for (const sk of [...brokerBootHolds, ...resumeBootHolds]) turnLedger.set(sk, "boot", true);

  function releaseBootHold(sk: string): void {
    if (!brokerBootHolds.delete(sk) && !resumeBootHolds.delete(sk)) return;
    turnLedger.set(sk, "boot", false);
  }


  // Tools a dead turn left 'running' are closed as interrupted (`lib/boot-orphan-tools.ts`).
  //
  // BEFORE THE SERVER LISTENS, because of the answers it finds still owed to the
  // model (`lib/answer-relay.ts`): they go into the relay's queue here, so the
  // first message a person sends after the restart already finds them and
  // carries them in front of itself. Loaded after `listen` (it was, until 30/09)
  // a message that got in first reached the model before an answer the person
  // gave before it. Their SENDING waits for the surviving turns to be adopted
  // (`releaseAnswersOwedAtBoot`, below): until then a session only looks free.
  //
  // The owed answers come from `owed_answers` (`lib/owed-answers.ts`), any age,
  // any topic: the sweep only walks thirty days of finalized rows of topics not
  // archived, and a question never expires. The sweep indexes what it finds
  // first (the marks written before the index existed), so the index is read
  // after it; its own list is enqueued too, a no-op for every answer already in.
  const releaseAnswersOwedAtBoot = late.answerRelay?.hold();

  const answersSweptAtBoot = finalizeOrphanedRunningTools(db, brokerBootHolds);

  for (const owed of [...loadOwedAnswers(db), ...answersSweptAtBoot]) late.answerRelay?.enqueue(owed);

  return { brokerBootHolds, midTurnAtBoot, nativeEndedWhileDown, releaseAnswersOwedAtBoot, releaseBootHold, resumeBootHolds };
}
