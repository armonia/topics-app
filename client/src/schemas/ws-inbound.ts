/**
 * Client-side mirror of `server/schemas/ws-outbound.ts` — used to validate
 * inbound WS messages received from the server.
 *
 * Why a mirror: TS6307 forbids the composite client project from importing
 * `server/`. The Zod schemas are duplicated; the wire contract is the same
 * — both sides validate against an identical shape.
 *
 * Strategy: the client doesn't need the FULL list of 94 server-side
 * schemas. Most inbound messages are dispatched generically into the WS
 * frame bus; only a handful are read by hand in components. We model a
 * representative subset and the validator passes through unknown types
 * exactly like the server-side validator does. The PRIMARY value is
 * catching:
 *   1. Protocol drift after a server upgrade (client too old to parse
 *      a new required field).
 *   2. Server-side bugs that emit malformed payloads despite the
 *      `devValidateOutbound` hook on the server (which only runs in DEV).
 *
 * KEEP IN SYNC with `server/schemas/ws-outbound.ts` for any type the
 * client reads by hand (the registry below). Other types fall through
 * silently.
 *
 * v3 foundations WS-01 client-side wrap-up.
 *
 * Uses `zod/mini` (functional, tree-shakable API) so these client-bundled
 * schemas don't drag the method-heavy core into the critical entry chunk.
 * `z.looseObject({...})` replaces `.passthrough()`; `.safeParse` is identical.
 */
import { z } from 'zod/mini';

// ---- High-frequency types the client reads by hand ------------------------

const connectedSchema = z.looseObject({
  type: z.literal('connected'),
  clientId: z.string(),
});

const pongSchema = z.looseObject({ type: z.literal('pong') });

const errorMessageSchema = z.looseObject({
  type: z.literal('error'),
  message: z.string(),
});

const welcomeSchema = z.looseObject({
  type: z.literal('welcome'),
  serverVersion: z.string(),
  protocolVersion: z.int(),
  capabilities: z.array(z.string()),
  serverTime: z.number(),
  clientId: z.string(),
});

const dashboardUpdatedSchema = z.looseObject({
  type: z.literal('dashboard:updated'),
});

const unreadInitSchema = z.looseObject({
  type: z.literal('unread:init'),
  data: z.record(
    z.string(),
    z.looseObject({
      lastReadAt: z.string(),
      unreadCount: z.number(),
    }),
  ),
});

const unreadUpdatedSchema = z.looseObject({
  type: z.literal('unread:updated'),
  topicId: z.string(),
  unreadCount: z.number(),
});

const streamEndSchema = z.looseObject({
  type: z.literal('stream:end'),
  sessionKey: z.string(),
  messageId: z.string(),
});

const streamCatchupSchema = z.looseObject({
  type: z.literal('stream:catchup'),
  sessionKey: z.string(),
  messageId: z.string(),
});

const typingBroadcastSchema = z.looseObject({
  type: z.literal('typing'),
  topicId: z.string(),
  clientId: z.string(),
  text: z.string(),
});

const topicCreatedSchema = z.looseObject({
  type: z.literal('topic:created'),
  topic: z.looseObject({ id: z.string() }),
});

const topicUpdatedSchema = z.looseObject({
  type: z.literal('topic:updated'),
  topic: z.looseObject({ id: z.string() }),
});

const topicArchivedSchema = z.looseObject({
  type: z.literal('topic:archived'),
  topic: z.looseObject({ id: z.string() }),
});

const topicSwitchSchema = z.looseObject({
  type: z.literal('topic:switch'),
  fromTopicId: z.string(),
  // Optional inbound for forward/backward compat with a server that predates
  // the field; the open+focus guard degrades to "no origin scoping" if absent.
  fromSessionKey: z.optional(z.string()),
  toTopicId: z.string(),
  toSessionKey: z.string(),
});

const uiStateInitSchema = z.looseObject({
  type: z.literal('ui-state:init'),
  data: z.unknown(),
  meta: z.optional(z.unknown()),
});

const uiStateUpdatedSchema = z.looseObject({
  type: z.literal('ui-state:updated'),
  key: z.string(),
  value: z.unknown(),
});

const messageNewSchema = z.looseObject({
  type: z.literal('message:new'),
  sessionKey: z.string(),
  role: z.string(),
  messageId: z.string(),
  content: z.string(),
});

const streamStartSchema = z.looseObject({
  type: z.literal('stream:start'),
  sessionKey: z.string(),
  messageId: z.string(),
});

const streamContentChunkSchema = z.looseObject({
  type: z.literal('stream:content_chunk'),
  sessionKey: z.string(),
  content: z.string(),
});

const streamErrorSchema = z.looseObject({
  type: z.literal('stream:error'),
  sessionKey: z.string(),
  error: z.string(),
});

// ---- Registry --------------------------------------------------------------

const INBOUND_SCHEMAS = {
  'connected': connectedSchema,
  'pong': pongSchema,
  'error': errorMessageSchema,
  'welcome': welcomeSchema,
  'dashboard:updated': dashboardUpdatedSchema,
  'unread:init': unreadInitSchema,
  'unread:updated': unreadUpdatedSchema,
  'stream:end': streamEndSchema,
  'stream:catchup': streamCatchupSchema,
  'stream:start': streamStartSchema,
  'stream:content_chunk': streamContentChunkSchema,
  'stream:error': streamErrorSchema,
  'typing': typingBroadcastSchema,
  'topic:created': topicCreatedSchema,
  'topic:updated': topicUpdatedSchema,
  'topic:archived': topicArchivedSchema,
  'topic:switch': topicSwitchSchema,
  'ui-state:init': uiStateInitSchema,
  'ui-state:updated': uiStateUpdatedSchema,
  'message:new': messageNewSchema,
} as const;

export const REGISTERED_INBOUND_TYPES = Object.keys(INBOUND_SCHEMAS).sort();

export type InboundValidationResult =
  | { ok: true }
  | { ok: false; error: string; type?: string };

/**
 * Validate an inbound WS frame. Returns ok:true for types the client
 * doesn't know about (passthrough), ok:true for known types that pass
 * the schema, ok:false with the path-qualified Zod error otherwise.
 *
 * Failure is non-fatal in production — the dispatcher should log + drop
 * the frame to avoid crashing the React tree, mirroring the server-side
 * graceful-degradation contract.
 */
export function validateInbound(msg: unknown): InboundValidationResult {
  if (typeof msg !== 'object' || msg === null) {
    return { ok: false, error: '<root>: expected object' };
  }
  const type = (msg as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return { ok: false, error: 'type: missing or not a string' };
  }
  const schema = (INBOUND_SCHEMAS as Record<string, z.ZodMiniType>)[type];
  if (!schema) return { ok: true };
  const result = schema.safeParse(msg);
  if (result.success) return { ok: true };
  return {
    ok: false,
    type,
    error: result.error.issues
      .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
      .join('; '),
  };
}

export function isRegisteredInboundType(type: string): boolean {
  return type in INBOUND_SCHEMAS;
}
