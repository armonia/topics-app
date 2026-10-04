/**
 * PROVIDERS AND KEYS, THE LIST (model selector revision 2026-10-04, §5.2).
 *
 * One list of accounts, no group titles, no columns by company or by kind of
 * connection: every provider of the snapshot once, `topics` as «Topics», in
 * the fixed order of `providersModel`. Two columns of cards where there is room
 * (reading order by rows), one on the phone. Each card: the status dot, the
 * name and, when it is not ready, the state word; a fact; the companies it
 * serves; and at most one action on the right, or › when none is needed.
 * Pressing the card opens the account's detail.
 *
 * The card's button and its action are SIBLINGS: nothing interactive inside
 * anything interactive (A11Y-01).
 */
import { useId } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Plus, RefreshCw, X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { SEGNALE_ATTESA } from '../Sidebar/chromeSignals';
import { ACTIVE_INK, STATUS_COLORS } from './providerFormat';
import { cardFact, type CardAction, type ProviderCard } from './providersModel';

const ACTION_KEYS: Record<CardAction, string> = {
  signIn: 'ai.selector.action.signIn',
  addKey: 'ai.selector.action.addKey',
  setUp: 'ai.selector.action.setUp',
  retry: 'common.retry',
};

export function StatusDot({ status }: { status: ProviderCard['status'] }) {
  const tr = useT();
  const word = tr(`ai.selector.status.${status}`);
  return <span role="img" aria-label={word} title={word} data-status={status} className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_COLORS[status]}`} />;
}

/** ‹ of a level: back to where the level was opened from. */
export function LevelBack({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      data-testid="level-back"
      aria-label={label}
      title={label}
      onClick={onBack}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-app-text-secondary hover:bg-app-hover hover:text-app-text coarse:h-11 coarse:w-11"
    >
      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

export interface ProvidersViewProps {
  cards: ProviderCard[];
  /** "9 ready · 1 error", the selector's foot, the same function (§5.3). */
  count: { text: string; warn: boolean } | null;
  plan: string | null;
  planWarning: string | null;
  /** ‹ back to the models; absent on the sheet, which opens on this level. */
  onBack?: () => void;
  /** The sheet's own close; absent inside the selector (Escape and outside close it). */
  onClose?: () => void;
  closeTestId?: string;
  busy: ReadonlySet<string>;
  loadError: string | null;
  onRetryLoad: () => void;
  /** A saved default no provider answers to: say so, and offer to drop it. */
  missingDefault: string | null;
  onDropMissingDefault: () => void;
  onOpen: (card: ProviderCard) => void;
  onAction: (card: ProviderCard) => void;
  onAdd: (what: 'key' | 'endpoint' | 'program') => void;
}

export function ProvidersView(props: ProvidersViewProps) {
  const tr = useT();
  const headingId = useId();
  const { cards } = props;
  return (
    <div data-testid="providers-view" className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-app-border px-1 py-0.5">
        {props.onBack && <LevelBack label={tr('ai.providers.backToModels')} onBack={props.onBack} />}
        <h2 id={headingId} className="min-w-0 flex-1 truncate px-2 text-compact font-semibold text-app-text">{tr('home.providers')}</h2>
        {props.count && (
          <span
            data-testid="providers-level-count"
            className={`shrink-0 px-1 text-mini tabular-nums ${props.count.warn ? SEGNALE_ATTESA : 'text-app-text-secondary'}`}
          >
            {props.count.text}
          </span>
        )}
        {props.onClose && (
          <button
            type="button"
            data-testid={props.closeTestId}
            aria-label={tr('userMenu.level.close', { nome: tr('home.providers') })}
            title={tr('userMenu.level.close', { nome: tr('home.providers') })}
            onClick={props.onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-app-text-secondary hover:bg-app-hover hover:text-app-text coarse:h-11 coarse:w-11"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      <div data-testid="providers-level-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {props.loadError && cards.length === 0 && (
          <div className="mb-1.5 flex items-center gap-2 px-1 text-compact text-red-600 dark:text-red-400">
            <AlertCircle size={12} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 break-words">{props.loadError}</span>
            <button type="button" onClick={props.onRetryLoad} className="flex shrink-0 items-center gap-1 rounded-md border border-app-border px-2 py-1 text-mini hover:bg-app-hover coarse:min-h-11">
              <RefreshCw size={11} aria-hidden="true" />{tr('common.retry')}
            </button>
          </div>
        )}
        {props.missingDefault && (
          <div data-testid="provider-default-missing" className="mb-1.5 flex items-center gap-2 rounded-md border border-dashed border-app-border px-2 py-1.5 text-mini text-app-text-secondary">
            <AlertCircle size={12} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 break-words">
              {tr('ai.saved.prefix')} <span className="font-mono">{props.missingDefault}</span>{tr('ai.saved.suffix')}
            </span>
            <button type="button" onClick={props.onDropMissingDefault} className="shrink-0 rounded-md border border-app-border px-2 py-1 hover:bg-app-hover coarse:min-h-11">
              {tr('ai.saved.remove')}
            </button>
          </div>
        )}
        <ul data-testid="providers-level" aria-labelledby={headingId} className="grid grid-cols-1 gap-1 @min-[34rem]:grid-cols-2">
          {cards.map((card) => (
            <CardItem
              key={card.name}
              card={card}
              fact={cardFact(card, tr, card.name === 'claude-code' ? { plan: props.plan, planWarning: props.planWarning } : {})}
              busy={props.busy.has(card.name)}
              onOpen={() => props.onOpen(card)}
              onAction={() => props.onAction(card)}
            />
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-app-border px-1 py-0.5">
        {(['key', 'endpoint', 'program'] as const).map((what) => (
          <button
            key={what}
            type="button"
            data-testid={`providers-add-${what}`}
            onClick={() => props.onAdd(what)}
            className="flex h-7 items-center gap-1 rounded px-2 text-mini text-app-text-secondary hover:bg-app-hover hover:text-app-text coarse:h-11"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {tr(`ai.providers.add.${what}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function CardItem({ card, fact, busy, onOpen, onAction }: {
  card: ProviderCard;
  fact: string;
  busy: boolean;
  onOpen: () => void;
  onAction: () => void;
}) {
  const tr = useT();
  const word = tr(`ai.selector.status.${card.status}`);
  const defaultWord = tr('ai.providers.fact.default');
  const rest = card.isDefault && fact.startsWith(defaultWord) ? fact.slice(defaultWord.length).replace(/^ · /, '') : null;
  const makers = card.makers.join(' · ');
  // Ready cards do not repeat «Pronto» on screen, but say it to a screen reader.
  const name = [card.label, word, fact, card.makers.length ? tr('ai.providers.makers', { list: card.makers.join(', ') }) : null]
    .filter(Boolean).join(', ');
  return (
    <li
      data-testid={`provider-card-${card.name}`}
      data-status={card.status}
      className="flex items-stretch rounded-md border border-app-border coarse:min-h-[60px]"
    >
      <button
        type="button"
        data-testid="provider-card-open"
        aria-label={name}
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col items-start justify-center rounded-l-md px-2.5 py-1 text-left hover:bg-app-hover"
      >
        <span className="flex max-w-full items-center gap-1.5">
          <StatusDot status={card.status} />
          <span className="min-w-0 truncate text-compact font-medium leading-4 text-app-text">{card.label}</span>
          {card.status !== 'ready' && <span data-testid="provider-card-status" className="shrink-0 text-mini leading-4 text-app-text-secondary">{word}</span>}
        </span>
        {fact && (
          <span data-testid="provider-card-fact" className="max-w-full break-words text-mini leading-4 text-app-text-secondary">
            {rest !== null ? <><span className={ACTIVE_INK}>{defaultWord}</span>{rest ? ` · ${rest}` : ''}</> : fact}
          </span>
        )}
        {makers && <span data-testid="provider-card-makers" className="max-w-full break-words text-mini leading-4 text-app-text-secondary">{makers}</span>}
      </button>
      {card.action ? (
        <button
          type="button"
          data-testid="provider-card-action"
          data-action={card.action}
          disabled={busy}
          onClick={onAction}
          className={`mr-1 shrink-0 self-center rounded px-1.5 py-0.5 text-mini font-semibold hover:bg-app-hover disabled:opacity-50 coarse:min-h-11 coarse:min-w-11 ${ACTIVE_INK}`}
        >
          {tr(ACTION_KEYS[card.action])}
        </button>
      ) : (
        <ChevronRight className="mr-2 h-3.5 w-3.5 shrink-0 self-center text-app-text-secondary" aria-hidden="true" />
      )}
    </li>
  );
}
