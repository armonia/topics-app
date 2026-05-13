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
