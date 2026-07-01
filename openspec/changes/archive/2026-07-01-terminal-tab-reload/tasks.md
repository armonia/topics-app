# Tasks — terminal-tab-reload

## 1. Server — endpoint /reload
- [x] 1.1 In `server/routes/terminal.ts`, aggiungere `POST /api/terminal/sessions/:id/reload`: cattura snapshot della riga (in-memory `sessions.get(id)` o DB `terminal_sessions`) PRIMA del kill; `404` se non esiste né viva né in DB.
- [x] 1.2 Se viva: `sendToBridge({type:'kill', id})` + polling bounded su `!sessions.has(id)` (≤ ~3s). Se già morta/dormant: salta il kill.
- [x] 1.3 `await ensureBridge()` + `createSession(snap.id, snap.name, snap.cwd, snap.command, snap.cols, snap.rows, snap.topicId, snap.type, snap.skipPermissions, snap.claudeSessionId, snap.parentSessionKey)` → `--resume` per claude/codex con `claude_session_id`, PTY fresco per shell.
- [x] 1.4 `UPDATE terminal_sessions SET status='active'`, `broadcastTerminalSessions()`, ritorna `{id, type, claudeSessionId}`. Gestire errori → `500` con messaggio.

## 2. Client — voce "Ricarica" nel menu tab
- [x] 2.1 In `PaneTabBar.tsx`, aggiungere un `<button>` "Ricarica" (icona `RotateCw`) nel menu `createPortal` esistente, reso solo se `ctxMenu.paneId.startsWith('terminal:')`, posizionato sopra le voci Close. (Anche `data-testid="pane-tab-<paneId>"` su ogni tab per i test.)
- [x] 2.2 onClick: estrai `sessionId = ctxMenu.paneId.slice('terminal:'.length)`, `POST /api/terminal/sessions/${sessionId}/reload`, poi `setCtxMenu(null)`. (Loading state opzionale: omesso — il menu si chiude subito.)

## 3. Tests
- [x] 3.1 `tests/e2e/terminal-tab-reload.spec.ts` (Playwright) — 4 test verdi: `/reload` riavvia shell (stesso id, ancora attiva); `/reload` su id ignoto → 404; tasto-destro su tab terminale mostra "Ricarica" e il click fa `POST /reload` → 200; tasto-destro su tab chat NON mostra "Ricarica". + helper `reloadTerminalSession` in `api-fixtures.ts`.
- [~] 3.2 `bun:test` puro: non necessario — nessun helper puro estratto (logica server-side, coperta dall'E2E request-level).

## 4. Verify
- [x] 4.1 `tsc -b` clean (client) + `typecheck:server` (0 errori) — entrambi verdi.
- [x] 4.2 Smoke: shell via E2E (test-server isolato) + smoke su server live (POST /reload su /tmp usa-e-getta → 200). `claude-code` reale con `--resume`: VALIDATO sul vivo — `/reload` ha sbloccato 2 sessioni latchate ("Not logged in" → conversazione ripresa, 0 stuck su 23).
- [x] 4.3 `vite build` → `/public` + `kickstart -k` di `com.armonia.topics-server` fatti; endpoint live (404 con body `Terminal session not found`), 23 sessioni sopravvissute al restart.
- [x] 4.4 Review adversariale sul diff (race kill→exit, doppio-PTY, 404/idempotenza) — workflow eseguito.
