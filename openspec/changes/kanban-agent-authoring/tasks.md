# Tasks — kanban-agent-authoring

Convenzione: ogni Phase chiude con `cd client && tsc -b` verde + i test della Phase verdi.
`[ ]` = da fare, `[x]` = fatto+verificato. Nessun cambio alla UI Kanban/AllBoardsPane.

> STATO: Phase 0 + Phase 1 **fatte e verificate** — 87 test verdi (service 16 · MCP 64 ·
> routes 7), `tsc -p tsconfig.server.json` OK. Il backend è pilotabile headless via MCP
> (create/get/comment/update/list scope + gate Review). Restano: refactor DRY (0.4/0.5,
> rimandati per non toccare i file dirty), board client lean (Phase 4), auto-dispatch
> (Phase 5), endpoint human-side + E2E.

## Phase 0 — Ricognizione & fondamenta (sblocca tutto)
- [ ] 0.1 Localizzare in git (`refactor-master-into-kanban`) gli handler REST rimossi per
  `/api/sessions/:key/tasks` e `/api/boards/:pid/tasks/:tid`; documentare cosa manca.
- [ ] 0.2 Confermare come `--base-url` dell'MCP porta l'auth al server (:3333/:4000) e la
  risoluzione `:session-key → project_id` + identità agente. Annotare in design se serve header.
- [ ] 0.3 `server/services/tasks.ts` — service puro (DB iniettato): `create`, `get`
  (task+commenti+eventi), `addComment`, `listComments`, `update`, `move`. Idempotenza su
  `claude_task_id`; dedup commenti `(task_id, author, hash, finestra)`. + `bun:test`.
- [ ] 0.4 Rifattorizzare l'INSERT inline di `server/routes/chat.ts:214` per usare
  `tasks.create()` (nessun cambio di comportamento osservabile).
- [ ] 0.5 `claude-tasks-sync.ts` chiama il service invece di scrivere `tasks` da sé
  (writer unico). + test che sync e MCP non sdoppiano su `claude_task_id`.

## Phase 1 — REST + MCP authoring/discussione (KANBAN-03, KANBAN-04)
- [ ] 1.1 `server/routes/tasks.ts` (nuovo, wired in `server.ts`): `POST/GET
  /api/sessions/:key/tasks`, `GET /api/sessions/:key/tasks/:id`, `POST
  /api/sessions/:key/tasks/:id/comments`, `PATCH /api/sessions/:key/tasks/:id`. Broadcast
  WS su ogni mutazione.
- [ ] 1.2 MCP: `create_task`, `get_task`, `comment_task` — tool def + call fns + dispatch
  map in `server/mcp/topics-mcp-server.ts`. Author risolto server-side (D4).
- [ ] 1.3 MCP: `update_task` esteso (`priority`, `assignee`, `tags`, `dependencies`) oltre
  `status`. Schema tipizzato con enum.
- [ ] 1.4 Test di contratto MCP↔REST: ogni path chiamato dall'adapter esiste e risponde
  (previene la regressione "endpoint fantasma").
- [ ] 1.5 `bun:test` call-fns adapter (mapping args→path→body).

## Phase 2 — Gate di Review umano (KANBAN-05)
- [ ] 2.1 Invariante nel service: `actor=agent` + `status=done` → reject; `agent` può solo
  `→ review`, creando `approvals(approval_type='review', pending)`.
- [ ] 2.2 `review → done` consentito solo con `actor=human`; wiring con la approval modal
  esistente (`reviewed_by`, `review_comment`, `reviewed_at`).
- [ ] 2.3 Reject → `in_progress` + commento nel thread.
- [ ] 2.4 `bun:test` matrice transizioni (agent/human × ogni stato) + E2E: agente consegna
  in Review → umano approva → Done.

## Phase 3 — Feed globale + contesto pull-on-demand (KANBAN-06)
- [ ] 3.1 `list_tasks` esteso: `scope: project|all`, paginazione a cursore; `all` proietta
  il modello dati di `AllBoardsPane` (badge progetto). E2E su 2 progetti.
- [ ] 3.2 Skill "kanban context" + snippet `CLAUDE.md` di progetto: l'agente chiama
  `list_tasks(scope:project)` on-demand. Niente injection ogni turno.
- [ ] 3.3 Hook `SessionStart` di auto-inject **opzionale**, default off, toggle per-board (D6).

## Phase 4 — Board client lean, Master-free (ricostruzione)
- [ ] 4.1 `client/src/lib/api.ts`: ripristina tipi/api board lean (`BoardTask`, `TaskStatus`,
  `Approval`, `tasksApi` session-scoped) — senza `globalBoardApi`/Master.
- [ ] 4.2 Cherry-pick puliti da `42e92c1d^`: `KanbanColumn.tsx`, `ApprovalReviewModal.tsx`
  (0 ref Master) → adatta ai nuovi tipi.
- [ ] 4.3 Riscrivi puliti `KanbanBoard.tsx`, `TaskCard.tsx`, `AllBoardsPane.tsx` — niente
  Crown/lead, proposal cards, autopilot. 5 colonne + `@dnd-kit`, detail panel con thread
  commenti, badge progetto in AllBoards.
- [ ] 4.4 Ri-registra il pane board (PaneAddMenu/PaneTabBar hanno già l'icona `Kanban`);
  subscribe agli eventi WS `task:*` per il live-update.
- [ ] 4.5 E2E: create via MCP → card compare; commento → visibile; agente → Review; umano
  approva → Done; `scope:all` mostra 2 progetti.

## Phase 5 — Auto-dispatch reattivo (KANBAN-07, flag-gated)
- [ ] 4.1 Migration: `board_settings.autodispatch INTEGER DEFAULT 0`.
- [ ] 4.2 Su transizione `→ todo` con `assigned_to` = agente noto e flag on: `spawn_agent`
  con prompt-contratto (lavora N, commenta, consegna in review, mai done). Guardia
  anti-ricorsione (no dispatch se creatore è worker).
- [ ] 4.3 E2E dietro flag: task assegnato → worker spawnato → commenti → Review. Con flag
  off: nessuno spawn.

## Uscita
- [ ] Tutti gli scenari KANBAN-03..07 coperti; `tsc -b` verde; E2E verdi su `:13334`.
- [ ] `openspec archive kanban-agent-authoring` a merge fatto.
