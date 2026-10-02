/**
 * THE IDENTITY BLOCK'S DATA: the session, the presence of groups and friends,
 * and the devices, read once per host.
 *
 * Two hosts draw the same block (`Sidebar/IdentityMenuItems`): the user card at
 * the foot of the desktop column, which also needs these values for the card
 * itself, and the title menu on the phone, which reads them only while it is
 * open. The hook lives apart from the block so the eager card does not pull
 * the menu's body into the first paint.
 */
import { useCallback, useEffect, useState } from 'react';
import { etichettaIdentita, type LabelIdentity } from '@/components/Sidebar/identityLabel';
import { useIdentityPresence, type OrgWithPresence } from './useIdentityPresence';
import { useFriendPresence, type FriendPresence } from './useFriendPresence';
import { getSession, subscribeSession, type SessionState } from '@/lib/auth/session';
import { readDevices as fetchDevices, type DevicesSnapshot } from '@/lib/devicesApi';

/** Everything the identity block draws, read in one place. */
export interface IdentityMenuData {
  session: SessionState;
  who: LabelIdentity;
  orgs: OrgWithPresence[];
  friends: FriendPresence;
  /** `null` until the route has answered once. */
  devices: DevicesSnapshot | null;
  /** Asks the device route again. Stable. */
  readDevices: () => void;
}

/**
 * THE DEVICES ARE READ AFTER THE FIRST PAINT and again when a pairing resolves
 * or a device is revoked elsewhere: nobody needs the count in the first frame,
 * and a synchronous state write on mount is what `set-state-in-effect` flags.
 */
export function useIdentityMenuData(): IdentityMenuData {
  const presence = useIdentityPresence();
  const friends = useFriendPresence();
  // `getSession`, not «loading»: the store may already know (last answer kept
  // on this device), and a first frame without the card is the shift the cache
  // exists to remove.
  const [session, setSession] = useState<SessionState>(getSession);
  const [devices, setDevices] = useState<DevicesSnapshot | null>(null);
  useEffect(() => subscribeSession(setSession), []);

  const readDevices = useCallback(() => {
    void fetchDevices().then((snapshot) => {
      // Transient failure: keep the last list rather than lie about one.
      if (snapshot) setDevices(snapshot);
    });
  }, []);

  useEffect(() => {
    const first = setTimeout(readDevices, 0);
    window.addEventListener('topics:auth-pair-resolved', readDevices);
    window.addEventListener('topics:auth-device-revoked', readDevices);
    return () => {
      clearTimeout(first);
      window.removeEventListener('topics:auth-pair-resolved', readDevices);
      window.removeEventListener('topics:auth-device-revoked', readDevices);
    };
  }, [readDevices]);

  return {
    session,
    who: etichettaIdentita(presence.io, session),
    orgs: presence.orgs,
    friends,
    devices,
    readDevices,
  };
}

