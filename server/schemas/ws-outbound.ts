/**
 * v3 foundations WS-01 — outbound message emit-side validation.
 *
 * The inbound side (chat-ws-inbound, browser-ws-messages) is fully Zod-
 * validated. The outbound side is not — server bugs that emit malformed
 * payloads slip through to clients and surface as runtime parse errors
 * or silent UI breakage.
 *
 * This module is a REGISTRY (not a discriminated union): each well-shaped
 * outbound type gets its own schema. Types not in the registry pass
 * through unchanged — we don't have to migrate everything at once, just
 * accumulate coverage. `validateOutbound(msg)` returns:
 *   - { ok: true }                   when the type has no registered schema
 *   - { ok: true }                   when the schema passes
 *   - { ok: false, error }           when the schema fails (registered + invalid)
 *
 * Use `validateOutbound` in dev mode inside the broadcast helpers to catch
 * server bugs at emit time (closer to the cause than catching them on the
 * client). In production it's a no-op — zero overhead, no behavior change.
 *
 * Adding a new schema: drop another entry in OUTBOUND_SCHEMAS keyed by the
 * type string. The validator picks it up automatically.
 */
import { z } from 'zod';

// ---- Connection lifecycle --------------------------------------------------

const connectedSchema = z.object({
  type: z.literal('connected'),
  clientId: z.string(),
});

const pongSchema = z.object({
  type: z.literal('pong'),
});

// ---- Dashboard / unread ----------------------------------------------------

const dashboardUpdatedSchema = z.object({
  type: z.literal('dashboard:updated'),
});

const unreadInitSchema = z.object({
  type: z.literal('unread:init'),
  data: z.record(
    z.string(),
    z.object({
      lastReadAt: z.string(),
      unreadCount: z.number(),
    }),
  ),
});

const unreadUpdatedSchema = z.object({
  type: z.literal('unread:updated'),
  topicId: z.string(),
  unreadCount: z.number(),
});

// ---- Stream lifecycle ------------------------------------------------------

const streamEndSchema = z.object({
  type: z.literal('stream:end'),
  sessionKey: z.string(),
  messageId: z.string(),
});

// ---- Coordination broadcasts (mirrors of inbound) --------------------------

const typingBroadcastSchema = z.object({
  type: z.literal('typing'),
  topicId: z.string(),
  clientId: z.string(),
  text: z.string(),
});

const dragStartBroadcastSchema = z.object({
  type: z.literal('drag:start'),
  topicId: z.string(),
  sourceWindowId: z.string(),
});

const dragEndBroadcastSchema = z.object({
  type: z.literal('drag:end'),
  topicId: z.string(),
  sourceWindowId: z.string(),
});

const dragAcceptedBroadcastSchema = z.object({
  type: z.literal('drag:accepted'),
  topicId: z.string(),
  targetWindowId: z.string(),
  sourceWindowId: z.string().optional(),
});

// ---- Topic lifecycle -------------------------------------------------------

const topicSwitchSchema = z.object({
  type: z.literal('topic:switch'),
  fromTopicId: z.string(),
  toTopicId: z.string(),
  toSessionKey: z.string(),
});

/**
 * Topic events carry a `topic` object whose shape evolves frequently
 * (Topic type lives across many migrations). We validate the WRAPPER —
 * type + topic-must-be-object-with-id — and accept any additional fields
 * inside topic. When a canonical Topic Zod schema lands, swap z.object
 * `.passthrough()` for the strict reference here.
 */
const topicObjectShape = z.object({ id: z.string() }).passthrough();

const topicCreatedSchema = z.object({
  type: z.literal('topic:created'),
  topic: topicObjectShape,
});

const topicUpdatedSchema = z.object({
  type: z.literal('topic:updated'),
  topic: topicObjectShape,
});

const topicArchivedSchema = z.object({
  type: z.literal('topic:archived'),
  topic: topicObjectShape,
});

const topicSwitchCompleteSchema = z.object({
  type: z.literal('topic:switch:complete'),
}).passthrough();

// ---- Task / board lifecycle (project board) --------------------------------

const taskObjectShape = z.object({ id: z.string() }).passthrough();

const taskCreatedSchema = z.object({
  type: z.literal('task:created'),
  projectId: z.string(),
  task: taskObjectShape,
});

const taskUpdatedSchema = z.object({
  type: z.literal('task:updated'),
  projectId: z.string(),
  task: taskObjectShape,
});

const taskMovedSchema = z.object({
  type: z.literal('task:moved'),
  projectId: z.string(),
  task: taskObjectShape,
});

const taskUnarchivedSchema = z.object({
  type: z.literal('task:unarchived'),
  projectId: z.string(),
  task: taskObjectShape,
});

const taskDeletedSchema = z.object({
  type: z.literal('task:deleted'),
  projectId: z.string(),
  taskId: z.string(),
});

const taskArchivedSchema = z.object({
  type: z.literal('task:archived'),
  projectId: z.string(),
  taskId: z.string(),
});

const taskDependencyAddedSchema = z.object({
  type: z.literal('task:dependency:added'),
  projectId: z.string(),
  taskId: z.string(),
});

const taskDependencyRemovedSchema = z.object({
  type: z.literal('task:dependency:removed'),
  projectId: z.string(),
  taskId: z.string(),
});

const taskCommentAddedSchema = z.object({
  type: z.literal('task:comment:added'),
  projectId: z.string(),
  taskId: z.string(),
  comment: z.object({ id: z.string() }).passthrough(),
});

const boardMemoryAddedSchema = z.object({
  type: z.literal('board:memory_added'),
  projectId: z.string(),
  memory: z.object({ id: z.string() }).passthrough(),
});

const boardArchivedAllSchema = z.object({
  type: z.literal('board:archived_all'),
  projectId: z.string(),
});

// ---- Worktree events -------------------------------------------------------

const worktreeObjectShape = z.object({ id: z.string() }).passthrough();

const worktreeNewSchema = z.object({
  type: z.literal('worktree:new'),
  worktree: worktreeObjectShape,
  payload_version: z.number().optional(),
}).passthrough();

const worktreeUpdatedSchema = z.object({
  type: z.literal('worktree:updated'),
  worktree: worktreeObjectShape,
  payload_version: z.number().optional(),
}).passthrough();

const worktreeDeletedSchema = z.object({
  type: z.literal('worktree:deleted'),
  worktree: z.object({ id: z.string() }).passthrough(),
  payload_version: z.number().optional(),
}).passthrough();

// ---- UI state events -------------------------------------------------------

const uiStateUpdatedSchema = z.object({
  type: z.literal('ui-state:updated'),
  key: z.string(),
  value: z.unknown(),
  payload_version: z.number().optional(),
  server_seq: z.number().optional(),
  sourceClientId: z.string().optional(),
}).passthrough();

const uiStatePatchSchema = z.object({
  type: z.literal('ui-state:patch'),
  sourceClientId: z.string().optional(),
  entries: z.array(z.unknown()),
}).passthrough();

// ---- Provider snapshot -----------------------------------------------------

const providersSnapshotSchema = z.object({
  type: z.literal('providers:snapshot'),
  snapshot: z.unknown(), // Provider snapshot shape varies; keep loose.
}).passthrough();

// ---- Stream catchup --------------------------------------------------------

const streamCatchupSchema = z.object({
  type: z.literal('stream:catchup'),
  sessionKey: z.string(),
  messageId: z.string(),
}).passthrough(); // toolCalls, blocks, content, thinking, isThinking are optional rich fields.

// ---- Project events --------------------------------------------------------

const projectObjectShape = z.object({ id: z.string() }).passthrough();

const projectCreatedSchema = z.object({
  type: z.literal('project:created'),
  project: projectObjectShape,
  payload_version: z.number().optional(),
}).passthrough();

const projectUpdatedSchema = z.object({
  type: z.literal('project:updated'),
  project: projectObjectShape,
  payload_version: z.number().optional(),
}).passthrough();

const projectDeletedSchema = z.object({
  type: z.literal('project:deleted'),
  project: z.object({ id: z.string() }).passthrough(),
  payload_version: z.number().optional(),
}).passthrough();

// ---- Error envelope --------------------------------------------------------

const errorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
}).passthrough();

// ---- Welcome (v3 WS-02 handshake echo on outbound side) --------------------

const welcomeOutboundSchema = z.object({
  type: z.literal('welcome'),
  serverVersion: z.string(),
  protocolVersion: z.number().int(),
  capabilities: z.array(z.string()),
  serverTime: z.number(),
  clientId: z.string(),
}).passthrough();

// ---- Agent lifecycle cluster ----------------------------------------------

const agentProfileShape = z.object({ id: z.string() }).passthrough();

const agentProfileCreatedSchema = z.object({
  type: z.literal('agent:profile:created'),
  profile: agentProfileShape,
}).passthrough();

const agentProfileUpdatedSchema = z.object({
  type: z.literal('agent:profile:updated'),
  profile: agentProfileShape,
}).passthrough();

const agentProfileDeletedSchema = z.object({
  type: z.literal('agent:profile:deleted'),
  agentId: z.string(),
}).passthrough();

const agentAssignedSchema = z.object({
  type: z.literal('agent:assigned'),
  assignment: z.object({ agentId: z.string(), topicId: z.string() }).passthrough(),
}).passthrough();

const agentUnassignedSchema = z.object({
  type: z.literal('agent:unassigned'),
  agentId: z.string(),
  topicId: z.string(),
}).passthrough();

const agentStatusSchema = z.object({
  type: z.literal('agent:status'),
  agentId: z.string(),
  status: z.string(),
  previousStatus: z.string().optional(),
}).passthrough();

const agentHeartbeatSchema = z.object({
  type: z.literal('agent:heartbeat'),
  agentId: z.string(),
  timestamp: z.string(),
}).passthrough();

const agentSessionPausedSchema = z.object({
  type: z.literal('agent:session:paused'),
  sessionKey: z.string(),
}).passthrough();

const agentSessionResumedSchema = z.object({
  type: z.literal('agent:session:resumed'),
  sessionKey: z.string(),
}).passthrough();

const agentTaskClaimedSchema = z.object({
  type: z.literal('agent:task_claimed'),
  agentId: z.string(),
  taskId: z.string(),
  projectId: z.string(),
}).passthrough();

const agentTaskCompletedSchema = z.object({
  type: z.literal('agent:task_completed'),
  agentId: z.string(),
  taskId: z.string(),
}).passthrough();

const agentEscalationSchema = z.object({
  type: z.literal('agent:escalation'),
}).passthrough();

const agentsSessionsSchema = z.object({
  type: z.literal('agents:sessions'),
  sessions: z.array(z.unknown()),
}).passthrough();

const agentsSpawnedSchema = z.object({
  type: z.literal('agents:spawned'),
  topicId: z.string(),
  sessionKey: z.string(),
  label: z.string().optional(),
}).passthrough();

const agentsStoppedSchema = z.object({
  type: z.literal('agents:stopped'),
  sessionKey: z.string(),
}).passthrough();

// ---- Approval cluster ------------------------------------------------------

const approvalCreatedSchema = z.object({
  type: z.literal('approval:created'),
  projectId: z.string(),
  approval: z.object({ id: z.string() }).passthrough(),
}).passthrough();

const approvalApprovedSchema = z.object({
  type: z.literal('approval:approved'),
  approvalId: z.string(),
}).passthrough();

const approvalRejectedSchema = z.object({
  type: z.literal('approval:rejected'),
  approvalId: z.string(),
}).passthrough();

// ---- Stream cluster (server → client message streaming) -------------------

const streamStartSchema = z.object({
  type: z.literal('stream:start'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
  messageId: z.string(),
}).passthrough();

const streamContentChunkSchema = z.object({
  type: z.literal('stream:content_chunk'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
  content: z.string(),
}).passthrough();

const streamThinkingStartSchema = z.object({
  type: z.literal('stream:thinking_start'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamThinkingEndSchema = z.object({
  type: z.literal('stream:thinking_end'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamThinkingChunkSchema = z.object({
  type: z.literal('stream:thinking_chunk'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamErrorSchema = z.object({
  type: z.literal('stream:error'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
  error: z.string(),
}).passthrough();

const streamSlowSchema = z.object({
  type: z.literal('stream:slow'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamResumedSchema = z.object({
  type: z.literal('stream:resumed'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamToolCallSchema = z.object({
  type: z.literal('stream:tool_call'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
  toolCall: z.object({ id: z.string() }).passthrough(),
}).passthrough();

const streamToolDetailSchema = z.object({
  type: z.literal('stream:tool_detail'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamToolResultSchema = z.object({
  type: z.literal('stream:tool_result'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamToolUpdateSchema = z.object({
  type: z.literal('stream:tool_update'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamToolUserInputRequiredSchema = z.object({
  type: z.literal('stream:tool_user_input_required'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

// ---- Message cluster (legacy + new) ---------------------------------------

const messageLegacySchema = z.object({
  type: z.literal('message'),
  sessionKey: z.string(),
  message: z.object({ id: z.string() }).passthrough(),
}).passthrough();

const messageNewSchema = z.object({
  type: z.literal('message:new'),
  topicId: z.string().optional(),
  sessionKey: z.string(),
  role: z.string(),
  messageId: z.string(),
  content: z.string(),
  preview: z.string().optional(),
}).passthrough();

const messageMediaSchema = z.object({
  type: z.literal('message:media'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
  media: z.unknown(),
}).passthrough();

const messagePlanStatusSchema = z.object({
  type: z.literal('message:plan-status'),
  topicId: z.string(),
  messageId: z.string(),
  planStatus: z.string(),
}).passthrough();

// ---- Misc / domain-specific outbound --------------------------------------

const browserNavigateSchema = z.object({
  type: z.literal('browser:navigate'),
  topicId: z.string(),
  url: z.string(),
}).passthrough();

const clearSchema = z.object({
  type: z.literal('clear'),
}).passthrough();

const cronUpdatedSchema = z.object({
  type: z.literal('cron:updated'),
  jobs: z.array(z.unknown()),
}).passthrough();

const gatewayStatusSchema = z.object({
  type: z.literal('gateway:status'),
}).passthrough();

const machineShape = z.object({ id: z.string() }).passthrough();

const machineUpdatedSchema = z.object({
  type: z.literal('machine:updated'),
  machine: machineShape,
}).passthrough();

const machineUpsertedSchema = z.object({
  type: z.literal('machine:upserted'),
  machine: machineShape,
}).passthrough();

const memoryUpdatedSchema = z.object({
  type: z.literal('memory:updated'),
  scope: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const openProjectSchema = z.object({
  type: z.literal('open-project'),
  projectPath: z.string(),
}).passthrough();

const topicsReorderedSchema = z.object({
  type: z.literal('topics:reordered'),
  order: z.array(z.string()),
}).passthrough();

const taskUnblockedSchema = z.object({
  type: z.literal('task:unblocked'),
  projectId: z.string(),
  taskId: z.string(),
}).passthrough();

const uiStateInitSchema = z.object({
  type: z.literal('ui-state:init'),
  data: z.unknown(),
  meta: z.unknown().optional(),
}).passthrough();

const scriptsOutputSchema = z.object({
  type: z.literal('scripts:output'),
}).passthrough();

const scriptsUpdatedSchema = z.object({
  type: z.literal('scripts:updated'),
}).passthrough();

const terminalSessionsSchema = z.object({
  type: z.literal('terminal:sessions'),
}).passthrough();

// ---- Legacy chat:* events (replaced by topic:* in v3, kept for compat) ----

const chatObjectShape = z.object({ id: z.string() }).passthrough();

const chatCreatedSchema = z.object({
  type: z.literal('chat:created'),
  chat: chatObjectShape,
}).passthrough();

const chatUpdatedSchema = z.object({
  type: z.literal('chat:updated'),
  chat: chatObjectShape,
}).passthrough();

const chatArchivedSchema = z.object({
  type: z.literal('chat:archived'),
  chat: chatObjectShape,
}).passthrough();

const chatDeletedSchema = z.object({
  type: z.literal('chat:deleted'),
  chatId: z.string(),
}).passthrough();

// ---- Provider niche events -------------------------------------------------

const providerCurrentSchema = z.object({
  type: z.literal('provider:current'),
}).passthrough();

const providerChangedSchema = z.object({
  type: z.literal('provider:changed'),
}).passthrough();

// ---- Git status (legacy plan, kept for forward compat) --------------------

const gitStatusUpdatedSchema = z.object({
  type: z.literal('git-status:updated'),
}).passthrough();

// ---- Registry --------------------------------------------------------------

const OUTBOUND_SCHEMAS = {
  // Connection lifecycle
  'connected': connectedSchema,
  'pong': pongSchema,
  // Notification
  'dashboard:updated': dashboardUpdatedSchema,
  'unread:init': unreadInitSchema,
  'unread:updated': unreadUpdatedSchema,
  // Stream
  'stream:end': streamEndSchema,
  'stream:catchup': streamCatchupSchema,
  // Collaboration
  'typing': typingBroadcastSchema,
  'drag:start': dragStartBroadcastSchema,
  'drag:end': dragEndBroadcastSchema,
  'drag:accepted': dragAcceptedBroadcastSchema,
  // Topic lifecycle
  'topic:switch': topicSwitchSchema,
  'topic:created': topicCreatedSchema,
  'topic:updated': topicUpdatedSchema,
  'topic:archived': topicArchivedSchema,
  'topic:switch:complete': topicSwitchCompleteSchema,
  // Task / board
  'task:created': taskCreatedSchema,
  'task:updated': taskUpdatedSchema,
  'task:moved': taskMovedSchema,
  'task:deleted': taskDeletedSchema,
  'task:archived': taskArchivedSchema,
  'task:unarchived': taskUnarchivedSchema,
  'task:dependency:added': taskDependencyAddedSchema,
  'task:dependency:removed': taskDependencyRemovedSchema,
  'task:comment:added': taskCommentAddedSchema,
  'board:memory_added': boardMemoryAddedSchema,
  'board:archived_all': boardArchivedAllSchema,
  // Worktree
  'worktree:new': worktreeNewSchema,
  'worktree:updated': worktreeUpdatedSchema,
  'worktree:deleted': worktreeDeletedSchema,
  // UI state
  'ui-state:updated': uiStateUpdatedSchema,
  'ui-state:patch': uiStatePatchSchema,
  // Project
  'project:created': projectCreatedSchema,
  'project:updated': projectUpdatedSchema,
  'project:deleted': projectDeletedSchema,
  // Provider
  'providers:snapshot': providersSnapshotSchema,
  // Errors
  'error': errorMessageSchema,
  // Handshake echo (welcome is sent right after connected)
  'welcome': welcomeOutboundSchema,
  // Agent lifecycle
  'agent:profile:created': agentProfileCreatedSchema,
  'agent:profile:updated': agentProfileUpdatedSchema,
  'agent:profile:deleted': agentProfileDeletedSchema,
  'agent:assigned': agentAssignedSchema,
  'agent:unassigned': agentUnassignedSchema,
  'agent:status': agentStatusSchema,
  'agent:heartbeat': agentHeartbeatSchema,
  'agent:session:paused': agentSessionPausedSchema,
  'agent:session:resumed': agentSessionResumedSchema,
  'agent:task_claimed': agentTaskClaimedSchema,
  'agent:task_completed': agentTaskCompletedSchema,
  'agent:escalation': agentEscalationSchema,
  'agents:sessions': agentsSessionsSchema,
  'agents:spawned': agentsSpawnedSchema,
  'agents:stopped': agentsStoppedSchema,
  // Approvals
  'approval:created': approvalCreatedSchema,
  'approval:approved': approvalApprovedSchema,
  'approval:rejected': approvalRejectedSchema,
  // Stream cluster (provider streaming)
  'stream:start': streamStartSchema,
  'stream:content_chunk': streamContentChunkSchema,
  'stream:thinking_start': streamThinkingStartSchema,
  'stream:thinking_end': streamThinkingEndSchema,
  'stream:thinking_chunk': streamThinkingChunkSchema,
  'stream:error': streamErrorSchema,
  'stream:slow': streamSlowSchema,
  'stream:resumed': streamResumedSchema,
  'stream:tool_call': streamToolCallSchema,
  'stream:tool_detail': streamToolDetailSchema,
  'stream:tool_result': streamToolResultSchema,
  'stream:tool_update': streamToolUpdateSchema,
  'stream:tool_user_input_required': streamToolUserInputRequiredSchema,
  // Message cluster
  'message': messageLegacySchema,
  'message:new': messageNewSchema,
  'message:media': messageMediaSchema,
  'message:plan-status': messagePlanStatusSchema,
  // Misc domain
  'browser:navigate': browserNavigateSchema,
  'clear': clearSchema,
  'cron:updated': cronUpdatedSchema,
  'gateway:status': gatewayStatusSchema,
  'machine:updated': machineUpdatedSchema,
  'machine:upserted': machineUpsertedSchema,
  'memory:updated': memoryUpdatedSchema,
  'open-project': openProjectSchema,
  'topics:reordered': topicsReorderedSchema,
  'task:unblocked': taskUnblockedSchema,
  'ui-state:init': uiStateInitSchema,
  'scripts:output': scriptsOutputSchema,
  'scripts:updated': scriptsUpdatedSchema,
  'terminal:sessions': terminalSessionsSchema,
  // Legacy chat:* (replaced by topic:* in v3, kept for backward compat)
  'chat:created': chatCreatedSchema,
  'chat:updated': chatUpdatedSchema,
  'chat:archived': chatArchivedSchema,
  'chat:deleted': chatDeletedSchema,
  // Provider niche
  'provider:current': providerCurrentSchema,
  'provider:changed': providerChangedSchema,
  // Git status (legacy/forward compat)
  'git-status:updated': gitStatusUpdatedSchema,
} as const;

/**
 * Stable list of outbound types this module knows about. Exposed so tests
 * can lock the registry size (contract guard).
 */
export const REGISTERED_OUTBOUND_TYPES = Object.keys(OUTBOUND_SCHEMAS).sort();

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate an outbound message at emit time. Returns ok:true for types
 * not in the registry (passthrough — incremental migration), ok:true for
 * registered types that pass their schema, ok:false with the path-qualified
 * Zod error when a registered type fails to parse.
 */
export function validateOutbound(msg: unknown): ValidationResult {
  if (typeof msg !== 'object' || msg === null) {
    return { ok: false, error: '<root>: expected object' };
  }
  const type = (msg as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return { ok: false, error: 'type: missing or not a string' };
  }
  const schema = (OUTBOUND_SCHEMAS as Record<string, z.ZodTypeAny>)[type];
  if (!schema) {
    // Unmodeled type — passthrough is OK. Future commits add more schemas.
    return { ok: true };
  }
  const result = schema.safeParse(msg);
  if (result.success) return { ok: true };
  return {
    ok: false,
    error: result.error.issues
      .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
      .join('; '),
  };
}

/**
 * Convenience: returns true if the type is known to this module's registry.
 * Useful for tests + dev-mode diagnostics ("which outbound types are still
 * unmodeled?").
 */
export function isRegisteredOutboundType(type: string): boolean {
  return type in OUTBOUND_SCHEMAS;
}
