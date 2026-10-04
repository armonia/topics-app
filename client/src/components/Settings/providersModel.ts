/**
 * THE PROVIDERS LEVEL AS DATA (model selector revision 2026-10-04, §5.2-§5.4).
 *
 * One list of accounts, one card per provider of the snapshot, in a FIXED order
 * that does not depend on the models a provider lists: a static table of names,
 * then the endpoints, then everything else, both alphabetical by label. An
 * error does not move a card. Each card has one state, one fact, the companies
 * it serves and at most one action.
 *
 * The count at the foot of every selector and in the heading of this level is
 * computed here, on the cards, so the two can never disagree (§5.3, AC-22).
 *
 * Pure on purpose: the order, the companies, the action and the count are the
 * rules the revision writes down, tested without a DOM.
 */
import type { ProviderSnapshotEntry, ProviderStatus, ProvidersSnapshot } from '../../types';
import { FIXED_MAKERS, engineMaker, makerLabel, modelMaker } from '../../../../shared/modelMaker';
import { DIRECT_PROVIDER_PREFIX } from '../../../../shared/direct-endpoints';
import type { Translate } from '../../../../shared/queue-reason-text';

/** The fixed order of the list (§5.2). Unknown names come after, never between. */
export const PROVIDER_ORDER = ['claude-code', 'topics', 'claude', 'codex', 'openai', 'gemini', 'jcode', 'openclaw', 'goose'] as const;

/** What kind of account a card is: it decides the first words of the fact. */
export type CardKind = 'subscription' | 'key' | 'program' | 'agent' | 'endpoint' | 'engine';

/** The one action a card may carry (§5.4). `null`: none, the card shows ›. */
export type CardAction = 'signIn' | 'addKey' | 'setUp' | 'retry';

export interface ProviderCard {
  name: string;
  label: string;
  status: ProviderStatus;
  kind: CardKind;
  /** The companies it serves, as labels: Anthropic, OpenAI, Google first. */
  makers: string[];
  modelCount: number;
  action: CardAction | null;
  isDefault: boolean;
  /** Why it is in error, when it is. */
  reason: string | null;
  /** False for a program installed here but not registered as a provider. */
  registered: boolean;
  /** The host of an endpoint, when known. */
  host: string | null;
}

/** A local program the server knows about but did not register (§5.6). */
export interface UnregisteredProgram {
  name: string;
  label: string;
}

const SUBSCRIPTIONS = new Set(['claude-code', 'codex']);
const KEYS = new Set(['claude', 'openai']);
const PROGRAMS = new Set(['gemini', 'opencode', 'kimi-code']);

export function providerKind(name: string): CardKind {
  if (name === 'topics') return 'engine';
  if (SUBSCRIPTIONS.has(name)) return 'subscription';
  if (KEYS.has(name)) return 'key';
  if (name.startsWith(DIRECT_PROVIDER_PREFIX)) return 'endpoint';
  if (PROGRAMS.has(name)) return 'program';
  return 'agent';
}

/**
 * The action of a state: nothing when ready or checking, "Retry" on an
 * error, and on a provider still to connect what connecting it takes: a
 * subscription signs in, a key is added, everything else is set up.
 */
export function cardAction(name: string, status: ProviderStatus): CardAction | null {
  if (status === 'ready' || status === 'loading') return null;
  if (status === 'error') return 'retry';
  if (SUBSCRIPTIONS.has(name)) return 'signIn';
  if (KEYS.has(name)) return 'addKey';
  return 'setUp';
}

/**
 * The companies a provider serves, from the models it lists: Anthropic, OpenAI
 * and Google first when present, then the others by number of models, then
 * alphabetically. A provider with no model but a known company (Codex not
 * signed in) takes the one of the static table.
 */
export function servedMakers(entry: Pick<ProviderSnapshotEntry, 'name' | 'label' | 'models'>): string[] {
  const counts = new Map<string, { label: string; n: number }>();
  for (const id of entry.models) {
    const maker = modelMaker(id, { name: entry.name, label: entry.label });
    const current = counts.get(maker.id);
    counts.set(maker.id, { label: maker.label, n: (current?.n ?? 0) + 1 });
  }
  if (counts.size === 0) {
    const known = engineMaker(entry.name);
    return known ? [makerLabel(known)] : [];
  }
  const fixed = FIXED_MAKERS.filter((maker) => counts.has(maker)).map((maker) => counts.get(maker)!.label);
  const others = [...counts.entries()]
    .filter(([maker]) => !(FIXED_MAKERS as readonly string[]).includes(maker))
    .sort(([, a], [, b]) => b.n - a.n || a.label.localeCompare(b.label))
    .map(([, value]) => value.label);
  return [...fixed, ...others];
}

function rank(card: Pick<ProviderCard, 'name'>): number {
  const fixed = (PROVIDER_ORDER as readonly string[]).indexOf(card.name);
  if (fixed >= 0) return fixed;
  return card.name.startsWith(DIRECT_PROVIDER_PREFIX) ? PROVIDER_ORDER.length : PROVIDER_ORDER.length + 1;
}

/** The fixed order: the table, then the endpoints, then the rest, by label. */
export function compareCards(a: Pick<ProviderCard, 'name' | 'label'>, b: Pick<ProviderCard, 'name' | 'label'>): number {
  return rank(a) - rank(b) || a.label.localeCompare(b.label);
}

/**
 * Every provider of the snapshot once, `topics` included, plus the local
 * programs installed but not registered, as cards still to connect.
 */
export function providerCards(
  snapshot: ProvidersSnapshot | null,
  unregistered: readonly UnregisteredProgram[] = [],
  hosts: Readonly<Record<string, string>> = {},
): ProviderCard[] {
  const entries = snapshot?.providers ?? [];
  const names = new Set(entries.map((entry) => entry.name));
  const cards: ProviderCard[] = entries.map((entry) => ({
    name: entry.name,
    label: entry.label ?? entry.name,
    status: entry.status,
    kind: providerKind(entry.name),
    makers: servedMakers(entry),
    modelCount: entry.models.length,
    action: cardAction(entry.name, entry.status),
    isDefault: entry.isDefault && entry.name !== 'topics',
    reason: entry.status === 'error' ? entry.lastError ?? null : null,
    registered: true,
    host: hosts[entry.name] ?? null,
  }));
  // Topics is the engine of the band: its card holds the settings for every
  // chat (the agents' engine, the checkpoint), so it stays even when the
  // engine is not registered on this server, as a card still to connect.
  if (snapshot && !names.has('topics')) {
    cards.push({
      name: 'topics', label: 'Topics', status: 'unavailable', kind: 'engine', makers: ['Anthropic'], modelCount: 0,
      action: null, isDefault: false, reason: null, registered: false, host: null,
    });
  }
  for (const program of unregistered) {
    if (names.has(program.name)) continue;
    cards.push({
      name: program.name, label: program.label, status: 'unavailable', kind: providerKind(program.name),
      makers: servedMakers({ name: program.name, label: program.label, models: [] }), modelCount: 0,
      action: 'setUp', isDefault: false, reason: null, registered: false, host: null,
    });
  }
  return cards.sort(compareCards);
}

/** Ready cards, and the errors (§5.3): the same numbers in the foot and the heading. */
export function cardsCount(cards: readonly Pick<ProviderCard, 'status'>[]): { ready: number; errors: number } {
  return {
    ready: cards.filter((card) => card.status === 'ready').length,
    errors: cards.filter((card) => card.status === 'error').length,
  };
}

/**
 * The second line of a card (§5.2): "Default · Max 20x · week 67%",
 * "ChatGPT plan · 8 models", "Pay-as-you-go key · 5 models", "Endpoint ·
 * openrouter.ai · 6 models". In error, the reason, and nothing else.
 */
export function cardFact(card: ProviderCard, tr: Translate, extra: { plan?: string | null; planWarning?: string | null } = {}): string {
  if (card.status === 'error' && card.reason) return card.reason;
  const parts: string[] = [];
  if (card.isDefault) parts.push(tr('ai.providers.fact.default'));
  if (card.kind === 'subscription') {
    parts.push(card.name === 'claude-code' ? extra.plan ?? tr('ai.providers.fact.claudePlan') : tr('ai.providers.fact.chatgptPlan'));
  } else {
    parts.push(tr(`ai.providers.fact.${card.kind}`));
  }
  if (card.kind === 'endpoint' && card.host) parts.push(card.host);
  if (card.name === 'claude-code' && extra.planWarning) parts.push(extra.planWarning);
  if (card.modelCount > 0) {
    parts.push(card.modelCount === 1 ? tr('ai.providers.fact.modelOne') : tr('ai.providers.fact.models', { n: card.modelCount }));
  }
  return parts.join(' · ');
}

/** The host of an endpoint URL, for the fact line. */
export function endpointHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}
