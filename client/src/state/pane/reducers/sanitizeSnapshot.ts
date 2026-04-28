/**
 * Runtime validator + sanitizer for snapshots arriving from server / cross-tab.
 *
 * Why this exists (blocker B3 in the PR review):
 *   - Direct casts (`snapshot.panes as PaneState['panes']`) disabled the type
 *     system. A malformed or adversarial payload could inject arbitrary fields,
 *     including DEVICE-LOCAL ones (`scrollOffset` on panes, `focusedPaneId` at
 *     the top level) — corrupting per-device state (e.g. "remember my scroll"
 *     gets overwritten by the other device's scroll position).
 *   - CONTEXT.md §Sync strategy locks that device-local fields NEVER cross the
 *     network. The server-outbound side is enforced by `selectSyncableSnapshot`;
 *     this file is the symmetric inbound enforcement.
 *
 * Contract:
 *   - Returns `null` if the candidate is not a plausible snapshot (not an
 *     object, corrupt shape on a required field).
 *   - Otherwise returns a *copy* with every device-local field stripped.
 *     Reducer callers can assign directly onto Immer draft without further
 *     casting.
 */

import type { Pane, PaneType, Group, ProjectLayout, ClosedPaneRecord } from '../types';
import { CLOSED_STACK_MAX } from '../types';

export interface SanitizedSnapshot {
  panes?: Record<string, Pane>;
  groups?: Record<string, Group>;
  projects?: Record<string, ProjectLayout>;
  groupOrder?: string[];
  closedStack?: ClosedPaneRecord[];
  lastSeq?: number;
}

/**
 * Runtime whitelist for PaneType. Kept in sync with the `PaneType` union in
 * ../types.ts. Exported so tests can assert the set and so other call sites
 * (e.g. reducers/panes.ts inferTypeFromId) can share the authoritative list.
 *
 * Audit fix: sanitizePane previously cast `raw.type as Pane['type']` without
 * narrowing. An adversarial payload with `{ type: "exec" }` would slip through
 * into the store. We now drop panes whose type is not in this list.
 */
// Keep in sync with the `PaneType` union (types.ts). Review-round-12 B2: this
// list previously omitted every legacy-only type (`project`, `files`, `git`,
// `activity`, `agents`, `all-boards`, `process-log`, `session-viewer`). Those
// types are still dispatched by the running app (see buildSidebarItems,
// StandaloneChatGroup, ProjectWindow), so sanitizePane dropped them on every
// HYDRATE_FROM_SNAPSHOT — i.e. every server broadcast silently erased any
// non-enumerated pane from the user's layout.
export const KNOWN_PANE_TYPES = [
  // Runtime-active types (current app surface)
  'chat',
  'file',
  'files',
  'browser',
  'git',
  'terminal',
  'activity',
  'journal',
  'agents',
  'board',
  'board-memory',
  'dashboard',
  'all-boards',
  'project',
  'process-log',
  'session-viewer',
  // Reserved (opt-in future work)
  'agent',
  'session',
  'context',
  'editor',
  'webhooks',
  'cron',
  'remote-access',
  'system-status',
  'processes',
] as const satisfies readonly PaneType[];

function isKnownPaneType(v: unknown): v is PaneType {
  return typeof v === 'string' && (KNOWN_PANE_TYPES as readonly string[]).includes(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function sanitizePane(raw: unknown): Pane | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (!isKnownPaneType(raw.type)) return null;
  // Strip `scrollOffset` — device-local per CONTEXT.md. Every other field in
  // the Pane shape (types.ts) must be whitelisted here, otherwise a server
  // round-trip silently erases it. Review-round-12 B1: legacy fields
  // (`diff`, `diffProjectPath`, `preview`, `color`, `processId`, `sessionKey`,
  // `terminalType`) were dropped here, wiping tab metadata on every hydrate.
  // Title is optional (legacy call sites sometimes omit it); coerce to empty
  // string so consumers don't have to handle `undefined` explicitly.
  const pane: Pane = {
    id: raw.id,
    type: raw.type,
    title: typeof raw.title === 'string' ? raw.title : '',
  };
  // `stableKey` survives PANE_ID_REMAP (draft → real topic promotion) so the
  // React tab list key doesn't change mid-flight. Strip it from inbound
  // hydrates would force every promoted pane to re-key on the next sync, which
  // is exactly the flash we're trying to avoid — whitelist it.
  if (typeof raw.stableKey === 'string') pane.stableKey = raw.stableKey;
  if (typeof raw.topicId === 'string') pane.topicId = raw.topicId;
  if (typeof raw.projectPath === 'string') pane.projectPath = raw.projectPath;
  if (typeof raw.filePath === 'string') pane.filePath = raw.filePath;
  if (typeof raw.terminalSessionId === 'string') pane.terminalSessionId = raw.terminalSessionId;
  if (typeof raw.diff === 'boolean') pane.diff = raw.diff;
  if (typeof raw.diffProjectPath === 'string') pane.diffProjectPath = raw.diffProjectPath;
  if (typeof raw.preview === 'boolean') pane.preview = raw.preview;
  if (typeof raw.color === 'string') pane.color = raw.color;
  if (typeof raw.processId === 'string') pane.processId = raw.processId;
  if (typeof raw.sessionKey === 'string') pane.sessionKey = raw.sessionKey;
  if (raw.terminalType === 'shell' || raw.terminalType === 'claude-code') {
    pane.terminalType = raw.terminalType;
  }
  return pane;
}

function sanitizeGroup(raw: unknown): Group | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (!Array.isArray(raw.paneIds)) return null;
  const paneIds = raw.paneIds.filter((x): x is string => typeof x === 'string');
  // `typeof NaN === 'number'` — without the Number.isFinite check NaN would
  // ride through and poison every downstream layout calc. Range-clamp to the
  // same window the runtime reducer uses (groups.ts clampRatio) so an
  // adversarial payload with splitRatio=1e9 can't strand a pane off-screen.
  const rawRatio = raw.splitRatio;
  const splitRatio =
    typeof rawRatio === 'number' && Number.isFinite(rawRatio)
      ? Math.min(0.95, Math.max(0.05, rawRatio))
      : 0.5;
  const splitAxisIsValid = raw.splitAxis === 'vertical' || raw.splitAxis === 'horizontal';
  const splitAxis: 'vertical' | 'horizontal' = raw.splitAxis === 'vertical' ? 'vertical' : 'horizontal';
  // Nice-to-have (N1): warn in dev when we silently coerce an unexpected
  // value. Helps spot a buggy server/cross-tab payload that would otherwise
  // look fine post-sanitize. Production bundles strip import.meta.env.DEV.
  if (!splitAxisIsValid && raw.splitAxis !== undefined && import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(
      '[sanitizeSnapshot] group.splitAxis coerced to "horizontal":',
      raw.splitAxis,
      'on group id:',
      raw.id,
    );
  }
  return { id: raw.id, paneIds, splitRatio, splitAxis };
}

function sanitizePanes(raw: unknown): Record<string, Pane> | null {
  if (!isPlainObject(raw)) return null;
  const out: Record<string, Pane> = {};
  for (const [key, v] of Object.entries(raw)) {
    const p = sanitizePane(v);
    if (p && p.id === key) out[key] = p;
  }
  return out;
}

function sanitizeGroups(raw: unknown): Record<string, Group> | null {
  if (!isPlainObject(raw)) return null;
  const out: Record<string, Group> = {};
  for (const [key, v] of Object.entries(raw)) {
    const g = sanitizeGroup(v);
    if (g && g.id === key) out[key] = g;
  }
  return out;
}

function sanitizeProjects(raw: unknown): Record<string, ProjectLayout> | null {
  if (!isPlainObject(raw)) return null;
  // ProjectLayout is a complex nested shape; accept by structural check but
  // strip device-local focusedPaneId and scrollOffsets inside panes.
  const out: Record<string, ProjectLayout> = {};
  for (const [key, v] of Object.entries(raw)) {
    if (!isPlainObject(v)) continue;
    if (typeof v.projectPath !== 'string') continue;
    if (!Array.isArray(v.groups)) continue;
    const groups = v.groups.map((g) => sanitizeGroup(g)).filter((g): g is Group => g !== null);
    const panes = sanitizePanes(v.panes) ?? {};
    const groupOrder = Array.isArray(v.groupOrder) ? v.groupOrder.filter((x): x is string => typeof x === 'string') : [];
    const tabOrder = Array.isArray(v.tabOrder) ? v.tabOrder.filter((x): x is string => typeof x === 'string') : [];
    const lastOpenedAt = typeof v.lastOpenedAt === 'number' ? v.lastOpenedAt : Date.now();
    // focusedPaneId in projects IS part of the synced layout (CONTEXT.md
    // §Undo-and-project-tab-reopen says layout includes focused-pane). Keep it.
    const focusedPaneId = typeof v.focusedPaneId === 'string' ? v.focusedPaneId : null;
    out[key] = { projectPath: v.projectPath, groups, panes, groupOrder, tabOrder, focusedPaneId, lastOpenedAt };
  }
  return out;
}

/**
 * Structural sanitizer for `ClosedPaneRecord.terminal`. Accepts only the two
 * documented optional string fields (`sessionId`, `cwd`) and drops everything
 * else — previously we cast the whole object through with a bare
 * `isPlainObject` check, which let arbitrary adversarial fields ride along.
 */
function sanitizeTerminal(raw: unknown): ClosedPaneRecord['terminal'] | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: NonNullable<ClosedPaneRecord['terminal']> = {};
  if (typeof raw.sessionId === 'string') out.sessionId = raw.sessionId;
  if (typeof raw.cwd === 'string') out.cwd = raw.cwd;
  return out;
}

function sanitizeClosedStack(raw: unknown): ClosedPaneRecord[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ClosedPaneRecord[] = [];
  for (const v of raw) {
    if (!isPlainObject(v)) continue;
    const pane = sanitizePane(v.pane);
    if (!pane) continue;
    if (typeof v.id !== 'string') continue;
    if (typeof v.closedAt !== 'number') continue;
    if (typeof v.groupId !== 'string') continue;
    if (typeof v.groupIndex !== 'number') continue;
    if (v.level !== 'project' && v.level !== 'app') continue;
    const record: ClosedPaneRecord = {
      id: v.id,
      closedAt: v.closedAt,
      pane,
      groupId: v.groupId,
      groupIndex: v.groupIndex,
      level: v.level,
      projectPath: typeof v.projectPath === 'string' ? v.projectPath : undefined,
      // Audit fix: ClosedPaneRecord declares top-level `topicId` and
      // `filePath` (types.ts). The CLOSE_PANE reducer writes them
      // (panes.ts) so undo can restore context on cross-device hydration.
      // Previously these were dropped here — so a sanitized record lost
      // the outer refs even though the nested `pane` carried them.
      topicId: typeof v.topicId === 'string' ? v.topicId : undefined,
      filePath: typeof v.filePath === 'string' ? v.filePath : undefined,
      terminal: sanitizeTerminal(v.terminal),
      splitRatio: typeof v.splitRatio === 'number' ? v.splitRatio : undefined,
      splitAxis: (v.splitAxis === 'horizontal' || v.splitAxis === 'vertical') ? v.splitAxis : undefined,
      // ClosedPaneRecord.scrollOffset is DEVICE-LOCAL — symmetric inbound
      // enforcement of the outbound strip in `selectSyncableSnapshot`.
      // CLOSE_PANE no longer writes it onto the record, but a legacy payload
      // (older build / stale localStorage / adversarial WS) may still carry
      // it. Drop it here so UNDO_CLOSE can't accidentally restore another
      // device's scroll position.
      scrollOffset: undefined,
      focusedAtClose: typeof v.focusedAtClose === 'boolean' ? v.focusedAtClose : false,
      tabOrderSnapshot: Array.isArray(v.tabOrderSnapshot)
        ? v.tabOrderSnapshot.filter((x): x is string => typeof x === 'string')
        : [],
      seq: typeof v.seq === 'number' ? v.seq : 0,
    };
    out.push(record);
  }
  // Clamp to CLOSED_STACK_MAX — a malformed or adversarial snapshot must not
  // blow up the in-memory stack with unbounded entries. Keep the TAIL (most
  // recently closed) because CLOSE_PANE pushes to the end and the reducer's
  // FIFO drop in panes.ts uses `.shift()` to evict the oldest. Review-round-12
  // B3: previously `slice(0, MAX)` kept the OLDEST entries, throwing away the
  // most-undo-relevant ones on any >50-entry hydrate.
  return out.slice(-CLOSED_STACK_MAX);
}

/**
 * Validate + sanitize a candidate snapshot from an untrusted source
 * (server PUT response, WS broadcast, cross-tab storage event, localStorage).
 * Returns `null` if the root shape is unusable. Otherwise returns only the
 * fields that are safe to apply via HYDRATE_FROM_SNAPSHOT, with all
 * device-local data stripped.
 */
export function sanitizeSnapshot(raw: unknown): SanitizedSnapshot | null {
  if (!isPlainObject(raw)) return null;
  const out: SanitizedSnapshot = {};
  if (raw.panes !== undefined) {
    const p = sanitizePanes(raw.panes);
    if (p) out.panes = p;
  }
  if (raw.groups !== undefined) {
    const g = sanitizeGroups(raw.groups);
    if (g) out.groups = g;
  }
  if (raw.projects !== undefined) {
    const pr = sanitizeProjects(raw.projects);
    if (pr) out.projects = pr;
  }
  if (Array.isArray(raw.groupOrder)) {
    out.groupOrder = raw.groupOrder.filter((x): x is string => typeof x === 'string');
  }
  if (raw.closedStack !== undefined) {
    const cs = sanitizeClosedStack(raw.closedStack);
    if (cs) out.closedStack = cs;
  }
  if (typeof raw.lastSeq === 'number' && Number.isFinite(raw.lastSeq)) {
    out.lastSeq = raw.lastSeq;
  }
  // Top-level `focusedPaneId` is DEVICE-LOCAL — intentionally ignored, not
  // propagated from the server side. Drop it silently.
  return out;
}
