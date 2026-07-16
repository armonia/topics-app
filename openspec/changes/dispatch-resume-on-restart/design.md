# Design — dispatch-resume-on-restart

## Contesto (cosa sopravvive a un riavvio, cosa no)

| Componente                              | Sopravvive? | Dove |
|-----------------------------------------|-------------|------|
| Task + claim (`status`, `dispatch_state`, `assigned_topic_id`, attempts) | ✅ | SQLite `tasks` |
| Topic dell'agent (systemPrompt, worktreeId, effort, model, mcpPolicy)    | ✅ | SQLite `topics` |
| Conversazione CLI (`--resume`)          | ✅ | `claude_code_sessions` + transcript JSONL |
| Worktree con il lavoro a metà           | ✅ | disco (`worktrees` store) |
| Figlio `claude` CLI                     | ❌ | child del server, SIGTERM al shutdown |
| Driver del turno (`inFlight`, SSE drain, timeout wall-clock) | ❌ | memoria del dispatcher |

Il fix ricostruisce SOLO l'ultimo rigo, riagganciandosi a tutto il resto.

## reconcile() v2 — decision table per gli orfani

Orfano = `in_progress` + `dispatch_state ∈ {starting, working}` + `!inFlight`.

| Condizioni | Azione |
|---|---|
| `working` ∧ binding vivo (`topicExists`) ∧ autoDispatch ON | **resume-in-place**: commento di sistema + `resume(id, "", {continuation:true})` — nessun bump dei tentativi |
| `working` ∧ binding morto/assente | release + requeue + `rollbackAttempt` (com'è oggi) |
| `starting` (qualsiasi binding) | release + requeue + `rollbackAttempt` — la finestra claim→kickoff è ~ms, la sessione può essere vuota: meglio un re-claim pulito |
| autoDispatch OFF (globale) | release + requeue + `rollbackAttempt`, poi chip azzerato (`setDispatchState null`) — su una board che non dispatcha il chip `queued` non deve strandare |
| chip non attivo (null/needs_input) | intoccato (task spostato a mano dall'umano — invariato) |

## Perché resume() esistente basta

- `resume()` deriva `sessionKey = "topic:" + assignedTopicId.slice(0,8)` (stessa
  convenzione di `session-control-core.ts`), setta `inFlight` **sincronamente** prima del
  primo await → il poll-reconcile a 10s non può double-fire.
- `buildContinueNudge(task, cap)` copre già i due casi: turno normale ("riprendi da dove
  eri, get_task, non ricominciare") e last-chance a cap raggiunto ("ULTIMO TURNO,
  consegna ORA") — un orfano al cap riprende col nudge di consegna, corretto.
- `contextMode: "lean"`: la sessione riparte con `--resume` e ha già tutto l'envelope del
  kickoff in history — re-iniettarlo costerebbe cache write/read a vuoto.
- Il turno ripreso passa da `onTurnEnd` come qualsiasi altro: review/serve-te/delivered,
  oppure bump+backoff se muore, oppure deliver-to-review/park a budget esaurito. Nessun
  nuovo stato.
- Edge sessione-vuota (crash dopo il chip `working` ma prima che il kickoff raggiunga il
  CLI): il topic porta comunque il ROLE_PROMPT come systemPrompt e il nudge contiene il
  task id → `get_task` ricostruisce il mandato. Accettato (finestra ~ms).

## Interazioni verificate

- **Cap di concorrenza**: i task ripresi restano `in_progress+working` → il COUNT del
  claim CAS li conta già; il tick post-resume non può over-claimare. Se il cap è stato
  ABBASSATO durante il downtime i resumed possono momentaneamente eccederlo (erano già
  in volo prima del riavvio): accettato, nessun nuovo claim finché non scendono.
- **Crash-loop**: ogni boot costa un nudge lean per task; i commenti di sistema
  identici collassano nel dedupe window di `addComment`. I tentativi non vengono
  bumpati dal resume di riavvio, quindi un crash-loop non parcheggia task sani — è il
  comportamento già scelto per il requeue (`rollbackAttempt`), esteso al resume.
- **Usage accounting**: `resume()` ribasa `usage0` a inizio turno (delta per-turno sul
  transcript dedup-by-message-id) → nessun doppio conteggio.
- **Ordine nel boot**: parte 1 (resume/requeue orfani) è sincrona fino ai `void
  resume(...)` (inFlight settato), poi parte 2 ticka le board: gli slot occupati dai
  resumed sono già visibili al CAS.

## Test (task-dispatcher.test.ts, harness esistente)

1. working + topic vivo + autoDispatch ON → resume-in-place: stato/binding/attempts
   invariati, 1 turno lean con nudge di continuazione su `topic:<id8>`, commento di
   sistema nel thread.
2. working + topic morto (override `topicExists`) → requeue + rollback (fallback).
3. working + binding vivo ma autoDispatch OFF → requeue + chip azzerato.
4. doppio `reconcile()` col turno ancora in volo → UN solo turno (idempotente sotto poll).
5. `starting` senza binding → requeue + rollback.
6. orfano al retry-cap + topic vivo → resume con nudge last-chance (niente park).

I due test esistenti sul requeue restano verdi (non settano mai autoDispatch → gate OFF
→ percorso fallback).
