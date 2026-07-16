# Proposal — dispatch-resume-on-restart

## Why

**Sintomo osservato**: a ogni riavvio del server (deploy via `launchctl kickstart`,
hot-reload di `bun --watch` in dev, crash) i task della board che erano in lavorazione
**ripartono da zero**. Analisi su `main` (v2.1.78):

- I turni dispatched sono guidati **in-process**: `runHeadlessTurn` (server.ts) POSTa a
  `/api/chat` e drena l'SSE; il figlio `claude` CLI è un child del processo server
  (`claude-code.ts`, spawn diretto — NON passa dal PTY bridge). `gracefulShutdown` →
  `stopAllProviders()` SIGTERMa i figli. Al riavvio **nessun turno sopravvive**.
- Al boot `taskDispatcher.reconcile()` (server.ts:1401) trova i task `in_progress` con
  `dispatch_state ∈ {starting, working}` senza launch in-flight e li **rimette in coda
  da zero**: `release(requeue, rollbackAttempt)` azzera `assigned_topic_id`, il tick li
  re-claima e `launch()` crea un **topic NUOVO + worktree NUOVO + kickoff da capo**.
- Conseguenze: l'agent perde conversazione, piano e step già costruiti; il worktree con
  il lavoro a metà resta orfano (ne nasce un altro); un tab agent duplicato compare in
  sidebar; i token del kickoff full-envelope si ripagano a ogni riavvio. In dev, dove
  `bun --watch` riavvia a **ogni salvataggio** sotto `server/`, il loop è
  salva-file → tutti gli agent ripartono da capo.

**Il paradosso**: tutta la persistenza necessaria a NON ripartire esiste già.
`claude_code_sessions` mappa `sessionKey → claude_session_id` e ogni respawn del CLI usa
`--resume` ("Survives hot reloads, inactivity timeouts, and crashes"); il topic, il
worktree e il task (binding compreso) sono in SQLite. L'unica cosa che muore col server
è il **driver in-memory del turno**. E KANBAN-07 già prescrive, per i timeout, "MAI un
release+re-claim che scarta la conversazione e fa ripartire l'agent da zero" — il
reconcile post-riavvio è rimasto l'unico percorso che viola quel principio.

## What Changes

`reconcile()` smette di ributtare in coda gli orfani di riavvio che hanno ancora tutto
per continuare, e li **riprende sulla STESSA sessione**:

- Orfano `working` + `assigned_topic_id` vivo (`topicExists`) + auto-dispatch attivo →
  commento di sistema nel thread + `resume(taskId, "", {continuation: true})`: stesso
  topic, stesso worktree, stessa conversazione (CLI `--resume`), nudge di continuazione
  lean. **Nessun tentativo consumato** (il riavvio non è colpa dell'agent).
- Fallback invariato (release + requeue + rollback del tentativo) per: binding assente
  (crash tra claim e bindTopic), topic morto (reaped durante il downtime), chip
  `starting` (kickoff mai davvero partito), auto-dispatch globale spento. In
  quest'ultimo caso il chip `queued` viene azzerato (su una board che non dispatcha il
  chip strand-erebbe per sempre).

## Non-Goals

- **Server separato per il dispatch** (valutato e scartato per ora): un daemon "agent
  host" alla pty-bridge terrebbe vivi i figli CLI attraverso i riavvii, ma aggiunge un
  layer IPC per streaming/abort/usage e un secondo lifecycle da gestire. Con la
  persistenza `--resume` già esistente, resume-in-place recupera tutto tranne la singola
  chiamata API in volo al momento del kill — rapporto costo/beneficio nettamente a
  favore del fix in-process. Riconsiderare solo se emergesse la necessità di turni che
  DEVONO sopravvivere al riavvio senza nemmeno un'interruzione.
- Recupero degli orfani hard-kill (SIGKILL: figli CLI riparentati a launchd che
  continuano a scrivere il transcript): coperto best-effort dal doomed-`--resume`
  fallback già presente nel provider.
- GC dei worktree/topic orfani lasciati dai requeue storici (pre-fix).

## Impact

- `server/services/task-dispatcher.ts` — solo `reconcile()` (+ i test).
- Nessuna migration, nessun cambio client: `dispatch_state` resta `working`, la board
  vede il commento di sistema e il ticker live ripartire.
- Spec: ADDED `KANBAN-10` (delta in `specs/kanban/spec.md` di questa change).
