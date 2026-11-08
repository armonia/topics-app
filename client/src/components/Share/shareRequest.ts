import { authRefusalKey, chiaveErroreAuth } from '../../lib/authErrors';

/**
 * Runs one write of the share panel and returns the i18n key of its failure,
 * or `null` when it went through.
 *
 * Never throws: the panel's handlers are called with `void`, so a rejection
 * here would be unhandled and the person would see nothing.
 */
export async function shareRequestError(request: () => Promise<Response>): Promise<string | null> {
  try {
    const r = await request();
    return r.ok ? null : await authRefusalKey(r);
  } catch {
    return chiaveErroreAuth(undefined);
  }
}
