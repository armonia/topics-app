## Why

Le sessioni Claude Code dentro Topics possono restare **incastrate a livello di
processo**: il caso visto in produzione è il banner persistente
`Not logged in · Run /login` che compare quando l'account-switcher proxy (a cui
tutte le sessioni `claude` puntano via `ANTHROPIC_BASE_URL`) entra per un attimo
in `all-exhausted` (un account col refresh token rotto **mentre** gli altri sono
rate-limited → zero account buoni). In quella finestra la CLI prende un 401, latcha
il banner, e **non si auto-recupera** anche dopo che il pool guarisce. Stesso
sintomo per un PTY appeso o una CLI che si è bloccata.

Oggi l'unico modo per sbloccarne una è chirurgia manuale: trovare il PID del
processo `claude --resume`, `kill`, attendere che il server la marchi `dormant`,
e fare `POST /api/terminal/sessions/:id/revive`. Un `kickstart` del server **non**
basta (il bridge tiene vivi i PTY tra i restart). Serve un'azione self-service:
l'utente deve poter **ricaricare una singola tab** con un gesto, preservando la
conversazione.

Il substrato c'è già: il menu tasto-destro delle tab esiste
(`PaneTabBar` → `handleContextMenu`/`ctxMenu`), l'endpoint `revive` ricrea con
`--resume`, e le tab terminale hanno pane id deterministico `terminal:<sessionId>`.
Manca solo: (1) un endpoint che renda **atomico** il `kill`+`revive` su una
sessione viva, e (2) la voce "Ricarica" nel menu.

## What Changes

### Server — reload endpoint
- Nuovo `POST /api/terminal/sessions/:id/reload` (in `server/routes/terminal.ts`)
  che riavvia **in-place** una sessione viva:
  - cattura i campi della riga `terminal_sessions` **prima** del kill (cwd, name,
    command, type, topic_id, claude_session_id, parent_session_key, cols, rows,
    skip_permissions);
  - invia `kill` al bridge e **attende** che il PTY esca (la sessione lascia la
    mappa in-memory `sessions`) con un piccolo polling bounded;
  - ricrea con `createSession(row.id, …, type, …, claude_session_id)`. Per
    `claude-code` / `claude-code-team` / `codex` con `claude_session_id` →
    rilancia con `--resume` (stessa conversazione, **stesso** terminal id). Per
    `shell` → riavvia il PTY nello stesso cwd (niente `--resume`).
  - idempotente/safe: se la sessione è già morta/dormant si limita a (ri)crearla;
    404 solo se non esiste né viva né in DB.

### Client — voce "Ricarica" nel menu tab
- In `client/src/components/Layout/PaneTabBar.tsx`, aggiungere una voce
  **"Ricarica"** nel menu contestuale `createPortal` esistente, mostrata **solo**
  quando `ctxMenu.paneId.startsWith('terminal:')`. Al click: estrae il `sessionId`
  (dopo `terminal:`), fa `POST` all'endpoint `/reload`, chiude il menu. Icona
  `RotateCw` (lucide). La tab si riaggancia da sola al nuovo PTY (la `SingleTerminalPane`
  è keyed sul `sessionId`, che è preservato, e riconnette su `sessionListed`).

## Capabilities

### Modified Capabilities
- `terminal`: aggiungere il requisito "Reload (restart) a terminal session in
  place" (endpoint `/reload` + voce di menu, con preservazione conversazione via
  `--resume` per le sessioni Claude/codex).

## Impact

- Server: `server/routes/terminal.ts` (nuovo handler `/reload`; riusa `kill`,
  l'exit-handler e `createSession`). Applicare con `kickstart -k` del server
  (`com.armonia.topics-server`) — niente hot-reload sugli edit di `server/`.
- Client: `client/src/components/Layout/PaneTabBar.tsx` (voce di menu). Richiede
  `vite build` → `/public` per la prod.
- Tests: nuovo `tests/e2e/terminal-tab-reload.spec.ts` (Playwright); eventuale
  `bun:test` se si estrae un helper puro (es. parsing `terminal:<id>` o la
  decisione `--resume` per tipo).
- Nessuna modifica al proxy account-switcher, ai dev server, allo schema DB, o al
  protocollo di sync.
