/**
 * The live half of `projectSharing.ts`: who is in which organisation, which
 * project belongs to which, kept current while the app runs.
 *
 * ONE STORE AND NOT A FETCH PER TAB. Every open project tab asks the same two
 * questions, and a tab bar can hold a dozen of them. Worse than the traffic
 * would be the disagreement: two tabs that fetched at different instants would
 * answer differently about the same project, and neither would look wrong.
 *
 * WHY IT LISTENS TO THE SOCKET. The mark has to disappear the moment a project
 * is withdrawn from its organisation — that is the whole request: «senza
 * ricaricare». The server already emits `project:updated` after every project
 * mutation (`PROJECT-03`), and to a client that must no longer see the row it
 * emits `project:deleted` with the bare id instead (`envelopeProgettoPer`).
 * Both are handled here, and the second one is the interesting one: for
 * everyone except the owner, "made incognito" ARRIVES as a deletion.
 *
 * WHAT IT DOES NOT DO. No periodic refresh. Membership changes are rare and
 * already cost a reload elsewhere; polling every tab bar for them would spend
 * a request a minute to change nothing. The recovery hooks below (visibility,
 * online, focus) are for the one case that matters on a long-lived document —
 * the installed PWA that iOS freezes and resumes — where the FIRST fetch is
 * the one that failed, and without them there would be no second.
 */
import { useSyncExternalStore } from 'react';
import { subscribeFrames } from './wsFrameBus';
import { sharedWith, type OrgRef, type ProjectSharing } from './projectSharing';

let projects: Map<string, ProjectSharing> | null = null;
let orgs: Map<string, OrgRef> | null = null;
let inflight: Promise<void> | null = null;
let lastFailAt = 0;
const listeners = new Set<() => void>();

/** Short on purpose: the failure window here is a server restart or a network
 *  change, i.e. seconds. Not a growing backoff — there is no burst to contain,
 *  because retries are driven by mounts and wakeups, one at a time. */
const RETRY_AFTER_MS = 3000;

const NO_PROJECTS: ReadonlyMap<string, ProjectSharing> = new Map();
const NO_ORGS: ReadonlyMap<string, OrgRef> = new Map();

function publish(): void {
  listeners.forEach((cb) => cb());
}

interface ProjectRow { path?: string; orgId?: string | null; incognito?: boolean; id?: string }
interface OrgRow { id: string; name: string; logo_url?: string | null; members?: number }

/** A row from the REST list or from a socket frame, in the narrow shape the
 *  decision reads. `null` when the row carries no path — a `project:deleted`
 *  envelope, which is handled by id instead. */
function toSharing(row: ProjectRow): ProjectSharing | null {
  if (typeof row.path !== 'string' || !row.path) return null;
  return { path: row.path, orgId: row.orgId ?? null, incognito: row.incognito === true };
}

async function fetchOnce(): Promise<void> {
  if (projects !== null && orgs !== null) return;
  if (inflight) return inflight;
  inflight = (async () => {
    // In parallel: they are independent, and in series the answer would wait
    // on the slower of two round trips for no reason.
    const [pRes, oRes] = await Promise.allSettled([
      fetch('/api/projects', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)),
      fetch('/api/auth/orgs', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)),
    ]);

    const pBody = pRes.status === 'fulfilled' ? (pRes.value as { projects?: ProjectRow[] } | null) : null;
    const oBody = oRes.status === 'fulfilled' ? (oRes.value as { orgs?: OrgRow[] } | null) : null;

    // "I do not know" stays null and never becomes an empty map: an empty map
    // is an ANSWER (nothing is shared), and writing one here would silence the
    // badge for the life of the document while looking perfectly healthy.
    // Same rule, same reason, as `boardProjectsStore`.
    if (pBody?.projects) {
      projects = new Map();
      for (const r of pBody.projects) {
        const s = toSharing(r);
        if (s) projects.set(s.path, s);
      }
    }
    if (oBody?.orgs) {
      orgs = new Map(oBody.orgs.map((o) => [o.id, {
        id: o.id,
        name: o.name,
        logoUrl: o.logo_url ?? null,
        // An installation whose accounts service does not report a count is
        // treated as ONE member: silence, not a badge on everything.
        members: typeof o.members === 'number' ? o.members : 1,
      }]));
    }
    if (projects === null || orgs === null) lastFailAt = Date.now();
    else lastFailAt = 0;

    inflight = null;
    publish();
  })();
  return inflight;
}

/**
 * The socket keeps the project half current. The org half is NOT refreshed
 * here: no frame carries membership, and inventing one would mean a second
 * definition of "who is in this org" — the mistake `project-visibility.ts`
 * documents at length on the server side.
 */
let socketArmed = false;
function armSocket(): void {
  if (socketArmed) return;
  socketArmed = true;
  subscribeFrames(
    (frame) => {
      const f = frame as { type?: string; project?: ProjectRow };
      if (!f?.project) return;
      if (f.type === 'project:deleted') {
        // The retraction: for everyone but the owner, "withdrawn from the
        // organisation" arrives exactly like this. Its envelope carries the id
        // and NOTHING ELSE — deliberately, so it leaks no name or path — while
        // this index is keyed by path. There is nothing to delete in place, so
        // the list is rebuilt: one request on a rare event, against a second
        // id→path index that could disagree with the first.
        if (projects !== null) void refetchProjects();
        return;
      }
      const s = toSharing(f.project);
      if (!s || !projects) return;
      // A new Map, not a mutation: `useSyncExternalStore` compares snapshots,
      // and a map mutated in place is the same object.
      projects = new Map(projects).set(s.path, s);
      publish();
    },
    { types: ['project:new', 'project:updated', 'project:archived', 'project:deleted'] },
  );
}

/** Only the project list, after a retraction whose envelope carries no path. */
async function refetchProjects(): Promise<void> {
  try {
    const body = await fetch('/api/projects', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null)) as { projects?: ProjectRow[] } | null;
    if (!body?.projects) return;
    const next = new Map<string, ProjectSharing>();
    for (const r of body.projects) {
      const s = toSharing(r);
      if (s) next.set(s.path, s);
    }
    projects = next;
    publish();
  } catch { /* the next frame or the next mount tries again */ }
}

let recoveryArmed = false;
function armRecovery(): void {
  // The guard asks for the capabilities the body USES, and they live on two
  // objects: a partial `document` (test stubs) or a missing `window` would
  // otherwise throw inside a subscribe.
  if (
    recoveryArmed ||
    typeof document === 'undefined' ||
    typeof document.addEventListener !== 'function' ||
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) return;
  recoveryArmed = true;
  const recover = () => {
    if (document.hidden) return;
    if ((projects === null || orgs === null) && !inflight) void fetchOnce();
  };
  document.addEventListener('visibilitychange', recover);
  window.addEventListener('online', recover);
  window.addEventListener('focus', recover);
}

export function subscribeProjectSharing(cb: () => void): () => void {
  listeners.add(cb);
  armSocket();
  armRecovery();
  if ((projects === null || orgs === null) && !inflight && Date.now() - lastFailAt >= RETRY_AFTER_MS) {
    void fetchOnce();
  }
  return () => { listeners.delete(cb); };
}

/**
 * The organisation a project is shared with, reactively — `null` while the
 * indexes are still missing, and `null` for everything the rules in
 * `projectSharing.ts` call "nobody else".
 *
 * The returned object is the one held in the org index, so it keeps its
 * identity across project frames: `useSyncExternalStore` would otherwise see a
 * new snapshot on every socket message and re-render every tab.
 */
export function useSharedOrg(path: string | null | undefined): OrgRef | null {
  const read = () => sharedWith(path, projects ?? NO_PROJECTS, orgs ?? NO_ORGS);
  // Server-side / first paint: nothing is known, so nothing is claimed.
  return useSyncExternalStore(subscribeProjectSharing, read, () => null);
}
