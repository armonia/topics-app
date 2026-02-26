# RFC: Agent Autonomy for Topix Board

> **Status**: Draft
> **Date**: 2026-02-24
> **References**:
> - [openclaw-mission-control](https://github.com/abhi1693/openclaw-mission-control)
> - [GSD Framework](https://thenewstack.io/openclaw-gsd/) — Get Stuff Done meta-prompting
> - [BMAD Method](https://medium.com/@hieutrantrung.it/a-pro-devs-ai-weapons-bmad-method-claude-task-master-on-any-coding-agent-4266f9f6f092) — Spec-Driven Development

---

## 1. Executive Summary

Topix ha oggi una board Kanban completa (task, dipendenze, approval, commenti, tag) e un sistema di agent profiles con sessioni e heartbeat. Ma tutto e' manuale: nessun agente prende task, li esegue, o li chiude autonomamente.

Questo documento descrive come trasformare la board da strumento passivo a **sistema di orchestrazione autonoma**, dove agenti Claude Code:

1. Ricevono task dalla board
2. Li eseguono nel loro workspace
3. Riportano progresso in tempo reale
4. Chiedono approvazione o escalano quando serve
5. Chiudono il task e passano al successivo

Il design si ispira a mission-control ma e' adattato alla nostra architettura (Bun + SQLite + WebSocket), senza dipendenze esterne (no Redis, no Python).

---

## 2. Architettura Attuale vs Target

### Oggi (Passivo)

```
Utente ──(crea task)──> Board ──(display)──> Kanban UI
                                              |
                                         (manuale)
                                              |
Utente ──(sposta card)──> Board ──(update)──> DB
```

### Target (Autonomo)

```
Utente ──(obiettivo in chat)──> Lead Agent
                                    |
                            (decompone in task)
                                    |
                                  Board ──────────────────────────┐
                                    |                             |
                            (assegna a worker)              (UI real-time)
                                    |                             |
                              Worker Agent                   Kanban vivo
                                    |                        (card si muovono)
                            (esegue nel workspace)                |
                                    |                        (heartbeat pulse)
                            (commenta progresso)                  |
                                    |                        (approval modal)
                            (chiede approval se serve)            |
                                    |                             |
                              task: done ─────────────────────────┘
```

---

## 3. Modello Dati - Estensioni

### 3.1 Nuove colonne su `agent_profiles`

```sql
ALTER TABLE agent_profiles ADD COLUMN agent_token_hash TEXT;
ALTER TABLE agent_profiles ADD COLUMN gateway_session_id TEXT;
ALTER TABLE agent_profiles ADD COLUMN heartbeat_config TEXT DEFAULT '{"interval_seconds":30,"missing_tolerance":120}';
ALTER TABLE agent_profiles ADD COLUMN identity_template TEXT;
ALTER TABLE agent_profiles ADD COLUMN soul_template TEXT;
ALTER TABLE agent_profiles ADD COLUMN is_board_lead INTEGER DEFAULT 0;
ALTER TABLE agent_profiles ADD COLUMN last_seen_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_profiles_token ON agent_profiles(agent_token_hash);
CREATE INDEX IF NOT EXISTS idx_agent_profiles_status ON agent_profiles(status);
```

**Spiegazione**:
- `agent_token_hash`: hash PBKDF2-SHA256 del bearer token per auth autonoma
- `gateway_session_id`: session key OpenClaw per comunicare via gateway
- `heartbeat_config`: JSON con intervallo e tolleranza
- `identity_template`: prompt di identita' (chi sei, come ti comporti)
- `soul_template`: SOUL.md content — istruzioni profonde dell'agente
- `is_board_lead`: distingue lead da worker
- `last_seen_at`: ultimo heartbeat ricevuto

### 3.2 Nuova tabella `board_memory`

```sql
CREATE TABLE IF NOT EXISTS board_memory (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',        -- JSON array: ["decision", "handoff", "webhook"]
  is_chat INTEGER DEFAULT 0,     -- 1 = chat message, 0 = durable context
  source TEXT,                   -- "agent:lead", "webhook:xyz", "user"
  agent_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_board_memory_project ON board_memory(project_id);
CREATE INDEX IF NOT EXISTS idx_board_memory_chat ON board_memory(is_chat);
```

**Scopo**: Store condiviso tra agenti per mantenere contesto tra turni. Un agente puo' scrivere decisioni, un altro leggerle. Tag per filtrare per tipo.

### 3.3 Nuove colonne su `tasks`

```sql
ALTER TABLE tasks ADD COLUMN assigned_agent_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN in_progress_at TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks(assigned_agent_id);
```

**Nota**: `assigned_to` (stringa libera) rimane per retrocompatibilita'. `assigned_agent_id` e' il riferimento tipato all'agente effettivo.

### 3.4 Nuova tabella `agent_actions_log`

```sql
CREATE TABLE IF NOT EXISTS agent_actions_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,  -- "task.claimed", "task.moved", "approval.requested", "escalation.sent"
  entity_type TEXT,           -- "task", "approval", "memory"
  entity_id TEXT,
  detail TEXT,                -- JSON con contesto extra
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_actions_agent ON agent_actions_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_actions_type ON agent_actions_log(action_type);
```

**Scopo**: Audit trail immutabile di ogni azione autonoma. Critico per debug e trust.

---

## 4. Agent API (`/api/agent/*`)

Namespace dedicato, autenticato via `X-Agent-Token` header. Ogni request aggiorna `last_seen_at`.

### 4.1 Autenticazione

```typescript
// server/middleware/agent-auth.ts

import { pbkdf2Sync, timingSafeEqual } from "crypto";

interface AgentAuthResult {
  agent: AgentProfile;
  isLead: boolean;
}

export function authenticateAgent(
  req: Request,
  db: Database
): AgentAuthResult | null {
  const token =
    req.headers.get("x-agent-token") ||
    req.headers.get("authorization")?.replace("Bearer ", "");

  if (!token) return null;

  // Hash the incoming token
  const hash = pbkdf2Sync(token, "topix-agent-salt", 100000, 64, "sha256")
    .toString("hex");

  // Find agent by hash
  const agent = db
    .prepare("SELECT * FROM agent_profiles WHERE agent_token_hash = ?")
    .get(hash) as any;

  if (!agent) return null;

  // Touch presence
  db.prepare("UPDATE agent_profiles SET last_seen_at = ? WHERE id = ?")
    .run(new Date().toISOString(), agent.id);

  return {
    agent: mapToAgentProfile(agent),
    isLead: !!agent.is_board_lead,
  };
}
```

**Token generation** (una tantum, al momento della creazione agente):

```typescript
import { randomBytes, pbkdf2Sync } from "crypto";

export function mintAgentToken(): { token: string; hash: string } {
  const token = `topix_${randomBytes(32).toString("hex")}`;
  const hash = pbkdf2Sync(token, "topix-agent-salt", 100000, 64, "sha256")
    .toString("hex");
  return { token, hash };
}
```

### 4.2 Endpoints

#### Health & Discovery

| Method | Path | Auth | Descrizione |
|--------|------|------|-------------|
| `GET` | `/api/agent/healthz` | token | Ritorna id, board, status, is_lead |
| `GET` | `/api/agent/boards` | token | Board visibili (scoped al proprio board_id) |

#### Task Operations

| Method | Path | Auth | Lead? | Descrizione |
|--------|------|------|-------|-------------|
| `GET` | `/api/agent/boards/:projectId/tasks` | token | no | Lista task con filtri: `status`, `assigned_agent_id`, `unassigned` |
| `POST` | `/api/agent/boards/:projectId/tasks` | token | si | Crea task (lead decompone obiettivo) |
| `PATCH` | `/api/agent/boards/:projectId/tasks/:taskId` | token | no | Aggiorna: status, assigned_agent_id, description |
| `DELETE` | `/api/agent/boards/:projectId/tasks/:taskId` | token | si | Elimina task |
| `POST` | `/api/agent/boards/:projectId/tasks/:taskId/claim` | token | no | Worker si assegna il task + status → in_progress |
| `POST` | `/api/agent/boards/:projectId/tasks/:taskId/complete` | token | no | Worker segna done (o crea approval se richiesto) |

#### Comments & Memory

| Method | Path | Auth | Descrizione |
|--------|------|------|-------------|
| `POST` | `/api/agent/boards/:projectId/tasks/:taskId/comments` | token | Aggiunge commento di progresso |
| `GET` | `/api/agent/boards/:projectId/memory` | token | Legge contesto condiviso |
| `POST` | `/api/agent/boards/:projectId/memory` | token | Scrive contesto (decisioni, handoff) |

#### Approvals

| Method | Path | Auth | Descrizione |
|--------|------|------|-------------|
| `POST` | `/api/agent/boards/:projectId/approvals` | token | Richiede approvazione (confidence, rubric, justification) |
| `GET` | `/api/agent/boards/:projectId/approvals` | token | Lista approvazioni pendenti |

#### Coordination

| Method | Path | Auth | Lead? | Descrizione |
|--------|------|------|-------|-------------|
| `POST` | `/api/agent/boards/:projectId/agents/:agentId/nudge` | token | si | Lead risveglia worker con messaggio |
| `POST` | `/api/agent/boards/:projectId/escalate` | token | no | Worker escala blocco a lead/utente |
| `POST` | `/api/agent/heartbeat` | token | no | Segnale di vita, aggiorna last_seen_at |

### 4.3 Claim Task Flow (dettaglio)

```typescript
// POST /api/agent/boards/:projectId/tasks/:taskId/claim

async function claimTask(req, ctx, agent) {
  const { taskId, projectId } = params;

  // 1. Verifica che il task esista e sia in inbox/todo/backlog
  const task = stmts.getTask.get(taskId);
  if (!task) return ctx.errorResponse(404, "Task not found");
  if (!["backlog", "todo", "inbox"].includes(task.status)) {
    return ctx.errorResponse(409, `Task status is ${task.status}, cannot claim`);
  }

  // 2. Verifica che non sia gia' assegnato
  if (task.assigned_agent_id && task.assigned_agent_id !== agent.id) {
    return ctx.errorResponse(409, "Task already assigned to another agent");
  }

  // 3. Verifica dipendenze (blocker check)
  const blockers = stmts.getActiveBlockers.all(taskId);
  if (blockers.length > 0) {
    return ctx.errorResponse(409, "Task is blocked", {
      details: { blockers: blockers.map(b => b.blocker_id) }
    });
  }

  // 4. Verifica max concurrent tasks per agente
  const activeTasks = stmts.countAgentActiveTasks.get(agent.id);
  if (activeTasks.count >= agent.max_concurrent_tasks) {
    return ctx.errorResponse(429, "Agent at max concurrent tasks");
  }

  // 5. Claim
  const now = new Date().toISOString();
  db.transaction(() => {
    stmts.updateTask.run({
      $id: taskId,
      $assigned_agent_id: agent.id,
      $assigned_to: agent.name,
      $fingerprint: agent.avatar_emoji,
      $status: "in_progress",
      $in_progress_at: now,
      $updated_at: now,
    });

    // Log action
    stmts.logAction.run({
      $id: crypto.randomUUID(),
      $agent_id: agent.id,
      $action_type: "task.claimed",
      $entity_type: "task",
      $entity_id: taskId,
      $detail: JSON.stringify({ from_status: task.status }),
      $created_at: now,
    });
  })();

  const updated = stmts.getTask.get(taskId);

  // 6. Broadcast
  ctx.broadcastToAll({
    type: "task:moved",
    projectId,
    task: mapTask(updated),
  });

  return ctx.json(mapTask(updated));
}
```

### 4.4 Complete Task Flow (con approval gate)

```typescript
// POST /api/agent/boards/:projectId/tasks/:taskId/complete

async function completeTask(req, ctx, agent) {
  const body = await ctx.readJSON(req);
  const { taskId, projectId } = params;

  const task = stmts.getTask.get(taskId);
  if (!task) return ctx.errorResponse(404, "Task not found");

  // Verifica ownership
  if (task.assigned_agent_id !== agent.id) {
    return ctx.errorResponse(403, "Not assigned to you");
  }

  // Controlla se serve approvazione
  const settings = stmts.getSettings.get(projectId);
  const needsApproval = settings?.require_approval_for_done;

  if (needsApproval) {
    // Crea approval request, sposta a review
    const approvalId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.transaction(() => {
      stmts.createApproval.run({
        $id: approvalId,
        $task_id: taskId,
        $requested_by: agent.name,
        $approval_type: "completion",
        $from_status: task.status,
        $to_status: "done",
        $confidence_score: body.confidence ?? null,
        $rubric_scores: body.rubricScores ? JSON.stringify(body.rubricScores) : null,
        $justification: body.justification ?? null,
        $status: "pending",
        $created_at: now,
        $expires_at: settings.auto_expire_hours
          ? new Date(Date.now() + settings.auto_expire_hours * 3600000).toISOString()
          : null,
      });

      stmts.updateTaskStatus.run({
        $id: taskId,
        $status: "review",
        $updated_at: now,
      });

      stmts.logAction.run({
        $id: crypto.randomUUID(),
        $agent_id: agent.id,
        $action_type: "approval.requested",
        $entity_type: "approval",
        $entity_id: approvalId,
        $detail: JSON.stringify({ taskId, confidence: body.confidence }),
        $created_at: now,
      });
    })();

    ctx.broadcastToAll({ type: "task:moved", projectId, task: mapTask(stmts.getTask.get(taskId)) });
    ctx.broadcastToAll({ type: "approval:created", projectId, approval: mapApproval(stmts.getApproval.get(approvalId)) });

    return ctx.json({ status: "pending_approval", approvalId });
  }

  // Nessuna approvazione richiesta: chiudi direttamente
  const now = new Date().toISOString();
  stmts.updateTask.run({
    $id: taskId,
    $status: "done",
    $completed_at: now,
    $updated_at: now,
  });

  stmts.logAction.run({
    $id: crypto.randomUUID(),
    $agent_id: agent.id,
    $action_type: "task.completed",
    $entity_type: "task",
    $entity_id: taskId,
    $detail: JSON.stringify({ direct: true }),
    $created_at: now,
  });

  ctx.broadcastToAll({ type: "task:moved", projectId, task: mapTask(stmts.getTask.get(taskId)) });
  return ctx.json({ status: "done" });
}
```

---

## 5. Agent Loop (Runtime Protocol)

Il cuore dell'autonomia. Descrive come un agente Claude Code interagisce con la board.

### 5.1 Loop Principale

```
┌─────────────────────────────────────────────────────────┐
│                    AGENT MAIN LOOP                       │
│                                                          │
│  1. POST /agent/heartbeat                                │
│  2. GET  /agent/boards/:projectId/tasks?unassigned=true  │
│     └─ Se ci sono task inbox/todo non assegnati:         │
│        3a. POST /tasks/:taskId/claim                     │
│        3b. [ESEGUI TASK nel workspace]                   │
│        3c. POST /tasks/:taskId/comments (progresso)      │
│        3d. POST /tasks/:taskId/complete                  │
│            └─ Se approval richiesta: attendi              │
│        3e. Torna a 2.                                    │
│     └─ Se non ci sono task:                              │
│        4. Aspetta N secondi, torna a 1.                  │
│                                                          │
│  Se bloccato:                                            │
│     POST /boards/:projectId/escalate                     │
│     (attendi risposta, poi riprendi)                     │
│                                                          │
│  Se nudge ricevuto:                                      │
│     Risveglia, rileggi task assegnati, riprendi          │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Lead Agent Loop

Il lead ha un loop diverso: non esegue task, li gestisce.

```
┌──────────────────────────────────────────────────────────┐
│                    LEAD AGENT LOOP                        │
│                                                           │
│  1. Riceve obiettivo (da chat utente o webhook)           │
│  2. Decompone in task con dipendenze                      │
│     POST /tasks (x N)                                     │
│     POST /tasks/:id/dependencies                          │
│  3. Assegna task a worker disponibili                     │
│     PATCH /tasks/:id { assigned_agent_id: workerId }      │
│  4. Monitora progresso                                    │
│     GET /tasks?status=in_progress                         │
│  5. Se worker stale:                                      │
│     POST /agents/:agentId/nudge                           │
│  6. Se tutti i task done:                                 │
│     POST /boards/:projectId/memory (summary)              │
│     Notifica utente                                       │
│  7. Se approval pending:                                  │
│     Notifica utente via WebSocket                         │
└──────────────────────────────────────────────────────────┘
```

### 5.3 Worker SOUL Template (esempio)

```markdown
# Worker Agent Identity

Tu sei un agente worker nel sistema Topix.

## Comportamento
- Quando ricevi un task, LEGGILO attentamente prima di agire
- Lavora nel workspace del progetto, non fuori
- Commenta il progresso ogni step significativo
- Se sei bloccato per >2 minuti, ESCALA immediatamente
- NON modificare file fuori dal progetto assegnato
- NON fare push su branch main/master
- NON eliminare file senza approvazione

## Ciclo di lavoro
1. Leggi il task (titolo + descrizione + commenti)
2. Leggi la board memory per contesto
3. Pianifica l'approccio (commenta il piano)
4. Esegui step by step
5. Commenta il progresso dopo ogni step
6. Quando finito, chiama /complete con confidence e justification

## Limiti
- Max 1 task alla volta
- Max 30 minuti per task (poi escala)
- Solo file nel workspace del progetto
- Nessuna azione distruttiva senza approval
```

---

## 6. Gateway Integration

### 6.1 Come connettere agenti a Topix

Topix gia' comunica col gateway OpenClaw via `GATEWAY_URL` e `GATEWAY_TOKEN`. Il pattern e':

```
Topix Server ──(HTTP/SSE)──> OpenClaw Gateway ──> Claude Code Session
```

Per l'autonomia, il flusso diventa bidirezionale:

```
Topix Server ──(assign task via WS)──> Agent Session
Agent Session ──(HTTP + X-Agent-Token)──> Topix Agent API
```

### 6.2 Agent Session Bootstrap

Quando un agente viene creato e provisionato:

1. **Topix** genera un `agent_token` e salva l'hash in DB
2. **Topix** avvia una sessione OpenClaw via gateway con il SOUL template
3. La sessione riceve come contesto iniziale:
   - L'URL dell'API Topix (`http://localhost:3333/api/agent`)
   - Il suo `agent_token`
   - Il `project_id` della board
   - Le istruzioni dal `soul_template`
4. La sessione Claude Code inizia il suo loop

### 6.3 Nudge via Gateway

```typescript
// server/services/gateway-dispatch.ts

export async function nudgeAgent(
  ctx: AppContext,
  agent: AgentProfile,
  message: string
): Promise<boolean> {
  if (!agent.gateway_session_id) return false;

  const res = await fetch(`${ctx.GATEWAY_URL}/sessions/${agent.gateway_session_id}/message`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ctx.GATEWAY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      role: "user",
      content: `[NUDGE from lead] ${message}`,
    }),
  });

  return res.ok;
}
```

---

## 7. WebSocket Events (nuovi)

### 7.1 Agent Events

```typescript
// Agente cambia stato
{ type: "agent:status", agentId, status, lastSeenAt }

// Agente claim-a un task
{ type: "agent:task_claimed", agentId, taskId, projectId }

// Agente completa un task
{ type: "agent:task_completed", agentId, taskId, projectId }

// Agente escala
{ type: "agent:escalation", agentId, taskId, projectId, message }

// Heartbeat ricevuto (per UI pulse)
{ type: "agent:heartbeat", agentId, timestamp }

// Memory aggiunta
{ type: "board:memory_added", projectId, memory: BoardMemory }
```

### 7.2 UI Updates

Questi eventi vengono consumati da:
- **KanbanBoard**: card si muovono automaticamente, fingerprint/pulse aggiornati
- **AgentsPane**: status real-time, heartbeat timeline
- **ChatPanel**: escalation appare come messaggio nella chat del topic

---

## 8. UI Changes

### 8.1 TaskCard - Indicatore Live

```
┌─────────────────────────────┐
│ 🔴 Refactor auth module     │  ← priority dot
│ ┌───┐                       │
│ │🤖│ Agent: claude-worker-1 │  ← fingerprint + pulse
│ │ ● │ Working for 3m 42s    │  ← heartbeat timer
│ └───┘                       │
│ #auth #refactor             │  ← tags
│ ⏱ Due: Mar 1               │
│ 🔒 Blocked by: #task-setup  │  ← se bloccato
└─────────────────────────────┘
```

Il `●` pulsa (CSS animation) ogni volta che arriva un heartbeat. Se l'agente va offline, diventa grigio.

### 8.2 Board Memory Panel

Nuovo tab nel TaskDetailPanel o pane dedicato:

```
┌─ Board Memory ──────────────────────────┐
│ 🏷 decision | 2 min ago | agent:lead     │
│ "Deciso di usare JWT invece di session   │
│  cookies per il modulo auth."            │
│                                          │
│ 🏷 handoff | 5 min ago | agent:worker-1  │
│ "Task parzialmente completato. Manca il  │
│  test per il refresh token. File:        │
│  src/auth/refresh.ts linea 42."         │
│                                          │
│ 🏷 plan | 10 min ago | agent:lead        │
│ "Piano: 1) setup deps 2) auth module    │
│  3) tests 4) integration"               │
└──────────────────────────────────────────┘
```

### 8.3 Escalation Toast

Quando un agente escala, appare un toast nella UI:

```
┌──────────────────────────────────────────┐
│ 🤖 claude-worker-1 needs help            │
│                                          │
│ "Cannot resolve dependency conflict      │
│  between jose@5.0 and jsonwebtoken@9.    │
│  Which library should I use?"            │
│                                          │
│ [Open Chat]  [View Task]  [Dismiss]      │
└──────────────────────────────────────────┘
```

### 8.4 Approval Review con Contesto Agente

Il modal di approvazione mostra informazioni aggiuntive dall'agente:

```
┌── Approval Request ──────────────────────┐
│                                          │
│ Task: "Add JWT auth middleware"           │
│ Agent: claude-worker-1                   │
│ Status: in_progress → done               │
│                                          │
│ Confidence: 87%  ████████░░              │
│                                          │
│ Rubric:                                  │
│   Code quality:    ★★★★☆  (4/5)         │
│   Test coverage:   ★★★☆☆  (3/5)         │
│   Documentation:   ★★★★★  (5/5)         │
│                                          │
│ Justification:                           │
│ "Middleware implementato con test per     │
│  tutti gli edge case. Coverage al 78%.   │
│  Manca test per token expired con        │
│  clock skew >5s, edge case raro."        │
│                                          │
│ [Approve ✓]  [Reject ✗]  [Comment]       │
└──────────────────────────────────────────┘
```

---

## 9. Fasi di Implementazione

### Fase 1: Agent Auth & API Foundation

**Obiettivo**: Gli agenti possono autenticarsi e interagire con la board.

**Modifiche**:
1. Migration `002-agent-autonomy.sql` — nuove colonne e tabelle (sezione 3)
2. `server/middleware/agent-auth.ts` — autenticazione token
3. `server/routes/agent-api.ts` — endpoint `/api/agent/*`
4. Aggiornare `server.ts` — montare il nuovo router

**Deliverable**: Un agente puo' fare `curl -H "X-Agent-Token: ..." /api/agent/healthz` e ricevere il suo profilo.

### Fase 2: Task Claim & Complete

**Obiettivo**: Un agente puo' claim-are, aggiornare, e completare task.

**Modifiche**:
1. Endpoint `POST /api/agent/boards/:projectId/tasks/:taskId/claim`
2. Endpoint `POST /api/agent/boards/:projectId/tasks/:taskId/complete`
3. Blocker check sulle transizioni
4. Approval gate integration
5. WebSocket broadcast per ogni cambio

**Deliverable**: Un agente puo' ciclare: poll → claim → update → complete.

### Fase 3: Board Memory

**Obiettivo**: Agenti possono leggere/scrivere contesto condiviso.

**Modifiche**:
1. Tabella `board_memory`
2. Endpoint GET/POST su `/api/agent/boards/:projectId/memory`
3. UI: Board Memory panel/tab
4. WebSocket event `board:memory_added`

**Deliverable**: Un agente scrive una decisione, un altro la legge nel turno successivo.

### Fase 4: Lead Orchestration

**Obiettivo**: L'agente lead decompone obiettivi in task e coordina worker.

**Modifiche**:
1. Endpoint per creazione task in batch (lead only)
2. Endpoint nudge per risvegliare worker
3. Escalation endpoint per worker
4. Lead loop con monitoraggio progresso

**Deliverable**: Utente scrive obiettivo → lead crea task → worker li eseguono.

### Fase 5: Gateway Bridge

**Obiettivo**: Topix puo' avviare e comunicare con sessioni Claude Code.

**Modifiche**:
1. `server/services/gateway-dispatch.ts` — send message, nudge, bootstrap
2. Agent provisioning flow (crea sessione, inietta token + soul)
3. Integrazione col gateway gia' configurato (`GATEWAY_URL`)

**Deliverable**: Agente provisionato automaticamente con sessione Claude Code attiva.

### Fase 6: UI Live Board

**Obiettivo**: La board riflette l'attivita' degli agenti in tempo reale.

**Modifiche**:
1. TaskCard: heartbeat pulse, agent indicator, working timer
2. Escalation toast notifications
3. Board Memory panel
4. Approval modal con contesto agente (confidence, rubric)
5. Agent status indicators nell'AgentsPane

**Deliverable**: Kanban board "viva" con card che si muovono da sole.

---

## 10. Piano di Test (YOLO-Safe)

Test progettati per essere eseguiti da un agente Claude Code in modalita' YOLO (auto-approve) **senza causare danni**. Ogni test e' isolato, non distruttivo, e ripulisce dopo di se'.

### 10.1 Principi di Sicurezza Test

```
REGOLE PER L'AGENTE TESTER:
1. MAI toccare dati di produzione — usa solo ID/project prefissati con "test_"
2. MAI fare push git
3. MAI cancellare file fuori da /tmp
4. MAI modificare migration gia' applicate
5. Ogni test crea i propri dati e li pulisce alla fine
6. Timeout massimo 30s per singolo test
7. Se un test fallisce, logga l'errore e vai avanti (non bloccarti)
8. Scrivi i risultati in un file report, non modificare codice sorgente
```

### 10.2 Test Suite

Tutti i test usano `curl` o `fetch` diretto contro `http://localhost:3333`. Non serve un test runner esterno. L'agente esegue i comandi e verifica gli output.

---

#### TEST GROUP 1: Agent Authentication

```bash
# Test 1.1: Genera token e verifica hash
# Setup: crea profilo agente via API standard con token hash
# Assert: il token raw produce lo stesso hash

# Test 1.2: Auth con token valido
curl -s -H "X-Agent-Token: $TOKEN" http://localhost:3333/api/agent/healthz
# Assert: 200 con { ok: true, agent_id: "...", status: "..." }

# Test 1.3: Auth con token invalido
curl -s -H "X-Agent-Token: bad_token" http://localhost:3333/api/agent/healthz
# Assert: 401

# Test 1.4: Auth senza token
curl -s http://localhost:3333/api/agent/healthz
# Assert: 401

# Test 1.5: last_seen_at aggiornato dopo request
# GET healthz → controlla last_seen_at nel profilo → deve essere ~now

# Cleanup: elimina profilo test
```

---

#### TEST GROUP 2: Task Claim Flow

```bash
# Setup: crea progetto test, agente test, 3 task (inbox, todo, in_progress)

# Test 2.1: Claim task in inbox
POST /api/agent/boards/test_project/tasks/$TASK_INBOX_ID/claim
# Assert: 200, status="in_progress", assigned_agent_id=$AGENT_ID

# Test 2.2: Claim task gia' in_progress (fallisce)
POST /api/agent/boards/test_project/tasks/$TASK_INPROG_ID/claim
# Assert: 409 "Task status is in_progress, cannot claim"

# Test 2.3: Claim task assegnato ad altro agente (fallisce)
# Setup: crea secondo agente, assegna task
POST /api/agent/boards/test_project/tasks/$TASK_ASSIGNED_ID/claim (con token agente 1)
# Assert: 409 "Task already assigned to another agent"

# Test 2.4: Claim con max_concurrent_tasks raggiunto
# Setup: agent con max_concurrent_tasks=1, gia' 1 task in_progress
POST /api/agent/boards/test_project/tasks/$TASK2_ID/claim
# Assert: 429 "Agent at max concurrent tasks"

# Test 2.5: Claim con blocker attivo (fallisce)
# Setup: task A (todo) blocked by task B (todo, non done)
POST /api/agent/boards/test_project/tasks/$TASK_A_ID/claim
# Assert: 409 "Task is blocked"

# Test 2.6: Claim con blocker done (successo)
# Setup: task A (todo) blocked by task B (done)
POST /api/agent/boards/test_project/tasks/$TASK_A_ID/claim
# Assert: 200

# Cleanup: elimina task e agenti test
```

---

#### TEST GROUP 3: Task Complete Flow

```bash
# Setup: agente test + task in_progress assegnato

# Test 3.1: Complete senza approval gate
# Setup: board_settings.require_approval_for_done = 0
POST /api/agent/boards/test_project/tasks/$TASK_ID/complete
  Body: { "justification": "Test complete" }
# Assert: 200, { status: "done" }
# Verify: task.status = "done", task.completed_at != null

# Test 3.2: Complete con approval gate
# Setup: board_settings.require_approval_for_done = 1
POST /api/agent/boards/test_project/tasks/$TASK2_ID/complete
  Body: { "confidence": 85, "justification": "High confidence" }
# Assert: 200, { status: "pending_approval", approvalId: "..." }
# Verify: task.status = "review" (non done!)
# Verify: approval creata con status="pending"

# Test 3.3: Complete task non assegnato a te (fallisce)
POST /api/agent/boards/test_project/tasks/$OTHER_TASK_ID/complete (con token sbagliato)
# Assert: 403 "Not assigned to you"

# Test 3.4: Approval approved → task diventa done
POST /api/approvals/$APPROVAL_ID/approve { "comment": "LGTM" }
# Assert: task.status = "done"

# Test 3.5: Approval rejected → task resta review
POST /api/approvals/$APPROVAL_ID2/reject { "comment": "Fix tests" }
# Assert: task.status = "review"

# Cleanup: elimina tutto
```

---

#### TEST GROUP 4: Board Memory

```bash
# Setup: agente test + progetto test

# Test 4.1: Crea memory entry
POST /api/agent/boards/test_project/memory
  Body: { "content": "Decision: use JWT", "tags": ["decision"], "source": "agent:test" }
# Assert: 200 con id, content, tags, created_at

# Test 4.2: Leggi memory
GET /api/agent/boards/test_project/memory
# Assert: contiene l'entry creata

# Test 4.3: Filtra per is_chat
POST /api/agent/boards/test_project/memory
  Body: { "content": "Chat message", "is_chat": true }
GET /api/agent/boards/test_project/memory?is_chat=false
# Assert: NON contiene il chat message
GET /api/agent/boards/test_project/memory?is_chat=true
# Assert: contiene il chat message

# Test 4.4: Memory con tag multipli
POST /api/agent/boards/test_project/memory
  Body: { "content": "Handoff note", "tags": ["handoff", "auth-module"] }
# Assert: tags salvati correttamente

# Cleanup: elimina entries test
```

---

#### TEST GROUP 5: Lead-Only Operations

```bash
# Setup: lead agent + worker agent

# Test 5.1: Worker prova a creare task (fallisce)
POST /api/agent/boards/test_project/tasks (con token worker)
  Body: { "text": "Should fail" }
# Assert: 403

# Test 5.2: Lead crea task (successo)
POST /api/agent/boards/test_project/tasks (con token lead)
  Body: { "text": "Lead created task", "status": "todo" }
# Assert: 201

# Test 5.3: Worker prova a eliminare task (fallisce)
DELETE /api/agent/boards/test_project/tasks/$TASK_ID (con token worker)
# Assert: 403

# Test 5.4: Lead elimina task (successo)
DELETE /api/agent/boards/test_project/tasks/$TASK_ID (con token lead)
# Assert: 200

# Test 5.5: Worker prova nudge (fallisce)
POST /api/agent/boards/test_project/agents/$WORKER_ID/nudge (con token worker)
# Assert: 403

# Test 5.6: Lead nudge worker (successo o 200 anche senza gateway)
POST /api/agent/boards/test_project/agents/$WORKER_ID/nudge (con token lead)
  Body: { "message": "Wake up!" }
# Assert: 200 (o 503 se gateway non disponibile, ma non errore auth)

# Cleanup: elimina agenti e task test
```

---

#### TEST GROUP 6: Heartbeat & Liveness

```bash
# Setup: agente test con status "available"

# Test 6.1: Heartbeat aggiorna last_seen_at
POST /api/agent/heartbeat (con token agente)
# Assert: 200
# Verify: agent.last_seen_at ~ now (entro 2s)

# Test 6.2: Status diventa "online" dopo heartbeat
# Verify: agent.status = "online" o "available" (non "offline")

# Test 6.3: Stale detection
# Setup: agente con last_seen_at = 3 minuti fa
# Trigger: heartbeat checker run
# Verify: agent.status = "offline"

# Test 6.4: Recovery dopo stale
POST /api/agent/heartbeat (con token agente stale)
# Verify: agent.status torna "online"

# Cleanup: elimina agente test
```

---

#### TEST GROUP 7: Agent Actions Log (Audit)

```bash
# Setup: agente + task

# Test 7.1: Claim crea action log
POST /api/agent/boards/test_project/tasks/$TASK_ID/claim
GET /api/agent/boards/test_project/actions?agent_id=$AGENT_ID
# Assert: contiene entry con action_type="task.claimed", entity_id=$TASK_ID

# Test 7.2: Complete crea action log
POST /api/agent/boards/test_project/tasks/$TASK_ID/complete
GET /api/agent/boards/test_project/actions?agent_id=$AGENT_ID
# Assert: contiene entry con action_type="task.completed"

# Test 7.3: Approval request crea action log
# Assert: contiene entry con action_type="approval.requested"

# Cleanup
```

---

#### TEST GROUP 8: WebSocket Events

```bash
# Questo test richiede un WS client. L'agente puo' usare un semplice script Bun:

# test-ws-events.ts (file temporaneo in /tmp)
const ws = new WebSocket("ws://localhost:3333/ws");
const events: any[] = [];
ws.onmessage = (e) => events.push(JSON.parse(e.data));

// Attendi connessione, poi triggera azioni:
// 1. Claim task via API
// 2. Verifica che events contiene { type: "task:moved" }
// 3. Complete task via API
// 4. Verifica che events contiene { type: "task:moved", task: { status: "done" } }
// 5. Crea memory entry
// 6. Verifica che events contiene { type: "board:memory_added" }

ws.close();
// Assert: tutti gli eventi ricevuti correttamente
```

---

#### TEST GROUP 9: Concurrency & Edge Cases

```bash
# Test 9.1: Due agenti claim-ano lo stesso task contemporaneamente
# Setup: task in inbox, 2 agenti
# Lancia 2 POST /claim in parallelo
# Assert: esattamente UNO dei due riceve 200, l'altro 409

# Test 9.2: Complete su task gia' done (idempotente)
POST /api/agent/boards/test_project/tasks/$DONE_TASK_ID/complete
# Assert: 409 o 200 idempotente (definire comportamento)

# Test 9.3: Heartbeat sotto carico
# 10 heartbeat in rapida successione
# Assert: tutti 200, last_seen_at = ultimo

# Test 9.4: Claim task, poi agente va offline, altro agente puo' re-claim?
# Setup: task assegnato a agente offline
# Expected: definire policy (auto-unassign dopo timeout? o serve lead?)
```

---

#### TEST GROUP 10: Integration Test End-to-End

```bash
# Il test piu' importante. Simula un ciclo completo:

# 1. Crea lead agent + worker agent (con token)
# 2. Lead crea 3 task con dipendenze:
#    Task A (todo) → nessun blocker
#    Task B (todo) → blocked by A
#    Task C (todo) → blocked by B
# 3. Worker poll-a: vede solo Task A (unico non bloccato)
# 4. Worker claim-a Task A → in_progress
# 5. Worker commenta progresso
# 6. Worker completa Task A → done
# 7. Worker poll-a: ora vede Task B (sbloccato)
# 8. Worker claim-a Task B → in_progress
# 9. Worker completa Task B → done
# 10. Worker claim-a Task C → in_progress
# 11. Board_settings.require_approval_for_done = 1
# 12. Worker completa Task C → review + approval pending
# 13. Utente approva → Task C → done
# 14. Verifica: tutti e 3 i task sono done
# 15. Verifica: agent_actions_log ha 6+ entries (3 claim + 3 complete)
# 16. Cleanup: elimina tutto

# Questo test valida l'intero flusso senza bisogno del gateway.
# L'agente tester agisce sia come worker (via API) sia come utente (approve).
```

### 10.3 Script Runner per l'Agente

L'agente tester deve creare un file `/tmp/topix-agent-tests.ts` ed eseguirlo con `bun run`. Il file contiene:

```typescript
// /tmp/topix-agent-tests.ts
// Framework minimale, zero dipendenze esterne

const BASE = "http://localhost:3333/api";
const RESULTS: { name: string; pass: boolean; error?: string }[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    RESULTS.push({ name, pass: true });
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    RESULTS.push({ name, pass: false, error: e.message });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function api(path: string, opts?: RequestInit & { token?: string }) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts?.token) headers["X-Agent-Token"] = opts.token;
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { ...headers, ...opts?.headers } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ... test groups qui ...

// Report finale
async function main() {
  console.log("\n=== Topix Agent Autonomy Tests ===\n");
  // Run all groups
  await testGroup1_Auth();
  await testGroup2_Claim();
  // ... etc

  const passed = RESULTS.filter(r => r.pass).length;
  const failed = RESULTS.filter(r => !r.pass).length;
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  // Scrivi report
  await Bun.write("/tmp/topix-test-report.json", JSON.stringify(RESULTS, null, 2));
  console.log("Report: /tmp/topix-test-report.json");
}

main();
```

### 10.4 Comandi per l'Agente Tester

L'agente in YOLO mode deve eseguire:

```bash
# 1. Verifica che il server sia up
curl -s http://localhost:3333/api/status | jq .

# 2. Scrivi il file di test (in /tmp, non nel progetto!)
# ... scrive /tmp/topix-agent-tests.ts

# 3. Esegui
cd /tmp && bun run topix-agent-tests.ts

# 4. Leggi il report
cat /tmp/topix-test-report.json | jq '.[] | select(.pass == false)'

# 5. Se ci sono fallimenti, analizza e fixa il codice sorgente
# 6. Ri-esegui i test
# 7. Ripeti fino a tutti verdi
```

---

## 11. Rischi e Mitigazioni

| Rischio | Probabilita' | Impatto | Mitigazione |
|---------|-------------|---------|-------------|
| Agente impazzisce e crea 1000 task | Media | Alto | `max_concurrent_tasks` per agente + rate limit su API agent |
| Agente modifica file fuori progetto | Bassa | Critico | SOUL template con restrizioni + workspace sandboxing |
| Loop infinito claim/complete | Media | Medio | Timeout per task (30min) + stale detection |
| Token agente leaked | Bassa | Alto | Token hashato, rotazione supportata, scope limitato |
| DB lock sotto carico agenti | Media | Medio | WAL mode gia' attivo + prepared statements |
| Agente bypassa approval | Bassa | Alto | Check server-side, non fidarsi del client |

---

## 12. Metriche di Successo

Dopo l'implementazione, il dashboard dovra' mostrare:

- **Task throughput**: task completati/giorno (target: 10x rispetto a manuale)
- **Cycle time**: tempo medio inbox→done (target: <30min per task semplice)
- **Escalation rate**: % task che richiedono intervento umano (target: <20%)
- **Approval acceptance rate**: % approval approvate al primo tentativo (target: >80%)
- **Agent uptime**: % tempo in cui almeno 1 agente e' online (target: >95%)
- **Memory utilization**: entries di board memory create/lette per ciclo

---

## 13. Board Globale vs Per-Progetto

### 13.1 Problema Attuale

La board e' oggi scoped a un singolo `projectId` e appare nel menu `+` come pane aggiungibile. Questo ha due problemi:

1. **Non c'e' vista globale**: se lavori su 3 progetti, devi aprire 3 board separate
2. **Non dovrebbe essere "creabile"**: la board e' strutturale, non un pane arbitrario

### 13.2 Design Target

```
┌─────────────────────────────────────────────┐
│            BOARD GLOBALE (fuori progetto)    │
│                                             │
│  Filtro: [Tutti] [Progetto A] [Progetto B]  │
│                                             │
│  backlog │ todo │ in_progress │ review │ done│
│  ────────┼──────┼─────────────┼────────┼─────│
│  Task A  │ T. D │ Task F (A)  │ Task H │ T.K│
│  (Proj A)│(Pr B)│ (Proj A)    │ (Pr B) │(PrA│
│  Task B  │ T. E │ Task G (B)  │        │    │
│  (Proj B)│(Pr A)│             │        │    │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│       BOARD PROGETTO (dentro progetto A)     │
│                                             │
│  Solo task di Progetto A                    │
│  (stesso componente, prop projectId filtra) │
└─────────────────────────────────────────────┘
```

### 13.3 Modifiche Necessarie

**Server** (`server/routes/boards.ts`):
- `GET /api/boards/tasks` (senza `:projectId`) → ritorna tutti i task, con `projectId` in ogni record
- `GET /api/boards/:projectId/tasks` → comportamento attuale (filtrato)

**Client** (`KanbanBoard.tsx`):
- Prop `projectId` opzionale: se assente, mostra vista globale
- Aggiungere filtro per progetto nella toolbar
- Ogni TaskCard mostra il nome progetto nella vista globale

**Client** (`ProjectWindow.tsx`):
- Rimuovere `'board'` dalla lista `types` in `availableTypesForGroup` (linea 666)
- La board deve essere un tab fisso nel `PaneTabBar`, non aggiungibile dal menu `+`
- Fuori da un progetto: board globale accessibile dalla sidebar o da un tab dedicato

**Client** (`paneConfig.ts`):
- Mantenere `singleton: true` per `board`
- Aggiungere flag `fixed: true` per indicare che non e' aggiungibile manualmente

### 13.4 Comportamento Tab

| Contesto | Board visibile | Filtro default |
|----------|---------------|----------------|
| Dentro progetto A | Tab "Board" fisso | Solo task di progetto A |
| Vista globale (sidebar) | Tab "Board" nella utility area | Tutti i task, raggruppabili per progetto |
| Nessun progetto aperto | Board globale | Tutti i task |

---

## 14. Integrazione GSD/BMAD per il Worker Loop

### 14.1 Cos'e' GSD

[GSD (Get Stuff Done)](https://thenewstack.io/openclaw-gsd/) e' un framework di meta-prompting per Claude Code che combatte il **context rot** (degradazione della qualita' man mano che il contesto si riempie). Il suo approccio:

1. **PLANNING**: analisi gap + generazione TODO list prioritizzata
2. **BUILDING**: implementa task + esegui test
3. **LOOP**: ripeti fino a completamento

Regola chiave: **max 3 task per piano**, ogni task in un **sub-agent con contesto pulito** (200k token freschi).

### 14.2 Come si mappa sul nostro sistema

| GSD Concept | Topix Mapping |
|-------------|---------------|
| Planning phase | Lead Agent decompone obiettivo in task sulla board |
| Building phase | Worker Agent esegue singolo task |
| Fresh context per task | Ogni worker claim = nuova sessione Claude Code |
| Max 3 tasks per plan | Lead crea batch di max 3 task alla volta, poi rivaluta |
| Commit per task | Worker committa al complete di ogni task |
| Gap analysis | Lead legge board memory + stato task per capire cosa manca |

### 14.3 Worker Loop ispirato a GSD

```
┌──────────────────────────────────────────────────────┐
│                 GSD-INSPIRED WORKER LOOP              │
│                                                       │
│  Per ogni task assegnato:                             │
│                                                       │
│  1. CONTEXT LOAD (contesto pulito)                    │
│     - Leggi task description + commenti               │
│     - Leggi board memory (tag: "decision", "plan")    │
│     - Leggi file rilevanti nel workspace              │
│                                                       │
│  2. PLAN (commenta sulla task card)                   │
│     - "Piano: 1) ... 2) ... 3) ..."                  │
│     - Max 3 sub-step per task                         │
│                                                       │
│  3. BUILD (esegui step by step)                       │
│     - Implementa                                      │
│     - Esegui test dopo ogni step                      │
│     - Commenta progresso: "Step 1/3 done: ..."       │
│                                                       │
│  4. VERIFY                                            │
│     - Run full test suite                             │
│     - Calcola confidence (% test passing)             │
│     - Se confidence < 70%: escala, non completare     │
│                                                       │
│  5. COMPLETE                                          │
│     - Git commit con riferimento al task              │
│     - POST /complete con confidence + rubric          │
│     - Scrivi handoff note in board memory             │
│                                                       │
│  6. CONTEXT RESET                                     │
│     - Sessione terminata                              │
│     - Prossimo task = nuova sessione pulita           │
└──────────────────────────────────────────────────────┘
```

### 14.4 Lead Loop ispirato a GSD

```
┌──────────────────────────────────────────────────────┐
│                 GSD-INSPIRED LEAD LOOP                 │
│                                                        │
│  Riceve obiettivo dall'utente                          │
│                                                        │
│  1. GAP ANALYSIS                                       │
│     - Leggi codebase corrente                          │
│     - Leggi board memory per decisioni precedenti      │
│     - Identifica delta tra stato attuale e obiettivo   │
│                                                        │
│  2. PLAN (max 3 task per batch)                        │
│     - Crea task con dipendenze                         │
│     - Scrivi piano in board memory (tag: "plan")       │
│     - Assegna a worker disponibili                     │
│                                                        │
│  3. MONITOR                                            │
│     - Poll stato task ogni 30s                         │
│     - Se worker stale > 2min: nudge                    │
│     - Se worker escala: rispondi o escala a utente     │
│                                                        │
│  4. EVALUATE (dopo batch completato)                   │
│     - Leggi board memory (handoff notes dai worker)    │
│     - Rivaluta: servono altri task?                    │
│     - Se si: torna a 2. (nuovo batch di max 3)        │
│     - Se no: scrivi summary in memory, notifica utente │
│                                                        │
│  5. CONTEXT CONTINUITY                                 │
│     - Lead puo' mantenere sessione lunga               │
│     - Ma usa board memory come "external memory"       │
│     - Ogni batch e' auto-contenuto grazie alla memory  │
└──────────────────────────────────────────────────────┘
```

### 14.5 BMAD: Quando serve

[BMAD](https://medium.com/@hieutrantrung.it/a-pro-devs-ai-weapons-bmad-method-claude-task-master-on-any-coding-agent-4266f9f6f092) e' utile per la fase iniziale di **spec definition** — quando l'obiettivo e' vago e serve struttura. Nel nostro sistema:

- **BMAD** → utente descrive feature ad alto livello → lead genera spec/PRD → salva in board memory come reference document
- **GSD** → lead decompone spec in task → worker eseguono

Non servono come dipendenze esterne, ma come **pattern** codificati nel SOUL template del lead e dei worker.

### 14.6 SOUL Template aggiornato (Lead con GSD)

```markdown
# Lead Agent — GSD Pattern

Tu sei il lead agent del progetto. Coordini il lavoro degli altri agenti.

## Metodo: GSD (Get Stuff Done)

### Regole ferree
- MAX 3 task per batch. Mai di piu'.
- Ogni task deve essere completabile in <30 minuti da un worker.
- Se un task e' troppo grande, scomponilo.
- Ogni task deve avere: titolo chiaro, descrizione con acceptance criteria, dipendenze.

### Ciclo
1. **Gap Analysis**: leggi lo stato attuale (board memory + codebase)
2. **Plan**: crea max 3 task, scrivi il piano in board memory
3. **Assign**: assegna a worker disponibili
4. **Monitor**: controlla progresso, nudge se stale, rispondi a escalation
5. **Evaluate**: dopo il batch, valuta se servono altri task
6. **Repeat o Complete**: se l'obiettivo e' raggiunto, scrivi summary e notifica

### Board Memory
- Scrivi sempre con tag appropriati: "plan", "decision", "summary"
- Leggi sempre le handoff note dei worker prima di creare nuovi task
- La memory e' la tua "external brain" — usala per combattere il context rot
```

---

## 15. Appendice A: Mapping Topix ↔ Mission Control

> **Repo locale**: `.reference/openclaw-mission-control/` (gitignored, solo riferimento)
> File chiave: `backend/app/api/agent.py`, `backend/app/models/agents.py`, `backend/app/services/openclaw/`

| Concetto | Mission Control | Topix (attuale) | Topix (target) |
|----------|----------------|-----------------|----------------|
| Agent identity | `agents` table + `agent_token_hash` | `agent_profiles` (no token) | `agent_profiles` + `agent_token_hash` |
| Agent auth | `X-Agent-Token` + PBKDF2 | Nessuna | `X-Agent-Token` + PBKDF2 |
| Task polling | `GET /agent/boards/{id}/tasks` | Solo UI manuale | `GET /api/agent/boards/:id/tasks` |
| Task claim | `PATCH /tasks/{id}` | Solo drag UI | `POST /tasks/:id/claim` |
| Board memory | `board_memory` table | Non esiste | `board_memory` table |
| Gateway dispatch | `GatewayDispatchService` | Solo chat streaming | `gateway-dispatch.ts` bidirezionale |
| Lead/Worker | `is_board_lead` flag | `role: lead\|worker` | `is_board_lead` + role enforcement |
| Nudge | `POST /agents/{id}/nudge` | Non esiste | `POST /agents/:id/nudge` |
| Webhook → Agent | Redis queue → gateway | Webhook outbound only | Direct dispatch (no Redis, Bun queue) |
| Approval | `approvals` table | `approvals` table (identico) | + confidence/rubric dal worker |
| Skills | `MarketplaceSkill` + `SkillPack` | Non esiste | Fuori scope (fase futura) |
| Fingerprints | `TaskFingerprint` (content hash) | `fingerprint` (emoji) | Mantenere emoji + aggiungere hash opzionale |
| Onboarding | `BoardOnboardingSession` | Non esiste | Fuori scope (fase futura) |

---

## 16. File da Creare/Modificare

### Nuovi file
- `server/db/migrations/002-agent-autonomy.sql`
- `server/middleware/agent-auth.ts`
- `server/routes/agent-api.ts`
- `server/services/gateway-dispatch.ts`

### File da modificare
- `server.ts` — montare `agentApiRouter`
- `server/types.ts` — nuovi tipi (`AgentAuthResult`, `BoardMemory`, `AgentActionLog`)
- `server/agent-heartbeat.ts` — integrare `last_seen_at` check
- `client/src/types/index.ts` — nuovi tipi UI
- `client/src/lib/api.ts` — `agentApi` namespace (se serve client admin)
- `client/src/components/Board/TaskCard.tsx` — heartbeat pulse, agent indicator
- `client/src/components/Board/KanbanBoard.tsx` — nuovi WS events
- `client/src/hooks/useBoard.ts` — gestire `agent:*` events

### File di test (temporanei, in /tmp)
- `/tmp/topix-agent-tests.ts`
- `/tmp/topix-test-report.json` (output)
