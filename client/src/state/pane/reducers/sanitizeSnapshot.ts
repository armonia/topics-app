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

import type { Pane, PaneType, Group, ClosedPaneRecord, SpaceMeta, TombstoneMark } from '../types';
import { CLOSED_STACK_MAX, DEFAULT_SPACE_ID, PANE_TYPES, SPACES_MAX, TOMBSTONES_MAX, toTombstoneMark } from '../types';
// Stessa regola di PANE_TYPES qui sotto: la lista dei tipi di terminale si
// IMPORTA, non si ricopia. Le due whitelist scritte a mano che stavano più
// giù si erano fermate a tre valori e buttavano via `opencode` a ogni
// idratazione. `TERMINAL_AGENT_TYPES` e non `TERMINAL_SESSION_TYPES`: la
// seconda contiene anche il legacy `claude-code-team`, che non è assegnabile
// a `TerminalAgentType`.
import { TERMINAL_AGENT_TYPES, type TerminalAgentType } from '../../../../../shared/terminal-session-types';

export interface SanitizedSnapshot {
  panes?: Record<string, Pane>;
  groups?: Record<string, Group>;
  groupOrder?: string[];
  closedStack?: ClosedPaneRecord[];
  /** Durable close markers (paneId → closedAt ms) — merged per-id by the
   *  reducer, keeping the newest closedAt. See PaneState.tombstones: the
   *  FIFO-independent tombstone the HYDRATE strip consults. */
  tombstones?: Record<string, TombstoneMark>;
  /** Spazi registry — merged per-id by the reducer (mergeSpaces), never
   *  wholesale-applied. */
  spaces?: Record<string, SpaceMeta>;
  lastSeq?: number;
  /** Server-allocated LWW key — the reducer's HYDRATE gate compares this
   *  against state.lastServerSeq (server-vs-server, never the local dispatch
   *  counter). */
  server_seq?: number;
}

/**
 * Runtime whitelist for PaneType — the SINGLE source of truth is `PANE_TYPES`
 * in ../types.ts, from which the `PaneType` union is itself derived. This is a
 * re-export under the historical name `KNOWN_PANE_TYPES` for the existing
 * importers (reducers/panes.ts `inferTypeFromId`, the tests). Because it IS
 * `PANE_TYPES` — not a hand-copied mirror — the whitelist can never again fall
 * behind the union and silently drop a newly-added pane type on hydrate. That
 * drift bit twice (review-round-12 B2: `project`/`files`/`git`/`activity`/
 * `agents`/`process-log`/`session-viewer`; then `board`/`kanban`, which made
 * the "Board generale" tab vanish on every reload).
 *
 * Audit fix (still enforced below): sanitizePane drops panes whose type is not
 * in this list, so an adversarial payload with `{ type: "exec" }` can't slip
 * into the store.
 */
export const KNOWN_PANE_TYPES = PANE_TYPES;

/** true = la stringa è un tipo di terminale APRIBILE (shell/claude-code/codex/opencode). */
function isTerminalAgentType(v: unknown): v is TerminalAgentType {
  return typeof v === 'string' && (TERMINAL_AGENT_TYPES as readonly string[]).includes(v);
}

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
  // NOTE: a chat pane's `topicId` is OPTIONAL by design (types.ts) — the pane
  // id is `chat:<topicId>` and the topic is derived from the id, so a valid
  // pane may carry no separate `topicId` field. Do NOT drop chat panes here for
  // a missing topicId: the identity lives in the id, and the case where that
  // topic no longer resolves is a RENDER concern (degrade to an error tab, see
  // StandaloneChatGroup), not a store-admission one. Dropping at the door would
  // silently erase legitimate panes on hydrate.
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
  // Browser pane restorable URL — must round-trip so the tab reopens to its
  // page after restart (the browser analogue of chat's topicId).
  if (typeof raw.url === 'string') pane.url = raw.url;
  // Browser title provenance (auto page-title vs a user rename). Whitelisted so
  // a `user`-pinned tab name survives a server round-trip and the poll doesn't
  // resurrect the page title over it after a reload.
  if (raw.titleSource === 'auto' || raw.titleSource === 'user') pane.titleSource = raw.titleSource;
  if (typeof raw.diff === 'boolean') pane.diff = raw.diff;
  if (typeof raw.diffProjectPath === 'string') pane.diffProjectPath = raw.diffProjectPath;
  if (typeof raw.preview === 'boolean') pane.preview = raw.preview;
  if (typeof raw.color === 'string') pane.color = raw.color;
  if (typeof raw.processId === 'string') pane.processId = raw.processId;
  if (typeof raw.sessionKey === 'string') pane.sessionKey = raw.sessionKey;
  if (isTerminalAgentType(raw.terminalType)) {
    pane.terminalType = raw.terminalType;
  }
  // Causal open timestamp — the counterpart of the durable tombstone map.
  // MANDATORY whitelist entry: dropping it here would erase it on every
  // server round-trip, and the stale-marker retraction in the HYDRATE strip
  // (reducers/panes.ts) would never fire — re-opened tabs would keep dying
  // to ancient tombstones from stale peers (the B1/B2 silent-erase class).
  if (typeof raw.openedAt === 'number' && Number.isFinite(raw.openedAt)) {
    pane.openedAt = raw.openedAt;
  }
  // Il gemello CAUSALE di `openedAt`, e quello su cui la ritrattazione decide
  // davvero. Vale la stessa nota qui sopra, con gli interessi: senza questa voce
  // in whitelist il campo verrebbe cancellato a ogni giro sul server, e la
  // regola ricadrebbe per sempre sul ramo «manca il seq → vince il marcatore»,
  // cioe' una pane legittimamente riaperta morirebbe a ogni idratazione.
  if (typeof raw.openedSeq === 'number' && Number.isFinite(raw.openedSeq)) {
    pane.openedSeq = raw.openedSeq;
  }
  // Spazio membership — SYNCED per-pane (absent ⟺ default space). MANDATORY
  // whitelist entry: dropping it here would erase membership on every server
  // round-trip (the B1/B2 silent-erase class). The default id is normalised
  // to absent so the wire encoding stays canonical.
  if (typeof raw.spaceId === 'string' && raw.spaceId && raw.spaceId !== DEFAULT_SPACE_ID) {
    pane.spaceId = raw.spaceId;
  }
  return pane;
}

/**
 * Validate a Spazi registry from an untrusted snapshot. Same shape as the
 * other sanitizers: structural per-record check, coerce the scalars, drop
 * garbage. The DEFAULT space is implicit (never a record), so an entry
 * claiming its id is dropped — a remote payload must not rename/delete the
 * default. Capped at SPACES_MAX keeping the most-recently-updated records
 * (matches mergeSpaces' backstop).
 */
function sanitizeSpaces(raw: unknown): Record<string, SpaceMeta> | null {
  if (!isPlainObject(raw)) return null;
  const out: Record<string, SpaceMeta> = {};
  for (const [key, v] of Object.entries(raw)) {
    if (!isPlainObject(v)) continue;
    if (typeof v.id !== 'string' || !v.id || v.id !== key) continue;
    if (v.id === DEFAULT_SPACE_ID) continue;
    const meta: SpaceMeta = {
      id: v.id,
      name: typeof v.name === 'string' ? v.name : '',
      order: typeof v.order === 'number' && Number.isFinite(v.order) ? v.order : 0,
      updatedAt:
        typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt) ? v.updatedAt : 0,
    };
    if (v.deleted === true) meta.deleted = true;
    out[key] = meta;
  }
  const ids = Object.keys(out);
  if (ids.length <= SPACES_MAX) return out;
  const kept = ids
    .sort((a, b) => out[b].updatedAt - out[a].updatedAt)
    .slice(0, SPACES_MAX);
  const capped: Record<string, SpaceMeta> = {};
  for (const id of kept) capped[id] = out[id];
  return capped;
}

/**
 * Validate the durable tombstone map (paneId → closedAt ms) from an untrusted
 * snapshot: keep string→finite-number pairs, drop garbage, cap at TOMBSTONES_MAX
 * keeping the most-recently-closed ids (mirrors the reducer's capTombstones and
 * sanitizeClosedStack's keep-the-tail rule).
 */
/**
 * Accetta ENTRAMBE le forme: il numero nudo (legacy, solo orologio) e il
 * marcatore `{at, seq}`. `toTombstoneMark` normalizza il primo a `seq: 0`, cioe'
 * «non so a che punto della storia condivisa e' avvenuta questa chiusura» → in
 * `HYDRATE` decide il marcatore. E' la direzione sicura: al massimo si richiude
 * una pane davvero riaperta, mai il contrario.
 */
function sanitizeTombstones(raw: unknown): Record<string, TombstoneMark> | null {
  if (!isPlainObject(raw)) return null;
  const out: Record<string, TombstoneMark> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (typeof id !== 'string' || !id) continue;
    const mark = toTombstoneMark(v);
    if (mark) out[id] = mark;
  }
  const ids = Object.keys(out);
  if (ids.length <= TOMBSTONES_MAX) return out;
  const kept = ids.sort((a, b) => out[b].at - out[a].at).slice(0, TOMBSTONES_MAX);
  const capped: Record<string, TombstoneMark> = {};
  for (const id of kept) capped[id] = out[id];
  return capped;
}

function sanitizeGroup(raw: unknown): Group | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (!Array.isArray(raw.paneIds)) return null;
  const rawPaneIds = raw.paneIds.filter(
    (x): x is string => typeof x === 'string' && !x.startsWith('draft:'),
  );
  // Dedup within the group: a paneId listed twice would render its content (and
  // its whole window) twice — the GroupLayout render guard catches it at the last
  // mile, but scrub it here too so the duplicate never even enters the store.
  const seenInGroup = new Set<string>();
  const paneIds = rawPaneIds.filter((id) => (seenInGroup.has(id) ? false : (seenInGroup.add(id), true)));
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
    // Drafts are device-local pre-promotion scratch panes (mirror of
    // selectSyncableSnapshot's outbound stripping). Drop them on inbound so a
    // cross-tab storage event from a sibling tab can't seed someone else's
    // draft into this tab's store.
    if (key.startsWith('draft:')) continue;
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
  // Cross-group dedup: a paneId may legally live in only ONE group — the
  // OPEN_PANE reducer enforces this single-home invariant by removing a pane
  // from any other group before insert. A snapshot that lists the same paneId
  // in two groups would render the pane (and its window) twice. Keep it in the
  // FIRST group that claims it (insertion order) and strip it from later ones.
  const claimed = new Set<string>();
  for (const key of Object.keys(out)) {
    const g = out[key];
    out[key] = { ...g, paneIds: g.paneIds.filter((id) => (claimed.has(id) ? false : (claimed.add(id), true))) };
  }
  return out;
}

/**
 * Structural sanitizer for `ClosedPaneRecord.terminal`. Accepts only the
 * documented ClosedTerminalMeta fields (each individually validated) and
 * drops everything else — previously we cast the whole object through with a
 * bare `isPlainObject` check, which let arbitrary adversarial fields ride
 * along.
 */
function sanitizeTerminal(raw: unknown): ClosedPaneRecord['terminal'] | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: NonNullable<ClosedPaneRecord['terminal']> = {};
  if (typeof raw.sessionId === 'string') out.sessionId = raw.sessionId;
  if (typeof raw.cwd === 'string') out.cwd = raw.cwd;
  if (isTerminalAgentType(raw.sessionType)) {
    out.sessionType = raw.sessionType;
  }
  if (typeof raw.name === 'string') out.name = raw.name;
  if (typeof raw.claudeSessionId === 'string') out.claudeSessionId = raw.claudeSessionId;
  if (typeof raw.skipPermissions === 'boolean') out.skipPermissions = raw.skipPermissions;
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
  // Entity-ref invariant: every group paneId must have a matching `panes`
  // record. An entity-less ref renders a ghost tab whose X used to be a
  // no-op (CLOSE_PANE bails without the pane record — observed live with a
  // `__board__` ref stranded in group:default). Prune violations at the
  // door, but ONLY when the payload carried both maps — a groups-only
  // partial must not be emptied against an absent panes map.
  if (out.panes && out.groups) {
    const panes = out.panes;
    for (const [key, g] of Object.entries(out.groups)) {
      const kept = g.paneIds.filter((id) => Boolean(panes[id]));
      if (kept.length !== g.paneIds.length) {
        out.groups[key] = { ...g, paneIds: kept };
      }
    }
  }
  if (Array.isArray(raw.groupOrder)) {
    out.groupOrder = raw.groupOrder.filter((x): x is string => typeof x === 'string');
  }
  if (raw.closedStack !== undefined) {
    const cs = sanitizeClosedStack(raw.closedStack);
    if (cs) out.closedStack = cs;
  }
  if (raw.tombstones !== undefined) {
    const tb = sanitizeTombstones(raw.tombstones);
    if (tb) {
      // La chiave parallela `tombstoneSeqs` porta la grandezza causale accanto
      // alla mappa di numeri retrocompatibile (vedi selectors.ts). Un client
      // vecchio non la scrive: allora ogni seq resta 0 e decide il marcatore,
      // che e' la direzione sicura.
      if (isPlainObject(raw.tombstoneSeqs)) {
        for (const [id, v] of Object.entries(raw.tombstoneSeqs)) {
          if (tb[id] && typeof v === 'number' && Number.isFinite(v) && v > 0) tb[id].seq = v;
        }
      }
      out.tombstones = tb;
    }
  }
  if (raw.spaces !== undefined) {
    const sp = sanitizeSpaces(raw.spaces);
    if (sp) out.spaces = sp;
  }
  if (typeof raw.lastSeq === 'number' && Number.isFinite(raw.lastSeq)) {
    out.lastSeq = raw.lastSeq;
  }
  if (typeof raw.server_seq === 'number' && Number.isFinite(raw.server_seq)) {
    out.server_seq = raw.server_seq;
  }
  // Top-level `focusedPaneId` is DEVICE-LOCAL — intentionally ignored, not
  // propagated from the server side. Drop it silently.
  // Top-level `activeSpaceId` is likewise DEVICE-LOCAL (the focusedPaneId
  // pattern): device A switching Spazi must never yank device B's view.
  // Symmetric with the outbound exclusion in selectors.ts — drop it silently.
  return out;
}
