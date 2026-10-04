/**
 * THE BODY OF THE MODEL SELECTOR (MSEL-02..08, revision 2026-10-04 §4): the
 * Run-in-Topics band, the search with Automatic beside it, the companies in
 * columns (Anthropic, OpenAI, Google fixed, the others stacked in the fourth),
 * and the providers at the foot. Every surface that picks a model draws this,
 * through `ModelSelector`, which owns the popover around it.
 *
 * The body is not a listbox: it is a dialog of company groups (`role=group`)
 * of buttons, with nothing interactive inside anything interactive. The engine
 * of a group is written once, in its heading, and chosen there (⌄) when two
 * engines run it; a row names its engine only when it runs elsewhere.
 *
 * Its own chunk (`modelListLazy.ts`): it is the content of a popover, nothing
 * of it is on screen at first paint.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, KeyRound, Route, Search, Sparkles } from 'lucide-react';
import type { ProvidersSnapshot } from '../../../types';
import type { ProvidersTarget } from '../../Settings/AIProvidersSection';
import { topicsRoute, type TopicsRoute, type TopicsRouteScope } from '../../../../../shared/task-coding-models';
import { contextWindowFor, formatContextWindow } from '../../../../../shared/context-window';
import { POPOVER_ITEM } from '../../../lib/popoverStyles';
import { usePlanUsage } from '../../../state/planUsage';
import { useT } from '../../../hooks/useT';
import { isTypingSurface } from '../../../hooks/useMenuKeyboard';
import { SEGNALE_ATTESA } from '../../Sidebar/chromeSignals';
import { claudePlanWarning, providersCountTail } from '../../Sidebar/formLevelTails';
import {
  catalogColumns,
  filterModelCatalog,
  rowSelected,
  signInCommand,
  useModelCatalog,
  type AiExecutionSelection,
  type CatalogGroup,
  type CatalogRow,
  type ConnectEntry,
  type GroupStatus,
} from './useModelCatalog';

export interface ModelListProps {
  scope: TopicsRouteScope;
  variant: 'compact' | 'full';
  layout: 'columns' | 'list';
  value: AiExecutionSelection;
  /** What the band judges when it differs from `value` (Automatic on a card
   *  runs the board default; a chat with no override runs its pin). */
  routingTarget?: AiExecutionSelection;
  /** `keepOpen`: a choice made from a heading's engine, the panel stays. */
  onSelect: (selection: AiExecutionSelection, options?: { keepOpen?: boolean }) => void;
  /** Automatic (revision §3.7): `who` is the short part, always visible
   *  («Claude Code», «segue la board»); `hint` the long sentence. */
  automatic: { who: string; hint: string };
  /** The Run-in-Topics band. Absent = no band (the default model of one provider). */
  topicsRouting?: { enabled: boolean; onToggle: (next: boolean) => void };
  /** Only this provider's models (the default model of one provider). */
  onlyProvider?: string;
  disabled?: boolean;
  onClose: () => void;
  /** Providers and keys, a level of the same panel (revision §5.1): the foot
   *  opens the list, «Sistema ›» and the connect boxes an account's detail. */
  onOpenProviders: (target: ProvidersTarget) => void;
  /** Focus the search on open: desktop only, the phone keyboard would cover the sheet. */
  focusSearch: boolean;
  /** Deterministic catalog for render tests; live callers omit it. */
  snapshot?: ProvidersSnapshot | null;
}

/** Where the dismiss button remembers the hidden connect boxes, on this device. */
export const HIDDEN_CONNECT_KEY = 'topics.modelSelector.hiddenConnect';
/** The active ink: 4.5:1 on the popover in both themes (revision §4.4). */
const ACTIVE_INK = 'text-blue-800 dark:text-blue-300';
const STATUS_DOT: Record<GroupStatus, string> = {
  ready: 'bg-emerald-600 dark:bg-emerald-400',
  unavailable: 'bg-zinc-400 dark:bg-zinc-500',
  error: 'bg-red-600 dark:bg-red-400',
  loading: 'bg-blue-600 dark:bg-blue-400 animate-pulse motion-reduce:animate-none',
};
const NAVIGABLE = 'button:not([disabled]):not([data-roving-skip]):not([role="radio"][aria-checked="false"])';

function readHidden(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(HIDDEN_CONNECT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

function routeOf(enabled: boolean, selection: AiExecutionSelection, snapshot: ProvidersSnapshot | null, scope: TopicsRouteScope): TopicsRoute {
  return topicsRoute(enabled, { provider: selection.provider ?? snapshot?.defaultProvider ?? null, model: selection.model }, snapshot, scope);
}

const domId = (text: string) => text.replace(/[^a-z0-9]/gi, '-');

/** The Run-in-Topics band: a real switch, the whole band clicks, never disabled
 *  (neither position blocks anything), and the line says what happens to the
 *  CURRENT choice, readable without hovering (MSEL-07). One line on desktop. */
function RoutingBand({ enabled, route, engineLabel, onToggle }: {
  enabled: boolean;
  route: TopicsRoute;
  engineLabel: string;
  onToggle: () => void;
}) {
  const tr = useT();
  const through = enabled && route.via !== 'direct';
  const direct = enabled && route.via === 'direct' ? route : null;
  const line = direct
    ? direct.reason === 'family' ? tr('ai.selector.route.direct.family', { engine: engineLabel })
      : direct.reason === 'model' ? tr('ai.selector.route.direct.model')
        : tr('ai.selector.route.direct.engineDown')
    : tr('ai.selector.routingLine');
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      data-testid="model-selector-routing"
      data-route={!enabled ? 'off' : through ? 'topics' : 'direct'}
      onClick={onToggle}
      className={`mx-1 mb-1 flex w-[calc(100%-0.5rem)] shrink-0 items-start gap-2 rounded-md px-2.5 py-1 coarse:py-3 text-left transition-colors ${
        through ? 'border-l-2 border-primary bg-primary/10' : 'border-l-2 border-transparent bg-app-inset'
      }`}
    >
      <Route className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${through ? ACTIVE_INK : 'text-app-text-secondary'}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 text-mini leading-4">
        <span className="font-semibold text-app-text">{tr('ai.selector.routing')}</span>{' '}
        <span
          data-testid="model-selector-routing-line"
          className={direct ? SEGNALE_ATTESA : 'text-app-text-secondary'}
        >
          {line}
        </span>
      </span>
      <span className={`relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors ${enabled ? 'bg-primary' : 'bg-app-border'}`} aria-hidden="true">
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </span>
    </button>
  );
}

/** The providers row, the count and the chevron: the foot of every selector (SETHOME-01). */
function ProvidersFooterRow({ snapshot, disabled, onOpen }: {
  snapshot: ProvidersSnapshot | null;
  disabled?: boolean;
  onOpen: () => void;
}) {
  const tr = useT();
  const tail = providersCountTail(snapshot, tr);
  return (
    <div className="shrink-0 border-t border-app-border pt-0.5">
      <button
        type="button"
        disabled={disabled}
        data-testid="ai-selector-providers"
        className={`${POPOVER_ITEM} !py-1 coarse:!py-3 disabled:opacity-40`}
        onClick={onOpen}
      >
        <KeyRound className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{tr('home.providers')}</span>
        {tail && (
          <span
            data-testid="ai-selector-providers-tail"
            data-warn={tail.warn ? 'true' : undefined}
            className={`shrink-0 text-mini tabular-nums ${tail.warn ? SEGNALE_ATTESA : 'text-app-text-secondary'}`}
          >
            {tail.text}
          </span>
        )}
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" aria-hidden="true" />
      </button>
    </div>
  );
}

function retireDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function StatusDot({ status }: { status: GroupStatus }) {
  const tr = useT();
  const word = tr(`ai.selector.status.${status}`);
  return <span role="img" aria-label={word} title={word} data-status={status} className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} />;
}

interface RowProps {
  row: CatalogRow;
  value: AiExecutionSelection;
  scope: TopicsRouteScope;
  variant: 'compact' | 'full';
  disabled?: boolean;
  onPick: (selection: AiExecutionSelection) => void;
  onFix: (engine: string | undefined) => void;
}

/**
 * One model: a button (`aria-pressed`) laid out as `label (2 lines at most) ·
 * [1M] · window · check`. The 1M switch is a SIBLING of the button, not inside
 * it. The second line is there only for «via X», a retirement, the description
 * (`full`) or why the row cannot run.
 */
function ModelRow({ row, value, scope, variant, disabled, onPick, onFix }: RowProps) {
  const tr = useT();
  const selected = rowSelected(row, value);
  const usable = !row.stale && !!row.engine?.ready;
  const [long, setLong] = useState(() => !!row.longModel && value.model === row.longModel);
  const id = row.automatic ? null : long && row.longModel ? row.longModel : row.model;
  const label = row.automatic ? tr('ai.selector.auto') : row.label;
  const win = id ? contextWindowFor(id, row.windows[id]) : null;
  // A window is shown only when it is known: never «≈1M» (revision §3.6, AC-12).
  const windowText = scope === 'chat' && win?.known ? formatContextWindow(win.tokens) : null;
  const describedBy = `model-row-desc-${domId(row.key)}`;
  const name = [label, windowText, row.engine?.label, row.viaTopics ? tr('ai.selector.route.topics') : null].filter(Boolean).join(', ');
  const second = !!row.via || !!row.retiresAt || (variant === 'full' && !!row.description) || !usable;
  // The 1M switch sits over the spacer of the first line: right padding (12),
  // check (12) and its gap (8), plus the window column and its gap.
  const switchRight = 32 + (windowText ? 44 : 0);
  return (
    <div className="relative" data-testid="model-row-wrap">
      <button
        type="button"
        aria-pressed={selected}
        aria-label={name}
        aria-describedby={second ? describedBy : undefined}
        title={row.automatic ? undefined : row.label}
        disabled={disabled || !usable}
        data-testid={row.automatic ? 'model-row-automatic-within' : 'model-row'}
        data-model={id ?? undefined}
        data-provider={row.engine?.name}
        data-route={row.viaTopics ? 'topics' : 'direct'}
        onClick={() => { if (usable && row.engine) onPick({ provider: row.engine.name, model: id }); }}
        className={`${POPOVER_ITEM} !items-start flex-col !gap-0 leading-4 coarse:leading-5 outline-none focus-visible:bg-app-hover disabled:cursor-default ${
          selected ? 'bg-primary/5' : ''
        } ${!usable ? 'opacity-70' : ''}`}
      >
        <span className="flex w-full min-w-0 items-start gap-2">
          {row.automatic && <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-app-text-secondary" aria-hidden="true" />}
          <span className="line-clamp-2 min-w-0 flex-1 break-words" data-testid="model-row-label">{label}</span>
          {row.longModel && <span className="w-7 shrink-0 coarse:w-11" aria-hidden="true" />}
          {windowText && (
            <span
              data-testid={`model-window-${id}`}
              data-context-tokens={win!.tokens}
              className="w-9 shrink-0 text-right text-mini tabular-nums text-app-text-secondary"
            >
              {windowText}
            </span>
          )}
          <span className="flex w-3 shrink-0 justify-center self-center" aria-hidden="true">
            {selected && <Check className={`h-3 w-3 ${usable ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300'}`} />}
          </span>
        </span>
        {second && (
          <span id={describedBy} className="block w-full text-mini leading-4 text-app-text-secondary">
            {row.via && <span className="block" data-testid="model-row-via">{tr('ai.selector.route.via', { engine: row.via })}</span>}
            {row.retiresAt && <span className={`block ${SEGNALE_ATTESA}`} data-testid="model-row-retires">{tr('ai.selector.retires', { date: retireDate(row.retiresAt) })}</span>}
            {variant === 'full' && row.description && <span className="block" data-testid="model-row-description">{row.description}</span>}
            {!usable && <span className={`block ${SEGNALE_ATTESA}`}>{tr('ai.selector.noLongerAvailable')}</span>}
          </span>
        )}
      </button>
      {row.longModel && (
        <button
          type="button"
          data-roving-skip=""
          role="switch"
          aria-checked={long}
          aria-label={tr('ai.selector.longWindow')}
          title={tr('ai.selector.longWindow')}
          data-testid="model-row-1m"
          disabled={disabled || !usable}
          style={{ right: switchRight }}
          onClick={() => {
            const next = !long;
            setLong(next);
            if (selected && row.engine) onPick({ provider: row.engine.name, model: next ? row.longModel! : row.model });
          }}
          className="absolute top-0.5 flex h-6 min-w-7 items-center justify-center coarse:top-0 coarse:h-11 coarse:min-w-11"
        >
          <span className={`rounded px-1 text-micro font-semibold tabular-nums ${long ? 'bg-primary/15 text-app-text' : 'bg-app-hover text-app-text-secondary'}`}>1M</span>
        </button>
      )}
      {!usable && !row.automatic && (
        <button
          type="button"
          data-testid="model-row-settings"
          disabled={disabled}
          onClick={() => onFix(row.engine?.name)}
          className={`mx-3 mb-1 rounded px-1 text-mini coarse:min-h-11 hover:bg-app-hover ${ACTIVE_INK}`}
        >
          {tr('ai.selector.action.fix')}
        </button>
      )}
    </div>
  );
}

/** A company with no ready engine but a provider of the snapshot that is not
 *  ready (revision §4.6): what is missing, one action per provider, and the
 *  button that hides the box. Never a shell command in the text. */
function ConnectBox({ group, disabled, onHide, onClose, onOpenProviders }: {
  group: CatalogGroup;
  disabled?: boolean;
  onHide: () => void;
  onClose: () => void;
  onOpenProviders: (target: ProvidersTarget) => void;
}) {
  const tr = useT();
  const first = group.connect[0]!;
  const sentence = first.status === 'error'
    ? tr('ai.selector.connect.error', { name: first.label })
    : tr(`ai.selector.connect.${first.action}`, { name: first.label });
  const act = (entry: ConnectEntry) => {
    const command = entry.action === 'signIn' ? signInCommand(entry.name) : null;
    // «Accedi» acts on the first press: a Topics terminal with the command
    // typed, not run. The other two are navigations to the account's detail,
    // with its field focused, and the › says so.
    if (command) {
      onClose();
      window.dispatchEvent(new CustomEvent('topics:open-terminal-with-command', { detail: { command } }));
    } else {
      onOpenProviders({ account: entry.name, focus: entry.action === 'addKey' ? 'key' : 'path' });
    }
  };
  return (
    <div data-testid="model-section-connect" className="mx-2 my-1 rounded-md bg-app-inset px-2.5 py-2 text-mini text-app-text">
      <p className="leading-snug">{sentence}</p>
      {group.connect.map((entry) => (
        <div key={entry.name} data-testid={`model-connect-${entry.name}`} className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusDot status={entry.status} />
          <span className="min-w-0 flex-1 text-app-text-secondary">
            {entry.label} · {tr(`ai.selector.status.${entry.status}`)} · {tr(`ai.selector.connect.fact.${entry.action}`)}
          </span>
          <button
            type="button"
            disabled={disabled}
            data-testid="model-connect-action"
            data-provider={entry.name}
            data-action={entry.action}
            onClick={() => act(entry)}
            className={`rounded px-1.5 py-0.5 font-semibold coarse:min-h-11 hover:bg-app-hover ${ACTIVE_INK}`}
          >
            {tr(`ai.selector.action.${entry.action}`)}
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        data-testid="model-connect-hide"
        onClick={onHide}
        className="mt-1.5 rounded px-1.5 py-0.5 text-app-text-secondary coarse:min-h-11 hover:bg-app-hover"
      >
        {tr('ai.selector.connect.hide')}
      </button>
    </div>
  );
}

/**
 * The heading of a group, the same two lines on every group, stacked ones
 * included: the status dot and the COMPANY (plus the plan warning on
 * Anthropic), then «via <who runs it>» with ⌄ when two engines run the
 * group. On a list (phone) both sit on one 44px row.
 */
function GroupHeading({ group, headingId, list, open, onToggle, planWarning }: {
  group: CatalogGroup;
  headingId: string;
  list: boolean;
  open: boolean;
  onToggle: () => void;
  planWarning: string | null;
}) {
  const tr = useT();
  const who = group.who ? tr('ai.selector.route.via', { engine: group.who }) : null;
  const hasChoice = group.engines.length > 1;
  const engineLine = hasChoice ? (
    <button
      type="button"
      data-testid="model-group-engine"
      aria-expanded={open}
      aria-label={`${tr('ai.selector.engine', { maker: group.label })}: ${group.engine?.label ?? ''}`}
      onClick={onToggle}
      className={`inline-flex min-w-0 items-center gap-0.5 rounded px-1 -mx-1 text-mini font-normal normal-case tracking-normal hover:bg-app-hover coarse:min-h-11 coarse:min-w-11 ${group.viaTopics ? ACTIVE_INK : 'text-app-text-secondary'}`}
    >
      <span className="truncate">{who}</span>
      <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
    </button>
  ) : who ? (
    <span data-testid="model-group-who" className={`truncate text-mini font-normal normal-case tracking-normal ${group.viaTopics ? ACTIVE_INK : 'text-app-text-secondary'}`}>{who}</span>
  ) : null;
  return (
    <div
      data-testid="model-section-heading"
      className={`sticky top-0 z-10 flex h-11 bg-[var(--popover-bg)] px-3 ${list ? 'items-center justify-between gap-2' : 'flex-col justify-center gap-0.5'}`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusDot status={group.status} />
        <span id={headingId} className="truncate text-micro font-semibold uppercase leading-4 tracking-wide text-app-text-secondary">{group.label}</span>
        {planWarning && (
          <span data-testid="model-plan-warning" className={`ml-auto shrink-0 text-mini leading-4 tabular-nums ${SEGNALE_ATTESA}`}>{planWarning}</span>
        )}
      </span>
      {engineLine && <span className="flex min-w-0 items-center leading-4">{engineLine}</span>}
    </div>
  );
}

function GroupView({ group, column, props, list, expanded, onExpand, engineOpen, onEngineOpen, onEngine, onHide, planWarning }: {
  group: CatalogGroup;
  column: number;
  props: ModelListProps;
  list: boolean;
  expanded: boolean;
  onExpand: () => void;
  engineOpen: boolean;
  onEngineOpen: (open: boolean) => void;
  onEngine: (name: string) => void;
  onHide: () => void;
  planWarning: string | null;
}) {
  const tr = useT();
  const headingId = `model-group-${domId(group.maker)}`;
  const rows = expanded ? [...group.rows, ...group.older] : group.rows;
  const radiosRef = useRef<HTMLDivElement>(null);
  const routing = props.topicsRouting?.enabled ?? false;

  // Esc closes only the engine choice. The panel's own Escape listens on the
  // document in the capture phase, so this one listens on the window, earlier.
  useEffect(() => {
    if (!engineOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      onEngineOpen(false);
      radiosRef.current?.parentElement?.querySelector<HTMLElement>('[data-testid="model-group-engine"]')?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => radiosRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus());
    return () => window.removeEventListener('keydown', onKey, true);
  }, [engineOpen, onEngineOpen]);

  return (
    <div role="group" aria-labelledby={headingId} data-testid={`model-section-${group.maker}`} data-maker={group.maker} data-column={column}>
      <GroupHeading group={group} headingId={headingId} list={list} open={engineOpen} onToggle={() => onEngineOpen(!engineOpen)} planWarning={planWarning} />
      {engineOpen && (
        <div
          ref={radiosRef}
          role="radiogroup"
          aria-label={tr('ai.selector.engine', { maker: group.label })}
          data-testid="model-group-engines"
          className="mx-2 mb-1 flex flex-col rounded-md bg-app-inset py-0.5"
        >
          {group.engines.map((engine) => {
            const checked = engine.name === group.engine?.name;
            const inTopics = routing && engine.name === 'claude-code' && group.maker === 'anthropic';
            return (
              <button
                key={engine.name}
                type="button"
                role="radio"
                aria-checked={checked}
                data-engine-choice={engine.name}
                disabled={props.disabled}
                onClick={() => { onEngine(engine.name); onEngineOpen(false); }}
                className={`${POPOVER_ITEM} !py-1 coarse:!py-3 text-mini ${checked ? ACTIVE_INK : ''}`}
              >
                <span className="min-w-0 flex-1 truncate">{inTopics ? tr('ai.selector.engineInTopics', { engine: engine.label }) : engine.label}</span>
                {checked && <Check className="h-3 w-3 shrink-0" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
      {rows.map((row) => (
        <ModelRow
          key={row.key} row={row} value={props.value} scope={props.scope} variant={props.variant}
          disabled={props.disabled} onPick={props.onSelect}
          onFix={(engine) => props.onOpenProviders(engine ? { account: engine } : {})}
        />
      ))}
      {group.connect.length > 0 && <ConnectBox group={group} disabled={props.disabled} onHide={onHide} onClose={props.onClose} onOpenProviders={props.onOpenProviders} />}
      {group.older.length > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          data-testid="model-section-older"
          onClick={onExpand}
          className={`${POPOVER_ITEM} text-app-text-secondary`}
        >
          <span className="min-w-0 flex-1 truncate">{expanded ? tr('ai.selector.olderHide') : tr('ai.selector.older', { n: group.older.length })}</span>
        </button>
      )}
    </div>
  );
}

export function ModelList(props: ModelListProps) {
  const tr = useT();
  const { scope, value, layout, onSelect, onClose } = props;
  const routingEnabled = props.topicsRouting?.enabled ?? false;
  const [hidden, setHidden] = useState<string[]>(readHidden);
  const [groupEngines, setGroupEngines] = useState<Record<string, string>>({});
  const options = useMemo(
    () => ({ routing: routingEnabled, hidden, groupEngines, onlyProvider: props.onlyProvider }),
    [routingEnabled, hidden, groupEngines, props.onlyProvider],
  );
  const { snapshot, groups: all } = useModelCatalog(scope, value, options, props.snapshot);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [engineOpen, setEngineOpen] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => filterModelCatalog(all, query, tr('ai.selector.auto')), [all, query, tr]);
  const columns = useMemo(() => catalogColumns(groups), [groups]);
  const target = props.routingTarget ?? value;
  const route = routeOf(routingEnabled, target, snapshot, scope);
  const targetProvider = target.provider ?? snapshot?.defaultProvider ?? null;
  const engineLabel = snapshot?.providers.find((entry) => entry.name === targetProvider)?.label ?? targetProvider ?? '';
  const usage = usePlanUsage();
  const planWarning = claudePlanWarning(usage?.fiveHour ?? null, usage?.sevenDay ?? null, tr);
  const pick = useCallback((selection: AiExecutionSelection) => { onSelect(selection); onClose(); }, [onSelect, onClose]);

  const hideConnect = (group: CatalogGroup) => {
    const next = [...new Set([...hidden, ...group.connect.map((entry) => entry.name)])];
    setHidden(next);
    try { window.localStorage.setItem(HIDDEN_CONNECT_KEY, JSON.stringify(next)); } catch { /* private mode: this opening only */ }
  };

  // ⌄ in a heading: the group's engine for this opening. When the saved row
  // is in the group and the new engine serves it, it is saved again on it.
  const chooseEngine = (group: CatalogGroup, name: string) => {
    setGroupEngines((current) => ({ ...current, [group.maker]: name }));
    const saved = [...group.rows, ...group.older].find((row) => !row.automatic && rowSelected(row, value));
    const ids = saved?.ids[name];
    if (saved && ids && value.provider !== name) {
      const long = value.model === saved.longModel && ids.longModel;
      onSelect({ provider: name, model: long ? ids.longModel : ids.model }, { keepOpen: true });
    }
  };

  // The search takes the focus once the popover is placed and visible (a
  // hidden element refuses `focus()`), after `Menu` has focused its panel. It
  // only ever takes it from the panel itself or the page: once the person has
  // moved into the list, the focus is theirs.
  useEffect(() => {
    if (!props.focusSearch) return;
    let frames = 0;
    let handle = 0;
    const tick = () => {
      const input = searchRef.current;
      const host = panelRef.current?.closest<HTMLElement>('[data-popover]') ?? null;
      const visible = !!input && (!host || getComputedStyle(host).visibility === 'visible');
      const active = document.activeElement;
      const free = active === host || active === document.body || active === null;
      if (visible && free) input!.focus({ preventScroll: true });
      if (visible && document.activeElement === input) return;
      if (visible && !free && active !== input) return;
      if (frames++ < 12) handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [props.focusSearch]);

  // Tab stops once per column (roving tabindex): the chosen row of the column
  // or its first stop. Every scrolling column so holds one focusable element.
  const layoutKey = `${layout}|${query}|${JSON.stringify(expanded)}|${engineOpen}|${columns.map((column) => column.map((g) => g.maker).join(',')).join('/')}`;
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const containers = [...panel.querySelectorAll<HTMLElement>('[data-model-column]')];
    for (const container of containers) {
      const items = [...container.querySelectorAll<HTMLElement>(NAVIGABLE)];
      const keep = items.find((item) => item.getAttribute('aria-pressed') === 'true') ?? items[0];
      for (const item of items) item.tabIndex = item === keep ? 0 : -1;
    }
    const onFocus = (event: FocusEvent) => {
      const item = event.target as HTMLElement;
      const container = item.closest<HTMLElement>('[data-model-column]');
      if (!container || !item.matches(NAVIGABLE)) return;
      for (const other of container.querySelectorAll<HTMLElement>(NAVIGABLE)) other.tabIndex = other === item ? 0 : -1;
    };
    panel.addEventListener('focusin', onFocus);
    return () => panel.removeEventListener('focusin', onFocus);
  }, [layoutKey]);

  // On open the chosen row is brought into view inside its own column.
  useEffect(() => {
    const row = panelRef.current?.querySelector<HTMLElement>('[data-model-column] [aria-pressed="true"]');
    const container = row?.closest<HTMLElement>('[data-model-column]');
    if (!row || !container) return;
    const rowBox = row.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    if (rowBox.bottom > box.bottom) container.scrollTop += rowBox.bottom - box.bottom + 8;
    else if (rowBox.top < box.top + 44) container.scrollTop -= box.top + 44 - rowBox.top;
  }, []);

  // ← → go to the next column, onto the stop nearest in height (§4.7).
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (layout !== 'columns' || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    if (isTypingSurface(event.target)) return;
    const item = event.target as HTMLElement;
    const container = item.closest<HTMLElement>('[data-model-column]');
    if (!container || item.closest('[role="radiogroup"]')) return;
    const index = Number(container.dataset.modelColumn) + (event.key === 'ArrowRight' ? 1 : -1);
    const next = panelRef.current?.querySelector<HTMLElement>(`[data-model-column="${index}"]`);
    if (!next) return;
    event.preventDefault();
    const y = item.getBoundingClientRect().top;
    const stops = [...next.querySelectorAll<HTMLElement>(NAVIGABLE)];
    const nearest = stops.reduce<HTMLElement | null>((best, stop) => {
      if (!best) return stop;
      return Math.abs(stop.getBoundingClientRect().top - y) < Math.abs(best.getBoundingClientRect().top - y) ? stop : best;
    }, null);
    nearest?.focus();
  };

  const isColumns = layout === 'columns';
  const automaticSelected = value.provider === null && value.model === null;
  const automaticHintId = `model-auto-hint-${domId(scope)}-${props.variant}`;
  const hintVisible = !isColumns || props.variant === 'full';
  const automaticButton = (
    <button
      type="button"
      aria-pressed={automaticSelected}
      aria-describedby={automaticHintId}
      disabled={props.disabled}
      data-testid="model-row-automatic"
      onClick={() => pick({ provider: null, model: null })}
      className={isColumns
        ? `flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-compact text-app-text hover:bg-app-hover disabled:opacity-40 ${automaticSelected ? 'bg-primary/5' : ''}`
        : `${POPOVER_ITEM} shrink-0 !items-start disabled:opacity-40 ${automaticSelected ? 'bg-primary/5' : ''}`}
    >
      <Sparkles className={`h-3.5 w-3.5 shrink-0 text-app-text-secondary ${isColumns ? '' : 'mt-0.5'}`} aria-hidden="true" />
      <span className={isColumns ? 'whitespace-nowrap' : 'min-w-0 flex-1'}>
        <span className="block">{props.automatic.who ? `${tr('ai.selector.auto')} · ${props.automatic.who}` : tr('ai.selector.auto')}</span>
        {!isColumns && <span id={automaticHintId} className="block text-mini leading-snug text-app-text-secondary">{props.automatic.hint}</span>}
      </span>
      {automaticSelected && <Check className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
    </button>
  );
  const groupView = (group: CatalogGroup, column: number) => (
    <GroupView
      key={group.maker}
      group={group}
      column={column}
      props={{ ...props, onSelect: pick }}
      list={!isColumns}
      expanded={!!expanded[group.maker]}
      onExpand={() => setExpanded((current) => ({ ...current, [group.maker]: !current[group.maker] }))}
      engineOpen={engineOpen === group.maker}
      onEngineOpen={(open) => setEngineOpen(open ? group.maker : null)}
      onEngine={(name) => chooseEngine(group, name)}
      onHide={() => hideConnect(group)}
      planWarning={group.maker === 'anthropic' ? planWarning : null}
    />
  );
  return (
    <div
      ref={panelRef}
      data-model-selector-panel=""
      data-testid="model-selector-panel"
      data-variant={props.variant}
      data-layout={layout}
      data-scope={scope}
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col"
    >
      {props.topicsRouting && (
        <RoutingBand
          enabled={routingEnabled}
          route={route}
          engineLabel={engineLabel}
          onToggle={() => props.topicsRouting!.onToggle(!routingEnabled)}
        />
      )}
      <div className="mx-1 mb-1 flex shrink-0 items-center gap-1">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-app-inset px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                panelRef.current?.querySelector<HTMLElement>('[data-testid="model-row-automatic"]:not([disabled])')?.focus();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                panelRef.current?.querySelector<HTMLElement>('[data-model-list-sections] [data-testid="model-row"]:not([disabled])')?.click();
              }
            }}
            placeholder={tr('ai.selector.search')}
            aria-label={tr('ai.selector.search')}
            data-testid="model-selector-search"
            className="h-8 coarse:h-11 min-w-0 flex-1 bg-transparent text-compact text-app-text outline-none placeholder:text-app-text-faint"
          />
        </label>
        {isColumns && automaticButton}
      </div>
      {isColumns && (
        <p id={automaticHintId} className={hintVisible ? 'mx-3 mb-1 shrink-0 text-mini leading-snug text-app-text-secondary' : 'sr-only'}>
          {props.automatic.hint}
        </p>
      )}
      <div data-model-list-body="" className="flex min-h-0 flex-1 flex-col">
        <div
          data-model-list-sections=""
          data-testid="model-selector-sections"
          className={isColumns
            ? 'grid min-h-0 flex-1 border-t border-app-border'
            : 'min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-app-border'}
          style={isColumns ? { gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))` } : undefined}
        >
          {!isColumns && automaticButton}
          {isColumns
            ? columns.map((column, index) => (
              <div
                key={column.map((group) => group.maker).join(',')}
                data-model-column={index}
                data-testid="model-column"
                className="flex min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain border-l border-app-border first:border-l-0"
              >
                {column.map((group) => groupView(group, index))}
              </div>
            ))
            : columns.flat().map((group) => groupView(group, 0))}
          {groups.length === 0 && (
            <p className="px-3 py-4 text-center text-mini text-app-text-secondary" data-testid="model-selector-empty">
              {query ? tr('chat.picker.noMatches') : tr('ai.selector.none')}
            </p>
          )}
        </div>
      </div>
      <ProvidersFooterRow snapshot={snapshot} disabled={props.disabled} onOpen={() => props.onOpenProviders({})} />
    </div>
  );
}
