/**
 * Shared Bun websocket transport limits used by production and integration tests.
 *
 * The ceiling stays at the 1 MiB every client message already lived under: the co-browse mirror
 * now travels in pieces of at most 192 KiB, so it no longer needs a larger frame, and lowering
 * the ceiling would close the socket on any other message that grew past it.
 */
export const WS_TRANSPORT_OPTIONS = {
  maxPayloadLength: 1024 * 1024,
  perMessageDeflate: true,
} as const;
