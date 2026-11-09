import { apiFetch } from './shell/net';

/**
 * GET a local-server path and return its parsed JSON, or `null` when the
 * request fails, answers with an error status or the body is not JSON. The hub panes poll
 * several endpoints at once and render whatever came back, so a failure is a
 * missing section, never a thrown error.
 */
export async function readJson(path: string, init?: RequestInit): Promise<unknown> {
  try {
    const r = await apiFetch(path, init);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
