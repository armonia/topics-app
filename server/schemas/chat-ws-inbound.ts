/**
 * Zod schema for inbound messages on the main `/ws` channel (chat/topic
 * coordination, NOT the browser CDP channel — that's `shared/browser-ws-messages.ts`).
 *
 * Migrates the ad-hoc `JSON.parse` + manual `if (data.type === '…')` dispatch
 * at `server.ts:750+` to a validated discriminated union. Only INBOUND
 * messages (client → server) are validated here; outbound broadcasts use
 * the existing send helpers and are typed by their call sites.
 *
 * v3 foundations WS-01 extension. Follows the pattern established for
 * `shared/browser-ws-messages.ts` and `shared/tool-call-detail.ts`.
 *
 * Sent by:
 *   - `client/src/lib/focusMessaging.ts` → focus
 *   - `client/src/components/Chat/ChatPane.tsx` → typing
 *   - `client/src/hooks/useWebSocket.ts` → ping (heartbeat keepalive)
 *   - `client/src/components/Layout/PanelGrid.tsx` → drag:start, drag:end
 *   - `client/src/hooks/usePanelLifecycle.ts` → drag:drop
 */
import { z } from 'zod';

const focusSchema = z.object({
  type: z.literal('focus'),
  topicId: z.string().nullable(),
});

const typingSchema = z.object({
  type: z.literal('typing'),
  topicId: z.string(),
  text: z.string().optional(),
});

const pingSchema = z.object({
  type: z.literal('ping'),
});

// P6: client declares the set of topics it currently has open, so streaming
// deltas can be routed only to clients showing that topic (see ws-topic-routing).
const subscribeSchema = z.object({
  type: z.literal('subscribe'),
  topicIds: z.array(z.string()),
});

const dragStartSchema = z.object({
  type: z.literal('drag:start'),
  topicId: z.string(),
  windowId: z.string(),
});

const dragEndSchema = z.object({
  type: z.literal('drag:end'),
  topicId: z.string(),
  windowId: z.string(),
});

const dragDropSchema = z.object({
  type: z.literal('drag:drop'),
  topicId: z.string(),
  windowId: z.string(),
  sourceWindowId: z.string().optional(),
});

// One tab of a window, for the sidebar's "Finestre" grouping. Bounded on
// purpose: a presence frame is re-broadcast to every socket on every tab
// change, so the payload has to stay small even if a window somehow holds
// hundreds of panes. `type` is a free string, not an enum — an older server
// must not drop a pane kind it has never heard of.
const presenceTabSchema = z.object({
  id: z.string().max(400),
  type: z.string().max(40),
  title: z.string().max(200).optional(),
});

// WS-02 handshake: client → server hello after connection.open.
// Defined here (rather than imported from ws-handshake.ts) so the main
// inbound dispatch can validate it with the same parser as the other types.
//
// The presence fields (windowId/windowLabel/detached/topicIds) are OPTIONAL
// additions for the cross-window presence channel: a window declares its
// identity + the topics it holds on connect so every other window can render
// "open elsewhere" affordances. Old clients omit them (no behavior change);
// the whole channel is WS-ephemeral (never persisted).
const helloSchema = z.object({
  type: z.literal('hello'),
  clientVersion: z.string(),
  protocolVersion: z.number().int(),
  capabilities: z.array(z.string()),
  windowId: z.string().optional(),
  windowLabel: z.string().optional(),
  detached: z.boolean().optional(),
  spaceId: z.string().optional(),
  topicIds: z.array(z.string()).optional(),
  focusedTopicId: z.string().optional(),
  tabs: z.array(presenceTabSchema).max(200).optional(),
});

// Presence update after hello: sent when the window's open set / focus / detach
// state changes (tab opened/closed/focused). Server re-broadcasts the full
// window list snapshot on each one.
const presenceAnnounceSchema = z.object({
  type: z.literal('presence:announce'),
  windowId: z.string(),
  windowLabel: z.string().optional(),
  detached: z.boolean().optional(),
  spaceId: z.string().optional(),
  topicIds: z.array(z.string()),
  focusedTopicId: z.string().optional(),
  tabs: z.array(presenceTabSchema).max(200).optional(),
});

export const chatWsInboundSchema = z.discriminatedUnion('type', [
  focusSchema,
  typingSchema,
  pingSchema,
  subscribeSchema,
  dragStartSchema,
  dragEndSchema,
  dragDropSchema,
  helloSchema,
  presenceAnnounceSchema,
]);

export type ChatWsInbound = z.infer<typeof chatWsInboundSchema>;

export type ParseResult =
  | { ok: true; data: ChatWsInbound }
  | { ok: false; error: string };

/**
 * Parse an inbound chat/topic WS frame. Use at the receive boundary.
 * Returns a discriminated result; on failure the error is path-qualified
 * so logging is one line.
 */
export function parseChatWsInbound(value: unknown): ParseResult {
  const result = chatWsInboundSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  const error = result.error.issues
    .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
    .join('; ');
  return { ok: false, error };
}
