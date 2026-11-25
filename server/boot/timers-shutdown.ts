/**
 * Idle GC, vacuum and loop-lag timers, and the graceful shutdown.
 */
import { closeDatabase } from "../db";
import { startToolOutputBackfill } from "../lib/tool-output-store";
import { releaseLock } from "../services/daemon-state";
import { giroIdleGc, IDLE_GC_EVERY_MS } from "../lib/idle-gc";
import { runIncrementalVacuum, INCREMENTAL_VACUUM_EVERY_MS } from "../lib/db-incremental-vacuum";
import { startLoopLagSampler } from "../lib/loop-lag-sampler";
import { disconnectBridge } from "../routes/terminal";
import { procFootprintKB } from "../lib/fleet-usage";
import { stopReviewChecks } from "../services/review-checks-brakes";
import { chromiumSidecar } from "../browser-engine-registry";
import { stopAllProviders } from "../providers";
import type { AfterRelay } from "./scope";
import { late } from "./late";

export function bootTimersShutdown(scope: AfterRelay) {
  const { activeStreams, browserService, budgetGovernor, ctx, dispatchTimer, heartbeatTimer, landingAuditBoot, landingAuditTimer, openBrokerChatTurns, previewBrowser, relayLicenzaTimer, scheduleEngine, stopUiStateBackup, swapFreezer, taskDispatcher, webrtcBridge, whatIsStillWorking, worktreeGcBoot, worktreeGcTimer, wsHeartbeatTimer } = scope;
  /**
   * IL GC DI RIPOSO — restituire al sistema la memoria dei picchi passati.
   *
   * Misurato il 2026-08-19 sul server di produzione dell'utente, dopo cinque ore
   * di uptime: `phys_footprint` 936 MB e picco 2,4 GB, contro una heap JS di
   * 52 MB e un RSS di 110 MB. Gli 826 MB in mezzo erano pagine toccate durante i
   * turni degli agenti, poi swappate dal sistema, e mai restituite — swap
   * occupato che `phys_footprint` continua ad attribuire all'app, cioè
   * ESATTAMENTE il numero che la barra di stato e Monitoraggio Attività mostrano
   * (ed è il numero che ha prodotto la segnalazione «1,8 GB»).
   *
   * Il perché sta in `server/lib/idle-gc.ts`, con la misura che dimostra che
   * `Bun.gc(true)` scioglie anche le pagine già in swap — la parte non ovvia,
   * perché il footprint da solo non scende MAI, nemmeno dopo che il sistema ha
   * swappato tutto.
   *
   * COSA LO TRATTIENE, e perché non tutto ciò che trattiene un riavvio. La prima
   * versione riusava il predicato di `restart-when-idle` per intero, e sarebbe
   * stata inutile: su questa macchina `activeStreams` ha due chat aperte quasi
   * sempre, quindi il gc non sarebbe partito una sola volta in dieci minuti. La
   * pausa che giustificava quella prudenza, misurata, è **1-15 ms** (caso
   * peggiore 8 ms su 18.845 oggetti vivi) — meno di un frame. Restano fuori le
   * card della board e i turni adottati dal broker: là un agente scrive file e
   * la sua latenza è l'unica cosa che ha. La decisione, con i numeri, sta in
   * `server/lib/idle-gc.ts`.
   */
  const idleGcTimer = setInterval(() => {
    void giroIdleGc({
      sorgenti: async () => {
        const cards = taskDispatcher.busyCount();
        const streamKeys = [...activeStreams.keys()];
        // Stessa economia di `whatIsStillWorking`: la sonda del broker si paga,
        // e non si paga quando una fonte gratuita ha già detto «occupato».
        if (cards > 0 || streamKeys.length > 0) return { cards, streamKeys, brokerOpenKeys: [] };
        return { cards, streamKeys, brokerOpenKeys: await openBrokerChatTurns() };
      },
      footprintMB: () => {
        const kb = procFootprintKB(process.pid);
        return kb === null ? null : Math.round(kb / 1024);
      },
      raccogli: () => { Bun.gc(true); },
      log: (m) => console.log(m),
    });
  }, IDLE_GC_EVERY_MS);

  idleGcTimer.unref?.();


  /**
   * Free database pages go back to the disk while nothing is working.
   *
   * The predicate is the restart gate's own (`whatIsStillWorking`), read as what
   * WORKS (`workingBusy`) and not as what holds a restart (`busy`): a turn parked
   * on a question computes nothing, and a question left open overnight skipped
   * every round (RGATE-13). The round asks again before every step. Bounds and measurements are in
   * `server/lib/db-incremental-vacuum.ts`. Until the one-time conversion in
   * start-prod.sh has run, `auto_vacuum` is NONE and every round is a no-op.
   */
  const incrementalVacuumTimer = setInterval(() => {
    runIncrementalVacuum({
      db: ctx.db,
      busy: async () => (await whatIsStillWorking()).workingBusy,
      log: (line) => console.log(line),
    }).catch((err) => console.warn("[incremental-vacuum] round skipped:", (err as Error).message));
  }, INCREMENTAL_VACUUM_EVERY_MS);

  incrementalVacuumTimer.unref?.();


  /**
   * WHEN THIS PROCESS STOPS ANSWERING, ONE LINE SAYS WHAT WAS TRUE OF IT.
   *
   * The `[HTTP]` line above measures a request from the moment the loop is free
   * to take it, so a route that never got a turn looks slow and a route that made
   * everyone wait looks normal. On 2026-09-07 that hid a whole shape: 22 windows
   * of 2.5 to 12.5 seconds in which nothing was served, and the blame landed on
   * `/api/people`, which is four queries over ten rows. The rest of the reasoning
   * is in `server/lib/loop-lag-sampler.ts`.
   */
  const loopLagTimer = startLoopLagSampler({ log: (line) => console.log(line) });


  // Tool output of the rows written before it had its own table
  // (server/lib/tool-output-store.ts): moved out a few rows at a time, after the
  // boot has settled, never while the loop is behind.
  const stopToolOutputBackfill = startToolOutputBackfill(ctx.db, {
    startDelayMs: 2 * 60_000,
    log: (line) => console.log(line),
  });


  // Graceful shutdown
  let shutdownInProgress = false;

  async function gracefulShutdown(signal: string) {
    // Re-entrancy guard: a second signal during shutdown (hot-reload watcher
    // double-batch) must not run the teardown twice.
    if (shutdownInProgress) {
      console.log(`[Shutdown] ${signal} received while already shutting down — ignored`);
      return;
    }
    shutdownInProgress = true;
    console.log(`\n[Shutdown] Received ${signal}, closing browser service...`);
    // First of all: no scheduled job starts once the shutdown has begun (R3).
    scheduleEngine.stop();
    clearInterval(heartbeatTimer);
    clearInterval(wsHeartbeatTimer);
    clearTimeout(late.staleStreamTimer);
    clearInterval(dispatchTimer);
    clearTimeout(worktreeGcBoot);
    clearInterval(worktreeGcTimer);
    clearTimeout(landingAuditBoot);
    clearInterval(landingAuditTimer);
    clearInterval(relayLicenzaTimer);
    clearInterval(idleGcTimer);
    clearInterval(incrementalVacuumTimer);
    clearInterval(loopLagTimer);
    // First of all: the state file goes away and the port is freed for the next process.
    late.externalProxyStopped = true;
    void late.externalProxy?.close();
    stopToolOutputBackfill();
    // A process left STOPped by the governor is a process nobody will ever
    // continue: the one thing that could send it SIGCONT is the loop that is
    // about to stop. Thaw before anything else goes away.
    try { await budgetGovernor.thawAll(); } catch { /* best effort on the way out */ }
    // The swap freezer's trees go the same way, and BEFORE the checks are killed:
    // a stopped process holds a SIGTERM until it is continued, so a tree left
    // frozen here would take its signal only at the next boot's ledger thaw.
    try { await swapFreezer.thawAll("shutdown"); } catch { /* best effort on the way out */ }
    // Then the check trees go. `slot.ts` runs each command in a process group of
    // its own, so without this a reload left every running check reparented to
    // pid 1, finishing a verdict nobody would read while the new server started
    // the same cards' checks beside it (15/09/2026: four unit trees at once).
    // After the thaw, because a stopped process holds a SIGTERM until it is
    // continued. The rounds throw instead of recording the killed run as a red,
    // and a delivery waiting on one answers "still running" without moving.
    try { await stopReviewChecks(); } catch { /* best effort on the way out */ }
    // Prima di spegnere il dispatcher, non dopo: `shutdown()` svuota `inFlight`,
    // e quella mappa e' l'unica fotografia di chi stava lavorando in questo
    // istante. Senza questa riga lo stato «interrotto» non veniva deciso, veniva
    // INDOVINATO dal boot successivo guardando il chip rimasto sulla card.
    try { taskDispatcher.markInterrupted(signal); }
    catch { /* uno spegnimento non fallisce per una nota */ }
    taskDispatcher.shutdown();
    void late.previewManager?.teardownAll(); // kill any live preview servers
    stopUiStateBackup();
    disconnectBridge(); // Disconnect from bridge — bridge daemon stays alive, PTY sessions persist
    await webrtcBridge.shutdown();
    await browserService.close();
    await previewBrowser.close();
    // Il sidecar Chromium NON è di browserService: il suo processo appartiene al
    // registry degli engine, che lo tiene a conteggio di riferimenti. close() qui
    // sopra chiude solo i client CDP, quindi finché mancava questa riga l'uscita
    // PULITA lasciava comunque in piedi un Chromium sulla 19333, reparentato a
    // launchd. È il gemello del leak da SIGKILL, ma sul cammino buono.
    chromiumSidecar.dispose();
    // Stop all AI providers BEFORE closing the DB. claude-code's stop() sends
    // SIGTERM to the spawned `claude` CLI children so they flush session state
    // to ~/.claude/sessions/ — without this, `bun --watch` hot reloads left
    // children orphaned and the next spawn started a fresh conversation. The
    // grace window inside stopAllProviders matches each provider's internal
    // SIGTERM→SIGKILL window so process.exit() doesn't truncate the flush.
    //
    // QUELLA FINESTRA ORA REGGE ANCHE IL CARTELLO IN CHAT, e va detto perché
    // nessuno la accorci senza saperlo. `stop()` del runtime nativo annulla i
    // turni vivi con causa `server-shutdown`; il cartello che spiega la caduta
    // all'utente lo scrive il `catch` di `sendChat` → `onAborted` →
    // `finalizeStream` → `updateLastMessage`. Fra l'`abort()` e quella scrittura
    // c'è un giro di microtask (la promise del turno rigetta, il catch gira
    // dopo): sincrono no, ma nemmeno lontanamente vicino ai 3500 ms. Se un domani
    // questa finestra scendesse a zero, il turno morirebbe di nuovo senza una
    // parola — con la differenza che stavolta il codice per parlare c'è, e
    // sarebbe `closeDatabase()` a impedirglielo.
    await stopAllProviders();
    closeDatabase();
    releaseLock();
    process.exit(0);
  }

  return { gracefulShutdown };
}
