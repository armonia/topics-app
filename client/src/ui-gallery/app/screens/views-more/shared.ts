/**
 * What the views and channels screens share: the state they keep in the
 * `views` and `channels` slices, how a view is found and where it opens, and
 * the small helpers that turn a case into the things the screens print.
 */
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { caseSeed } from '../../store/cases';
import type { BlockId } from '../../../../ui/views/model';
import { ORG_VIEW_IDS, VIEW_LIBRARY, VIEW_ROLES, type StepUse, type ViewScope, type ViewSeed } from '../../../../ui/fixtures/views';
import { CASES } from '../../../../ui/fixtures/org/cases';
import type { CaseSeed } from '../../../../ui/fixtures/org/types';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { type ChannelSeed, type ChannelState, type RoutingRule } from '../../../../ui/fixtures/channels';

/* ---------- the views slice ---------- */

export interface CustomView {
  id: string;
  name: string;
  description: string;
  blocks: BlockId[];
  kind: string;
  /** YYYY-MM-DD, the demo's day it was made. */
  createdAt: string;
}

export interface WhereState {
  /** Steps of the seed switched off, as `flow:step`. */
  off: string[];
  /** Steps the reader added. */
  added: StepUse[];
  /** Roles switched on or off against the starting point. */
  roles: Record<string, boolean>;
  desktop: boolean;
  phone: boolean;
  opensAs: 'tab' | 'side';
}

export interface DecisionRecord {
  /** `in` / `out` on the map, `conform` / `request` on the sheet. */
  outcome: 'in' | 'out' | 'conform' | 'request';
  reason?: string;
  who: string;
  at: string;
}

export interface ShareRecord {
  id: string;
  deck: string;
  to: string;
  url: string;
  expires: string;
  at: string;
  code: boolean;
}

export interface ViewsState {
  custom: CustomView[];
  /** Ids from the sector and the standard sets the reader added to the organization. */
  adopted: string[];
  /** Ids of the starting five the reader removed. */
  removed: string[];
  where: Record<string, WhereState>;
  decisions: Record<string, DecisionRecord>;
  shares: ShareRecord[];
  /** Presentations whose PDF was prepared: deck id to the demo's day. */
  exported: Record<string, string>;
  /** CAD drafts that went into the record, by case id. */
  cadDraft: Record<string, boolean>;
}

export const VIEWS_INITIAL: ViewsState = { custom: [], adopted: [], removed: [], where: {}, decisions: {}, shares: [], exported: {}, cadDraft: {} };

export const viewsSlice = (ctx: ScreenCtx) => ctx.slice<ViewsState>('views', VIEWS_INITIAL);

/* ---------- the channels slice ---------- */

export interface ChannelReceipt {
  id: string;
  title: string;
  at: string;
  lines: string[];
}

export interface ChannelsState {
  state: Record<string, ChannelState>;
  rules: Record<string, RoutingRule[]>;
  receipts: Record<string, ChannelReceipt[]>;
  /** Why the last attempt to connect failed, by channel. */
  errors: Record<string, string>;
  /** Attempts to connect, by channel: the first one on SEND is refused, as the platform would. */
  attempts: Record<string, number>;
}

export const CHANNELS_INITIAL: ChannelsState = { state: {}, rules: {}, receipts: {}, errors: {}, attempts: {} };

export const channelsSlice = (ctx: ScreenCtx) => ctx.slice<ChannelsState>('channels', CHANNELS_INITIAL);

export const stateOf = (seed: ChannelSeed, st: ChannelsState): ChannelState => st.state[seed.id] ?? seed.state;
export const rulesOf = (seed: ChannelSeed, st: ChannelsState): RoutingRule[] => st.rules[seed.id] ?? seed.rules;

/* ---------- the views, as the reader has them ---------- */

/** A view of the library or one the reader made, with where it stands now. */
export interface ViewEntry {
  id: string;
  name: string;
  description: string;
  scope: ViewScope;
  blocks: BlockId[];
  kinds: string[];
  seed?: ViewSeed;
  custom?: CustomView;
  adopted: boolean;
}

export function viewEntries(st: ViewsState): ViewEntry[] {
  const inOrg = new Set([...ORG_VIEW_IDS.filter((id) => !st.removed.includes(id)), ...st.adopted]);
  const library: ViewEntry[] = VIEW_LIBRARY.map((s) => ({
    id: s.id, name: s.name, description: s.description, scope: s.scope, blocks: s.blocks, kinds: s.kinds, seed: s, adopted: inOrg.has(s.id),
  }));
  const custom: ViewEntry[] = st.custom.map((c) => ({
    id: c.id, name: c.name, description: c.description, scope: 'org', blocks: c.blocks, kinds: c.kind ? [c.kind] : [], custom: c, adopted: true,
  }));
  return [...library, ...custom];
}

export const entryOf = (st: ViewsState, id: string): ViewEntry | undefined => viewEntries(st).find((v) => v.id === id);

export const stepKey = (u: StepUse) => `${u.flow}:${u.step}`;

const DEFAULT_WHERE: WhereState = { off: [], added: [], roles: {}, desktop: true, phone: true, opensAs: 'tab' };
export const whereOf = (st: ViewsState, id: string): WhereState => ({ ...DEFAULT_WHERE, ...(st.where[id] ?? {}) });

/** Every step that may open a view: the seed's, then the ones added, each with whether it is on. */
export function stepsOf(entry: ViewEntry, st: ViewsState): Array<StepUse & { on: boolean }> {
  const w = whereOf(st, entry.id);
  const seedSteps = (entry.seed?.uses ?? []).map((u) => ({ ...u, on: !w.off.includes(stepKey(u)) }));
  const added = w.added.map((u) => ({ ...u, on: !w.off.includes(stepKey(u)) }));
  return [...seedSteps, ...added];
}

/** The steps that really open the view now. */
export const activeSteps = (entry: ViewEntry, st: ViewsState) => stepsOf(entry, st).filter((s) => s.on);

export function rolesOf(entry: ViewEntry, st: ViewsState, roleId: string): boolean {
  const w = whereOf(st, entry.id);
  if (roleId in w.roles) return w.roles[roleId];
  return (VIEW_ROLES[entry.id] ?? ['operatore']).includes(roleId);
}

/* ---------- cases ---------- */

export const parcelCases = (): CaseSeed[] => CASES.filter((c) => c.org === 'nocera' && c.parcel);
export const cadCases = (): CaseSeed[] => CASES.filter((c) => c.org === 'nocera' && (c.kind === 'concessione' || c.kind === 'verbale'));

/** The case a view opens on when nothing names one: the first that fits it. */
export const sampleParcelId = () => (parcelCases()[0]?.id ?? '2418');
export const sampleCadId = () => (cadCases()[0]?.id ?? '88');

/** Where a view opens when picked from the list. */
export function openPath(entry: ViewEntry): string {
  if (entry.id === 'particella') return P.parcel(sampleParcelId());
  if (entry.id === 'tavola') return P.cad(sampleCadId());
  if (entry.id === 'presentazione') return P.presentation(deckIdFor(sampleParcelId()));
  if (entry.id === 'fattura-ordine') return P.flowStep('fatture', 's4');
  if (entry.id === 'turni-irrigui') return P.data();
  if (entry.id === 'conferma-originali') return P.inbox();
  if (entry.blocks.includes('map')) return P.parcel(sampleParcelId());
  if (entry.blocks.includes('drawing')) return P.cad(sampleCadId());
  if (entry.blocks.includes('slides')) return P.presentation(deckIdFor(sampleParcelId()));
  return P.viewWhere(entry.id);
}

/** The document of a case an original of a view stands for; the first document when none fits. */
export function docPath(caseId: string, originalId: string): string {
  const seed = caseSeed(caseId);
  const docs = seed?.documents ?? [];
  if (docs.some((d) => d.id === originalId)) return P.recordDoc(caseId, originalId);
  const byName = (re: RegExp) => docs.find((d) => re.test(d.name) || re.test(d.id));
  const pick = originalId === 'o-visura' ? byName(/visura|avviso/i) ?? byName(/tavola/i)
    : originalId === 'o-piano' ? byName(/classifica|tavola/i)
      : originalId === 'o-perizia' ? byName(/perizia|ricorso/i)
        : originalId === 'dwg' ? byName(/dwg|tavola|progetto/i)
          : originalId === 'relazione' ? byName(/relazione/i)
            : originalId === 'regolamento' ? byName(/regolamento/i)
              : undefined;
  const doc = pick ?? docs[0];
  return doc ? P.recordDoc(caseId, doc.id) : P.record(caseId);
}

/** The flow's name and a step's label, for printing a step of a view. */
export function stepLabels(u: StepUse): { flow: string; step: string } {
  const flow = FLOWS.find((f) => f.id === u.flow);
  const step = flow?.steps.find((s) => s.id === u.step);
  return { flow: flow?.name ?? u.flow, step: step?.label ?? u.label };
}

/** `YYYY-MM-DD HH:mm` of the demo's now. */
export const stamp = (now: string) => now.slice(0, 16).replace('T', ' ');

export const hashText = (text: string): number => {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h;
};

/** The id of the presentation made from a case (the address says `verifica-<case>`). (allow-italian: quotes the Italian interface) */
export const deckIdFor = (caseId: string): string => `verifica-${caseId}`; // allow-italian: an address, shown as written

/** The name of a view of the library, as the crumbs print it. */
export const viewName = (id: string): string => VIEW_LIBRARY.find((v) => v.id === id)?.name ?? id;
