/**
 * THE DEVICE ROUTES, written once for whoever manages the devices.
 *
 * Rename, revoke and «whose is it» lived only in the Settings page, as inline
 * fetches. The user menu's Devices level does the same three gestures now, so
 * the calls and the reading of a refusal live here and both callers agree on
 * what the server said.
 */
import { chiaveErroreAuth } from './authErrors';
import { apiFetch } from './shell/net';

/**
 * One gesture on one device. Resolves to `null` when it went through, or to
 * the dictionary key of the refusal: the server sends a code
 * (`shared/auth-codes.ts`) and the sentence is picked by the caller's `t`.
 */
async function act(id: string, init: RequestInit): Promise<string | null> {
  try {
    const r = await apiFetch(`/api/auth/devices/${encodeURIComponent(id)}`, { credentials: 'same-origin', ...init });
    if (r.ok) return null;
    const body = await r.json().catch(() => null) as { error?: string } | null;
    return chiaveErroreAuth(body?.error);
  } catch {
    return chiaveErroreAuth(undefined);
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function renameDevice(id: string, name: string): Promise<string | null> {
  return act(id, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name }) });
}

/** Moves a device onto another person. Grants point at people and stay put. */
export function moveDevice(id: string, personId: string | null): Promise<string | null> {
  return act(id, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ personId }) });
}

export function revokeDevice(id: string): Promise<string | null> {
  return act(id, { method: 'DELETE' });
}
