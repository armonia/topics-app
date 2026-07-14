// Deep-link to a specific board task — a copyable URL from the drawer header
// ("copia link", for debug/sharing). Opening the URL opens the GLOBAL board
// pane and jumps its drawer straight to the task.
//
// Shape: <origin>/?task=<projectId>~<taskId>. Both ids contain '-' but never
// '~', so '~' is an unambiguous split point (a UUID taskId is fixed-length,
// but the projectId is a free-form slug, so split on the FIRST '~').

const PARAM = 'task';
const SEP = '~';

export function buildTaskLink(projectId: string, taskId: string): string {
  const u = new URL(window.location.origin);
  u.searchParams.set(PARAM, `${projectId}${SEP}${taskId}`);
  return u.toString();
}

export function parseTaskLink(search: string): { projectId: string; taskId: string } | null {
  try {
    const raw = new URLSearchParams(search).get(PARAM);
    if (!raw) return null;
    const i = raw.indexOf(SEP);
    if (i <= 0 || i >= raw.length - 1) return null;
    return { projectId: raw.slice(0, i), taskId: raw.slice(i + 1) };
  } catch {
    return null;
  }
}

// A boot-time target the board consumes on mount: the board pane mounts AFTER
// the open-utility event fires, so the target can't be delivered by event
// alone. One-shot — cleared on read.
let pending: { projectId: string; taskId: string } | null = null;

export function consumePendingTaskOpen(): { projectId: string; taskId: string } | null {
  const p = pending;
  pending = null;
  return p;
}

// Called once at boot (App). If the URL carries ?task=, open the global board
// and hand the target to it (module pending for a board that mounts now, plus
// a live event for one already open), then strip the param so a plain refresh
// doesn't keep reopening it.
export function openTaskFromUrl(): void {
  const target = parseTaskLink(window.location.search);
  if (!target) return;
  pending = target;
  window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'board' } }));
  window.dispatchEvent(new CustomEvent('topics:open-task', { detail: target }));
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete(PARAM);
    window.history.replaceState(null, '', u.toString());
  } catch {
    /* history unavailable — the link still worked, only the URL stays dirty */
  }
}
