/**
 * WHO YOU ARE AND WHO YOU ARE WITH: one source for the two subjects that read
 * the same data.
 *
 * The identity chip and the organisations chip ask different questions off the
 * SAME reads: the organisations, their members with the last access, the
 * address book with the faces. Two components fetching all of that on their own
 * would be two round trips for one, and two different instants.
 *
 * THE FRIENDS SUBJECT IS NOT HERE ANY MORE. It used to be computed from these
 * very lists, which is what made it "everyone who shares a group with you"
 * rather than your friends. It reads the friendship graph now
 * (`useFriendship`), on its own timer, and this hook stopped publishing the
 * three `amici*` fields nobody could have made honest.
 *
 * HOW OFTEN. One minute, exactly as the identity row did before this hook: the
 * online threshold is five minutes (`PRESENZA_MS`), so recounting more often
 * would not change a single face and would cost one fetch per organisation. A
 * hidden window asks for nothing, which is the same rule `usePresenceSummary`
 * and `useSystemStatus` already follow.
 *
 * WHEN THE ACCOUNTS SERVICE IS NOT THERE. On an installation with no
 * organisations these routes do not answer: we end up with no rows rather than
 * showing zeros. "I do not know" is said by keeping quiet, not with an invented
 * number: it is the same choice already written down in `orgPresence.ts`.
 */
import { useCallback, useEffect, useState } from 'react';
import { peopleApi, type PersonWithProfile } from '@/lib/api';
import {
  facceOnline, presentiOra, gentePresenza,
  type PresenceFace, type MembroPresenza, type PresenceRow,
} from '@/components/Sidebar/orgPresence';

/** One organisation, with whoever is present inside it right now. */
export interface OrgWithPresence {
  id: string;
  nome: string;
  logoUrl: string | null;
  /** The organisation of THIS installation: the one shown first. */
  installazione: boolean;
  /** How many OTHER members are online right now. */
  online: number;
  /** How many members it has in total (you included): the "2 of 7" denominator. */
  membri: number;
  /** The faces of whoever is online, already sorted. */
  faces: PresenceFace[];
  /** EVERY member, present ones first: the list the dropdown opens onto. */
  people: PresenceRow[];
}

export interface PresenceIdentity {
  /** The organisations, the installation's own one first. */
  orgs: OrgWithPresence[];
  /** Me, from the address book: the face and the name on the first row. */
  io: PersonWithProfile | null;
  /** `false` until the first round trip is back, so the rows do not flicker. */
  pronto: boolean;
}

const EMPTY: PresenceIdentity = { orgs: [], io: null, pronto: false };

/** Every minute: the online threshold is five, so recounting more often
 *  changes nothing and costs one fetch per organisation. */
const INTERVAL_MS = 60_000;

interface OrgApi {
  id: string;
  name: string;
  logo_url: string | null;
  installation?: boolean;
}

/** How many organisations actually get queried. Past this the row could not
 *  show them all anyway, and every extra org is one more fetch. */
const MAX_ORG = 8;

export function useIdentityPresence(enabled = true, intervalMs = INTERVAL_MS): PresenceIdentity {
  const [state, setStato] = useState<PresenceIdentity>(EMPTY);

  const read = useCallback(async () => {
    if (document.hidden) return;
    // The address book and the organisations in parallel: they are
    // independent, and in series the friends row would wait on the org row for
    // no reason at all.
    const [rubricaRes, orgsRes] = await Promise.allSettled([
      peopleApi.list(),
      fetch('/api/auth/orgs', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)),
    ]);

    const rubrica: PersonWithProfile[] = rubricaRes.status === 'fulfilled' ? rubricaRes.value.people : [];
    const io = rubrica.find((p) => p.isMe) ?? null;
    const orgsRaw: OrgApi[] = orgsRes.status === 'fulfilled' && orgsRes.value
      ? ((orgsRes.value as { orgs?: OrgApi[] }).orgs ?? [])
      : [];

    // The installation's organisation first, the rest alphabetically: yours is
    // the one you actually look at, not the one the database happens to return
    // first.
    const ordinate = [...orgsRaw]
      .sort((a, b) => Number(!!b.installation) - Number(!!a.installation) || a.name.localeCompare(b.name))
      .slice(0, MAX_ORG);

    const adesso = Date.now();
    const mioId = io?.id ?? null;
    const withMembers = await Promise.all(ordinate.map(async (o): Promise<OrgWithPresence> => {
      let membri: MembroPresenza[] = [];
      try {
        const r = await fetch(`/api/auth/orgs/${encodeURIComponent(o.id)}/members`, { credentials: 'same-origin' });
        if (r.ok) membri = ((await r.json()) as { members?: MembroPresenza[] }).members ?? [];
      } catch { /* an org that does not answer keeps no presence, it does not vanish */ }
      return {
        id: o.id,
        nome: o.name,
        logoUrl: o.logo_url ?? null,
        installazione: !!o.installation,
        online: presentiOra(membri, mioId, adesso),
        membri: membri.length,
        faces: facceOnline(membri, rubrica, mioId, adesso),
        people: gentePresenza(membri, rubrica, mioId, adesso),
      };
    }));

    setStato({ orgs: withMembers, io, pronto: true });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const giro = () => { if (alive) void read(); };
    // After the first paint, not during it: at the bottom of the sidebar none
    // of these numbers is needed in the first frame, and a synchronous state
    // write on mount is exactly what `set-state-in-effect` flags.
    const first = setTimeout(giro, 0);
    const each = setInterval(giro, intervalMs);
    const atReturn = () => { if (!document.hidden) giro(); };
    document.addEventListener('visibilitychange', atReturn);
    // A device that has just been paired changes WHO YOU ARE: waiting for the
    // next minute would mean showing the old identity at the very instant
    // somebody is looking to check that the pairing went through.
    window.addEventListener('topics:auth-pair-resolved', giro);
    window.addEventListener('topics:auth-device-revoked', giro);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(each);
      document.removeEventListener('visibilitychange', atReturn);
      window.removeEventListener('topics:auth-pair-resolved', giro);
      window.removeEventListener('topics:auth-device-revoked', giro);
    };
  }, [enabled, intervalMs, read]);

  return state;
}
