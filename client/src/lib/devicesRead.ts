/**
 * READING THE DEVICES: `/api/auth/devices` in the shape the user menu draws.
 *
 * Apart from the gestures (`devicesApi`) because the user card reads the list
 * at first paint, while rename, revoke and «whose is it» load with the menu.
 */
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

