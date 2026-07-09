# Design — kanban-agent-authoring

## Context

La Kanban nasce come board umana; il ponte verso gli agenti è oggi (a) il file-watcher
`server/services/claude-tasks-sync.ts` (Agent Teams shared task list → tabella `tasks`,
one-way file→DB, last-write-wins su `updated_at`, chiave `claude_task_id`) e (b) due tool
MCP `list_tasks`/`update_task` che puntano a endpoint **assenti**. Questo change chiude il
cerchio: rende la board un registro **bidirezionale** uomo↔agente con discussione e un
gate di consegna umano, senza toccare la UI.

Vincoli ereditati: server Bun a routing manuale (`pathname === …`), SQLite via
`db.prepare`, broadcast WebSocket per il live-update, test E2E Playwright su server isolato
`:13334` (mai il vivo `:3333`), `bun:test` solo per moduli puri.

## Decisioni

### D1 — Un service, non insert sparse
Tutta la scrittura task passa da `server/services/tasks.ts` (funzioni pure testabili +
handle DB iniettato, stessa forma di `claude-tasks-sync.ts`). `chat.ts:214` e il
file-watcher convergono qui. Motivo: oggi la create è duplicata inline; con create/comment
da MCP la duplicazione diventerebbe 3 percorsi divergenti.

### D2 — Idempotenza su `claude_task_id`, non un secondo canale
`create_task` accetta `idempotency_key` opzionale scritto in `tasks.claude_task_id` (già
UNIQUE, indice parziale). Retry dell'agente → upsert deterministico, **nessun task
fantasma**. `comment_task` deduplica su `(task_id, author, hash(content))` entro una
finestra breve. Riusa lo stesso spazio-chiave del sync → un task creato via MCP e lo stesso
task visto dal file-watcher **non si sdoppiano** (findByClaudeTaskId già esiste).

### D3 — Gate `done` umano via tabella `approvals` esistente
Nessuno schema nuovo per il gate: l'agente che "finisce" chiama `update_task(status:review)`;
il service crea `approvals(approval_type='review', status='pending')` e **rifiuta**
qualunque `update_task(status:done)` con `actor=agent`. La transizione `review→done` è
consentita solo con `actor=human` (UI approval modal → `reviewed_by`, `review_comment`,
`reviewed_at`). `board_settings.require_approval_for_done` resta il toggle per-board; se
off, l'umano può trascinare direttamente a done ma **l'agente no** (invariante forte).

### D4 — Identità agente firmata dal server, non dal client
L'author dei commenti/eventi non arriva come parametro dal tool (spoofabile): il server
risolve `:session-key → agent/session label` e lo scrive in `task_comments.author` e
`task_events`. `user` resta riservato all'umano. Motivo: la firma è un fatto di sicurezza,
non un input dell'LLM.

### D5 — `scope:all` = proiezione, non nuova UI
`list_tasks(scope:all)` restituisce il feed piatto cross-progetto con badge progetto,
esattamente il modello dati che `AllBoardsPane` già consuma. Paginazione a cursore
(`updated_at`, `id`) per risposte piccole. Nessun componente nuovo.

### D6 — Contesto: pull-on-demand default, auto-inject opt-in
Il fetch "per contesto" è un `list_tasks(scope:project)` che l'agente chiama quando serve,
guidato da una skill + una riga in `CLAUDE.md` di progetto. **Non** iniettiamo i task nel
system prompt ogni turno (costo token + rumore, contro la linea recall-pull dell'utente).
L'hook `SessionStart` di auto-inject resta disponibile ma **default off**, attivabile
per-board. (Risposta al grill: "valutiamo" → default conservativo, attivabile.)

### D7 — Auto-dispatch dietro flag, in coda
`board_settings.autodispatch` (nuova colonna, default 0). Un task che entra in `todo` con
`assigned_to` = un agente noto → il server chiama l'infra `spawn_agent` esistente con un
prompt-contratto ("lavora il task N, commenta l'avanzamento, consegna in review, non
toccare done"). Isolato in Phase 4: il resto del sistema è utile e spedibile senza.

## Rischi / mitigazioni

- **Endpoint mancanti (rischio primario).** Gli handler che l'MCP già chiama non esistono.
  → Phase 0 li localizza in cronologia git (`refactor-master-into-kanban`) e li
  ricostruisce sopra il nuovo service; test di contratto MCP↔REST per non ri-rompere.
- **Doppia scrittura sync↔MCP.** File-watcher e MCP scrivono entrambi `tasks`. → unica
  chiave `claude_task_id` + last-write-wins su `updated_at` già in `claude-tasks-sync.ts`;
  il service è l'unico writer, il watcher lo chiama invece di fare INSERT propri.
- **Auth MCP→server.** Verificare come `--base-url` porta il token di sessione (server su
  :3333/:4000 è auth-gated). → Phase 0 conferma; se serve, l'header lo aggiunge l'adapter.
- **Loop auto-dispatch.** Un agente che crea task che spawnano agenti che creano task. →
  autodispatch solo su `assigned_to` esplicito + guardia anti-ricorsione (no dispatch se il
  creatore è già un worker), default off.

## Mappa implementazione (dove tocco)

| Area | File | Azione |
|---|---|---|
| Service | `server/services/tasks.ts` (nuovo) | create/get/comment/update/move + idempotenza |
| Refactor | `server/routes/chat.ts:214` | INSERT inline → `tasks.create()` |
| REST | route session-scoped (nuovo file `server/routes/tasks.ts`, wired in `server.ts`) | GET/POST tasks, comments, PATCH, `scope` |
| MCP | `server/mcp/topics-mcp-server.ts` | +3 tool, `update_task`/`list_tasks` estesi, call fns + dispatch map |
| Gate | `server/services/tasks.ts` + `approvals` | invariante agent≠done, review approval |
| Context | skill + `CLAUDE.md` snippet + hook opz. | pull-on-demand |
| Dispatch | `board_settings.autodispatch` + hook su transizione todo | Phase 4 |

## Testing

- **`bun:test`** (moduli puri): `tasks.ts` (transizioni di stato, invariante done-gate,
  idempotenza, dedup commenti), call-fns dell'adapter MCP (mapping args→path).
- **E2E Playwright** (`:13334`): create via MCP appare in colonna → commento visibile nel
  detail panel → completamento agente ferma in Review → approvazione umana → Done;
  `scope:all` mostra task di 2 progetti con badge. Estendere `tests/e2e/`, non duplicare.
- **Contratto**: test MCP↔REST che i path chiamati dall'adapter esistano e rispondano
  (previene la regressione "endpoint fantasma").
