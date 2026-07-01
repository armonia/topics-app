# Design — terminal-tab-reload

## Contesto rilevante (codice esistente)

- `server/routes/terminal.ts`
  - `sessions: Map<id, TerminalSession>` — stato in-memory dei PTY vivi.
  - bridge message `"exit"` (riga ~475): su uscita del PTY rimuove dalla mappa e,
    per `claude-code`/`claude-code-team` con `claude_session_id` e **non**
    `failedQuickly`, marca la riga `status='dormant'`; altrimenti (shell, o
    launch fallito) **DELETE** della riga.
  - `createSession(id, name, cwd, command?, cols, rows, topicId?, type, skipPermissions, claudeSessionId?, parentSessionKey?)` — fa
    `INSERT OR REPLACE` della riga e (per claude/codex con `claude_session_id`)
    lancia `claude --resume <claudeSessionId>`.
  - `POST /api/terminal/sessions/:id/revive` (riga ~1428) — richiede
    `status='dormant'`, poi `createSession(...)`. Modello di riferimento.
  - `sendToBridge({ type: 'kill', id })` — uccide il PTY lato bridge.
  - `broadcastTerminalSessions()` — notifica i client del nuovo roster.
- Client: pane terminale ha id `terminal:<sessionId>` (`types/index.ts`);
  `SingleTerminalPane` è keyed su `sessionId` e riconnette quando la sessione
  ricompare nel roster (`sessionListed`).

## Problema centrale: la race kill → exit → ricrea

Il `revive` esistente presuppone la sessione **già** `dormant`. Per una sessione
**viva** non possiamo chiamarlo direttamente: il `kill` è asincrono e l'exit-handler
può **DELETE**-are la riga (shell) invece di marcarla dormant. Due conseguenze:

1. Non possiamo affidarci a "kill poi revive": per le shell la riga sparisce →
   `revive` darebbe 404.
2. Se ricreassimo troppo presto (PTY vecchio ancora vivo nella mappa), avremmo due
   PTY per lo stesso id.

### Soluzione: cattura-prima, attendi-uscita, ricrea-con-stesso-id

Il handler `/reload`:

1. **Cattura** la riga `terminal_sessions` (o lo `sessions.get(id)` in-memory) in
   un oggetto locale `snap` PRIMA di toccare il bridge — così i dati di ricreazione
   (cwd, command, type, claude_session_id, …) sopravvivono a un eventuale DELETE.
   Se non esiste né viva né in DB → `404`.
2. Se la sessione è **viva** (`sessions.has(id)`): `sendToBridge({type:'kill', id})`
   e **attendi** che esca, facendo polling su `!sessions.has(id)` con timeout
   bounded (es. 10 × 250ms = 2.5s). Se è già dormant/morta, salta il kill.
3. `await ensureBridge()`; `createSession(snap.id, snap.name, snap.cwd, snap.command,
   snap.cols, snap.rows, snap.topicId, snap.type, snap.skipPermissions,
   snap.claudeSessionId, snap.parentSessionKey)`. `createSession` fa `INSERT OR
   REPLACE`, quindi ricrea la riga anche se l'exit l'aveva cancellata.
4. `UPDATE terminal_sessions SET status='active'`; `broadcastTerminalSessions()`;
   ritorna `{ id, type, claudeSessionId }`.

Note:
- **Preservazione conversazione**: per `claude-code`/`claude-code-team`/`codex` con
  `claude_session_id`, `createSession` lancia `--resume` → stessa conversazione,
  stesso terminal id, stesso pane id `terminal:<id>` → il client si riaggancia
  senza che la tab si chiuda/riapra.
- **Shell**: `claude_session_id` assente → PTY fresco nello stesso cwd (re-esegue
  `command` se presente). Accettabile e atteso (lo stato di shell non è resumable).
- **Idempotenza**: se il PTY è già morto al momento della chiamata (race con un
  exit naturale), il polling vede subito `!sessions.has(id)` e si procede a
  ricreare. Nessun doppio PTY perché ricreiamo solo dopo l'uscita.

### Alternative scartate
- *Chiamare `kill` poi `revive`*: fragile per le shell (riga DELETE-ata → 404) e
  dipende dall'ordine degli eventi async. Scartata a favore di cattura-prima.
- *Reload lato client (DELETE + create)*: il `DELETE` rimuove la riga e perde il
  `claude_session_id`/pane id → non più `--resume` pulito e la tab cambierebbe
  identità. Scartata.
- *Watchdog auto-revive*: killa/rilancia processi in autonomia (rischioso, niente
  controllo utente). Il reload manuale è preferito; il watchdog resta un'opzione
  separata non in questo change.

## Client

- `PaneTabBar.tsx`: nel menu `createPortal` esistente, aggiungere un `<button>`
  "Ricarica" **prima** delle voci Close, reso solo se
  `ctxMenu.paneId.startsWith('terminal:')`. onClick:
  `fetch('/api/terminal/sessions/' + id + '/reload', { method:'POST' })`
  (id = `ctxMenu.paneId.slice('terminal:'.length)`), poi `setCtxMenu(null)`.
- Stato di loading opzionale e minimale (disabilita la voce mentre il POST è in
  volo). Nessuna gestione manuale di reconnect: la `SingleTerminalPane` riaggancia
  da sola al ritorno della sessione nel roster.

## Test
- E2E Playwright `tests/e2e/terminal-tab-reload.spec.ts`: apri una shell terminale,
  tasto-destro sulla tab → "Ricarica" → la sessione si riavvia (nuovo prompt) e la
  tab resta la stessa. (Le sessioni `claude` reali non sono testabili in E2E per il
  vincolo di billing; il path `--resume` è coperto a livello server/manuale.)
- Eventuale `bun:test` se si estrae un helper puro (parse `terminal:<id>`, o la
  scelta `--resume` per tipo) — co-locato come `*.test.ts`.

## Rollout
- Server: `kickstart -k` di `com.armonia.topics-server` per attivare l'endpoint.
- Client: `vite build` → `/public` (l'asset-watcher ricarica le finestre Electron).
