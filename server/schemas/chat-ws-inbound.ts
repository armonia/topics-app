/**
 * Zod schema for inbound messages on the main `/ws` channel (chat/topic
 * coordination, NOT the browser CDP channel — that's `browser-ws-messages.ts`).
 *
 * Migrates the ad-hoc `JSON.parse` + manual `if (data.type === '…')` dispatch
 * at `server.ts:750+` to a validated discriminated union. Only INBOUND
 * messages (client → server) are validated here; outbound broadcasts use
 * the existing send helpers and are typed by their call sites.
 *
 * v3 foundations WS-01 extension. Follows the pattern established for
 * `browser-ws-messages.ts` and `tool-call-detail.ts`.
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

export const chatWsInboundSchema = z.discriminatedUnion('type', [
  focusSchema,
  typingSchema,
  pingSchema,
  dragStartSchema,
  dragEndSchema,
  dragDropSchema,
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
