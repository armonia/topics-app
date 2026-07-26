/**
 * /api/external-sessions — snapshot of Claude Code sessions running OUTSIDE
 * Topics (bare terminal `claude`, other tools), detected by the mtime sweep in
 * lib/external-session-scanner.ts. Read-only: the client bootstraps from here
 * and then follows `external-sessions:state` WS frames.
 */

import type { ExternalSessionScanner } from '../lib/external-session-scanner';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createExternalSessionsRouter(scanner: ExternalSessionScanner) {
  return async (
    _req: Request,
    _url: URL,
    pathname: string,
    method: string,
  ): Promise<Response | null> => {
    if (pathname === '/api/external-sessions' && method === 'GET') {
      return json({ sessions: scanner.list() });
    }
    return null;
  };
}
