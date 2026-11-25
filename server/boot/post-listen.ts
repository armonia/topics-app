/**
 * What runs once the server listens: the banner, the daemon state, the orphan census and the planner stats.
 */
import { refreshPlannerStats } from "../db";
import { writeState } from "../services/daemon-state";
import { probePort, verdictMessage, realProbeDeps } from "../lib/port-squatter";
import { startMachineHealth } from "./machine-health";
import { startTopicsCheck } from "../services/topics-check";
import { createCures, cureDepsOf } from "../services/topics-check-cures";
import { startTopicsCheckDaily } from "../services/topics-check-daily";
import { startQuotaSampler } from "../usage/quota-sampler";
import { createOrphanCensusRunner } from "../services/orphan-census";
import { listTerminalSessionSnapshot, parkOrphanSessions } from "../routes/terminal";
import { startProjectQuotaSweep } from "./project-quota-sweep-start";
import type { AfterRelay } from "./scope";

export function bootPostListen(scope: AfterRelay) {
  const { PORT, browserService, ctx, dispatcherSvc, taskDispatcher, server, tlsCert, useTls } = scope;
  const proto = useTls ? "https" : "http";

  const wsProto = useTls ? "wss" : "ws";

  console.log(`🚀 Topics App running at ${proto}://localhost:${server.port ?? PORT}`);

  console.log(`📡 WebSocket available at ${wsProto}://localhost:${server.port ?? PORT}/ws`);

  if (useTls) console.log(`🔒 TLS enabled (cert: ${tlsCert})`);

  console.log(`🌐 BrowserService available (lazy Chromium, WebSocket at /ws/browser/:id)`);


  // Phase B · DAEMON-01: finalise state file once Bun.serve owns a port.
  // `server.port` reflects the *actual* port (Bun resolves 0 → ephemeral).
  const daemonState = writeState(server.port ?? PORT);

  console.log(`[Daemon] state written → pid=${daemonState.pid} port=${daemonState.port}`);


  // CHI RISPONDE DAVVERO SULLA NOSTRA PORTA.
  //
  // Il 2026-08-20 un server di un altro progetto, avviato a mano con PORT=3333,
  // si era legato a `127.0.0.1:3333` mentre noi ascoltiamo su `*:3333` (IPv6).
  // Il kernel consegna al binding piu' SPECIFICO, quindi ogni connessione
  // dell'app finiva a lui: la porta rispondeva 200 con l'HTML di un altro
  // progetto e in HTTPS moriva con `tlsv1 alert protocol version`. Per NOVE ORE,
  // e il sintomo a schermo era «ci mette un sacco a connettersi» piu' una
  // finestra che non si aggiornava piu'.
  //
  // Il lock singleton non poteva prenderlo: protegge da un secondo TOPICS, e
  // quel processo non era Topics. `reusePort: false` nemmeno: non c'era
  // collisione da rifiutare, perche' i due binding sono legittimi e coesistono.
  //
  // La sonda chiede alla propria porta se chi risponde siamo noi, e se non lo
  // siamo lo DICE col pid e col comando. Non uccide niente: quel processo e' di
  // qualcun altro. Vedi `server/lib/port-squatter.ts`.
  setTimeout(() => {
    const porta = server.port ?? PORT;
    void probePort(porta, realProbeDeps(process.pid))
      .then((esito) => { const msg = verdictMessage(porta, esito); if (msg) console.warn(msg); })
      .catch(() => { /* una sonda che fallisce non deve disturbare il boot */ });
  }, 2000).unref?.();


  // Phase 30 BROWSER-CHAT-01 — restore browser contexts in background.
  // Fire-and-forget: never blocks server startup. Errors are logged but
  // never thrown (matches restoreAllContexts contract).
  browserService.restoreAllContexts(Object.values(ctx.loadTopics().topics))
    .then(r => console.log(`[server] browser restore: ${r.restored} restored, ${r.failed} failed`))
    .catch(err => console.warn(`[server] browser restore failed (non-fatal):`, err.message));


  // Sessioni orfane: censimento e PARCHEGGIO (task `90762124`).
  //
  // Esistono sessioni claude-code vive che nessuna struttura di `ui_state`
  // referenzia — né il pane store, né un layout di progetto, né le pane di
  // progetto, né una tab standalone. Nessuna finestra le mostra, quindi non
  // esiste un gesto umano per chiuderle: restano finché non le si cancella a mano
  // o non si riavvia il server, e nel frattempo consumano.
  //
  // Il censimento ha girato in SOLA LETTURA prima di poter agire, ed era il punto:
  // «non referenziata» attraversa quattro strutture, e un falso positivo spegne
  // una sessione che qualcuno stava usando. Sessantotto giri fra il 04/08 e il
  // 10/08 non hanno mai nominato una sessione. Prova pulita, ma sottile: il roster
  // non ha mai avuto più di UNA sessione viva alla volta, quindi la scarsità dei
  // falsi positivi dice poco. Per questo l'azione non si fida di un censimento
  // solo — vedi `lib/orphan-park-policy.ts`, che pretende DUE avvistamenti
  // consecutivi e si rifiuta di agire se `ui_state` non ha restituito righe.
  //
  // E l'azione è il PARCHEGGIO, non la cancellazione: muore la PTY, la riga resta
  // `dormant`, `--resume` la riporta dov'era con lo scrollback. Un falso positivo
  // su un parcheggio costa un click, su una `DELETE` costa una conversazione.
  // `parkOrphanSessions` passa poi dagli stessi cancelli del giro di inattività
  // (`decidePark`): «orfana» non sa niente di un turno in corso.
  //
  // Il ritardo serve, e 90 secondi NON bastavano: le sessioni di terminale non
  // vengono ripristinate all'avvio, ma quando un client si attacca. Misurato il
  // 04/08 sul server vivo, il primo giro riportava «0 sessioni esaminate» — vero
  // e inutile. A quindici minuti l'app ha attaccato le sue pane e il censimento
  // guarda qualcosa. Poi ogni sei ore: è anche la distanza fra i due avvistamenti
  // che servono per parcheggiare, cioè un'orfana vera muore dopo mezza giornata di
  // conferme e una pane appena creata non rischia niente.
  const ORPHAN_CENSUS_DELAY_MS = 15 * 60_000;

  const ORPHAN_CENSUS_EVERY_MS = 6 * 60 * 60_000;

  // Quanto dev'essere muta la PTY. Non è ridondante con «nessuna interfaccia la
  // mostra»: il registro delle pane non sa se la sessione sta scrivendo ADESSO.
  const ORPHAN_PARK_IDLE_MS = 30 * 60_000;

  // Acceso di serie, spegnibile con `TOPICS_ORPHAN_PARK=0`. Al contrario del
  // parcheggio per inattività — spento di default perché una sessione parcheggiata
  // mostra «Sessione scaduta» finché la sua pane non la rianima — qui quella
  // ragione non esiste: un'orfana non ha una pane che possa mostrare alcunché.
  const ORPHAN_PARK_ENABLED = (process.env.TOPICS_ORPHAN_PARK ?? "1").trim() !== "0";

  // La catena vive in `services/orphan-census.ts` (dove un test la monta identica
  // a questa); qui restano solo le dipendenze vere e i timer.
  const orphanCensusRunner = createOrphanCensusRunner({
    listSessions: () => listTerminalSessionSnapshot(),
    listUiStateValues: () =>
      (ctx.db.query("SELECT value FROM ui_state").all() as Array<{ value?: string }>)
        .map((row) => row.value ?? "")
        .filter(Boolean),
    park: (ids) => { parkOrphanSessions(ids, ORPHAN_PARK_IDLE_MS); },
    enabled: ORPHAN_PARK_ENABLED,
  });

  function runOrphanCensus(): void {
    try {
      orphanCensusRunner();
    } catch (err) {
      // Un censimento che non riesce non deve mai essere un problema del server:
      // non serve a farlo funzionare, serve a farci sapere una cosa. E un giro
      // fallito non lascia conferme: la memoria del giro precedente resta com'era,
      // quindi mezza lettura non può diventare un permesso.
      console.warn("[orphan-census] salto questo giro:", (err as Error).message);
    }
  }

  setTimeout(() => {
    runOrphanCensus();
    setInterval(runOrphanCensus, ORPHAN_CENSUS_EVERY_MS).unref?.();
  }, ORPHAN_CENSUS_DELAY_MS).unref?.();


  // Planner statistics for `tasks` (see refreshPlannerStats): a minute after boot,
  // so the ~4 ms write is not on the path to the first 200, then once a day.
  function runPlannerStats(): void {
    try {
      refreshPlannerStats(ctx.db);
    } catch (err) {
      // Without fresh stats the queries stay correct, only slower: skip the round.
      console.warn("[db] ANALYZE tasks skipped:", (err as Error).message);
    }
  }

  setTimeout(() => {
    runPlannerStats();
    setInterval(runPlannerStats, 24 * 60 * 60_000).unref?.();
  }, 60_000).unref?.();

  // Project daily limits: opens pauses and tells every window, the bell and the owner channel.
  startProjectQuotaSweep(ctx, `${proto}://localhost:${server.port ?? PORT}`);

  // Machines' health for the tray: security probes, CPU and memory, cards of today.
  startMachineHealth(ctx);

  // Self-check round: three voices in hours lost, every 5 minutes, no model calls.
  const cures = createCures(cureDepsOf(ctx.db, dispatcherSvc, taskDispatcher));
  // The cures change real cards: the e2e server keeps them off.
  startTopicsCheck(ctx.db, (sample, s) => (process.env.TOPICS_E2E !== "1" ? cures.run(sample, s.thresholds, s.investigation) : []));
  // Once a day, one model reading of what the counts cannot see; independent of the round above, and off in the
  // e2e server, where the call would be paid.
  if (process.env.TOPICS_E2E !== "1") {
    startTopicsCheckDaily(ctx.db, (inv, title, body) => cures.openDaily(inv, title, body));
  }

  // Quota history for the points count: without a writer the file never exists on a clean install (card 29aa4259).
  if (process.env.TOPICS_E2E !== "1") startQuotaSampler();
}
