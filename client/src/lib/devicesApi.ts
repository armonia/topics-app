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

/** One row of `/api/auth/devices`, as the route sends it. */
export interface PairedDevice {
  id: string;
  name: string;
  createdAt?: number;
  lastSeenAt?: number | null;
  firstIp?: string | null;
  revokedAt: number | null;
  /** Holds a live socket right now. */
  connected: boolean;
  /** The device this request comes from. */
  current: boolean;
  role?: 'owner' | 'guest';
  /** Whose it is (migration 084 guessed it, so it can be wrong). */
  person?: { id: string; name: string } | null;
}

/** A person a device can belong to. */
export interface DevicePerson {
  id: string;
  name: string;
  owner: boolean;
}

/** The whole answer: the computer the server runs on comes apart (it has no
 *  row and cannot be revoked), then the paired devices, then the people. */
export interface DevicesSnapshot {
  computer: { name?: string; current: boolean } | null;
  devices: PairedDevice[];
  people: DevicePerson[];
}

/** Reads the devices; `null` when the route did not answer. */
export async function readDevices(): Promise<DevicesSnapshot | null> {
  try {
    const r = await apiFetch('/api/auth/devices', { credentials: 'same-origin' });
    if (!r.ok) return null;
    const b = await r.json() as {
      thisComputer?: { name?: string; current: boolean };
      devices?: PairedDevice[];
      people?: DevicePerson[];
    };
    return { computer: b.thisComputer ?? null, devices: b.devices ?? [], people: b.people ?? [] };
  } catch {
    return null;
  }
}

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
