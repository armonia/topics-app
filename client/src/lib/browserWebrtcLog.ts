export type BrowserTransportEvent = 'offer' | 'connected' | 'fallback';

export function logBrowserTransport(
  event: BrowserTransportEvent,
  contextId: string,
  write: (line: string) => void = (line) => console.info(line),
): void {
  write(`[browser ${contextId}] webrtc ${event}`);
}
