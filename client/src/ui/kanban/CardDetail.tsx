import { useState, type ReactNode } from 'react';
import { Bot, CalendarClock, ChevronRight, CircleAlert, CirclePause, Maximize2, MoveRight, Sparkles, UserCheck, Workflow, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action, CrumbModel, Tone } from '../types';
import { TONE_CHIP } from '../tone';
import { Button } from '../primitives/Button';
import { MenuButton } from '../primitives/Menu';
import { Timeline } from '../primitives/Timeline';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import { Avatar } from '../shell/SidebarRows';
import { FOCUS_RING } from '../shell/pressable';
import { SegmentedControl } from '../../components/Shared/Segmented';
import { ClassificationField } from '../inbox/ClassificationField';
import type { ClassificationFieldModel } from '../inbox/model';
import type { FlowRefModel, MoveOptionModel, OriginalModel, QuoteMarkModel, StageGlyph, TagModel, WorkerModel } from './model';
import { OriginalSheet } from './OriginalSheet';
import { ORIGINAL_ICON, STAGE_GLYPH } from './glyphs';
import { FlowLabel, StageIcon } from './parts';

/** Under this confidence a value, or the proposal, reads amber. */
const SURE = 85;

export interface CardActionModel {
  id: string;
  label: string;
  variant: 'primary' | 'confirm' | 'secondary' | 'ghost';
  icon?: LucideIcon;
  /** `false`: drawn disabled, `title` says why (in the tip of the button). */
  onClick: Action;
  title?: string;
}

/** A value the agent read, with the original it was read on. */
export interface CardValueModel extends ClassificationFieldModel {
  doc: string;
}

/** One row of the history: a column the card entered, a hand that changed, or a place it leads (a contract, a clause, another card). */
export interface CardEventModel {
  id: string;
  title: string;
  /** Already formatted; empty for a place the card leads to. */
  at: string;
  detail?: string;
  who?: string;
  /** The glyph of the column, for a stage row. */
  glyph?: StageGlyph;
  /** The glyph of anything else. */
  icon?: LucideIcon;
  /** The row of where the card is now. */
  current?: boolean;
  onOpen?: () => void;
}

/** The folds of the page; the header is always open. */
export type CardSection = 'original' | 'history' | 'chat';

const GLYPH_TONE: Record<StageGlyph, Tone> = { incoming: 'neutral', working: 'blue', check: 'amber', approve: 'violet', done: 'green' };

/** A small face: a person's monogram or the agent's bot. */
function Face({ worker }: { worker: WorkerModel }) {
  if (worker.kind === 'person') return <Avatar text={worker.monogram ?? ''} color={worker.color ?? '#64748b'} size={20} />;
  return (
    <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300">
      <Bot size={13} aria-hidden="true" />
      {worker.active && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-emerald-500 ring-2 ring-surface motion-reduce:animate-none" />}
    </span>
  );
}

/** One token of the line under the title: quiet outline, or a tone when it asks for attention. */
function Token({ children, tone, tip, kind, className }: { children: ReactNode; tone?: Tone; tip?: string; kind: string; className?: string }) {
  return (
    <span
      data-token={kind}
      data-tip={tip}
      className={clsx(
        'inline-flex min-h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-compact leading-4',
        tone ? TONE_CHIP[tone] : 'border border-app-border bg-surface text-app-text-secondary',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A section of the page that folds; its state is the caller's, so it is remembered. */
function Fold({ id, title, hint, summary, open, onToggle, children }: {
  id: CardSection;
  title: string;
  /** Beside the title while open. */
  hint?: string;
  /** Beside the title while folded: what is inside, so a folded section is not read as an empty one. */
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section data-card-section={id} data-open={open} className="min-w-0 border-t border-app-border">
      <h2 className="text-body-lg">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={clsx('flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md py-2 text-left', FOCUS_RING)}
        >
          <ChevronRight size={14} className={clsx('shrink-0 text-app-text-tertiary transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden="true" />
          <span className="font-semibold text-app-text">{title}</span>
          {(open ? hint : summary) && <span className="min-w-0 truncate text-prose font-normal text-app-text-tertiary">{open ? hint : summary}</span>}
        </button>
      </h2>
      {open && <div className="pb-5 pt-1">{children}</div>}
    </section>
  );
}

/**
 * The page of one card of the kanban, read from the top: what it is (the flow
 * and its step, the state, the title), who has it and who checks it, when it
 * is due and why it is stopped, all in one line of tokens; what happens next
 * with the buttons that do it; then, folding, the original beside the values
 * read from it, the history, and the chat about the card. Every fact is said
 * once. The actions the person may not take are drawn off and say why in the
 * tip of the button. The flow itself opens beside the page (`FlowPanel`), so
 * the card is never left.
 */
export function CardDetail({
  back, crumbs, move, head, flow, worker, workerTip, reviewer, due, priority, stopped, next, actions,
  values, activeValue, onValue, onEditValue, originals, onOpenOriginal,
  history, chat, sections, copy, phone, narrow,
}: {
  back: { label: string; onClick: () => void };
  crumbs: CrumbModel[];
  move: { items: MoveOptionModel[]; disabledTitle?: string; onMove: (to: string) => void };
  head: {
    title: string;
    detail: string;
    flow: FlowRefModel;
    /** «Passo 3 di 7: …», already formatted; empty when the flow has no step for the column. (allow-italian: quotes the Italian interface) */
    step: string;
    stage: { label: string; glyph: StageGlyph };
  };
  /** The «Flusso» button: opens or closes the flow beside the card. */
  flow: { open: boolean; onToggle: () => void };
  worker: WorkerModel;
  /** «da 12 min, dalle 10:14», for the tip of the token. (allow-italian: quotes the Italian interface) */
  workerTip: string;
  /** `same`: the person who holds the card is the one who checks it, so one row says both. */
  reviewer: { name: string; monogram: string; color: string; same?: boolean };
  due?: { text: string; tone: Tone; title?: string };
  priority?: TagModel;
  /** The card is stopped: «Ferma da 2 g» and why. (allow-italian: quotes the Italian interface) */
  stopped?: { text: string; reason: string; tone: Tone };
  /** What the agent proposes (or what a person waits to do), with its confidence; closed: the card is done. */
  next: { text: string; confidence: number; closed: boolean };
  /** The main action first; empty on a closed card. */
  actions: CardActionModel[];
  values: CardValueModel[];
  activeValue?: string;
  onValue: (id: string) => void;
  /** Absent: the person cannot correct values. */
  onEditValue?: (id: string, value: string) => void;
  /** Every original of the card, each with the passages its values were read from. */
  originals: Array<{ original: OriginalModel; marks: QuoteMarkModel[] }>;
  onOpenOriginal: (id: string) => void;
  history: CardEventModel[];
  /** The chat about the card, drawn by the caller. */
  chat: ReactNode;
  sections: { open: Record<CardSection, boolean>; onToggle: (id: CardSection) => void };
  copy: UiCopy;
  phone?: boolean;
  /** The flow is open beside the page: the originals and their values stack in one column. */
  narrow?: boolean;
}) {
  const k = copy.kanban;
  const d = k.detail;
  const sure = next.confidence >= SURE;
  // A blocked card says why in its red strip; the token of who holds it does not tell it a second time.
  const hideDoing = stopped?.tone === 'red';
  const offActions = actions.filter((a) => a.onClick === false && a.title);
  const oneColumn = phone || narrow;
  const [picked, setPicked] = useState<string | undefined>();
  const activeDoc = values.find((v) => v.id === activeValue)?.doc;
  const shown = originals.find((o) => o.original.id === (picked ?? activeDoc)) ?? originals[0];
  const pickValue = (id: string) => {
    const doc = values.find((v) => v.id === id)?.doc;
    if (doc) setPicked(doc);
    onValue(id);
  };
  const OriginalIcon = shown ? ORIGINAL_ICON[shown.original.kind] : undefined;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader leading={<BackButton label={back.label} onClick={back.onClick} copy={copy} />} crumbs={phone ? crumbs.slice(-1) : crumbs}>
        <MenuButton
          label={k.board.moveTo}
          icon={MoveRight}
          iconOnly={phone || narrow}
          size="md"
          align="right"
          disabled={Boolean(move.disabledTitle)}
          title={move.disabledTitle ?? k.board.moveTo}
          items={move.items.map((o) => ({ id: o.id, label: o.label, disabled: o.disabled, title: o.title }))}
          onSelect={move.onMove}
        />
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={clsx('mr-auto flex max-w-[880px] flex-col', phone ? 'px-4 pb-6 pt-4' : 'px-4 pb-8 pt-5')}>
          <header data-card-section="header" className="min-w-0 pb-5">
            <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-compact text-app-text-secondary">
                <FlowLabel flow={head.flow} className="text-compact font-medium text-app-text" />
                {/* The dot travels with the step: when the step wraps under the flow, no dot is left alone at the end of the line. */}
                {head.step && (
                  <span className="min-w-0 [overflow-wrap:break-word]"><span aria-hidden="true" className="mr-2 text-app-text-faint">·</span>{head.step}</span>
                )}
                <button
                  type="button"
                  onClick={flow.onToggle}
                  data-open-flow=""
                  aria-expanded={flow.open}
                  data-tip={d.openFlowTip(head.flow.label)}
                  className={clsx(
                    'inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-mini font-medium transition-colors',
                    flow.open ? 'border-primary/60 bg-primary/10 text-primary dark:text-primary-dark' : 'border-app-border text-app-text hover:bg-app-hover',
                    FOCUS_RING,
                  )}
                >
                  <Workflow size={12} aria-hidden="true" />
                  {d.openFlow}
                </button>
              </div>
            </div>
            <h1 className="text-headline font-semibold leading-7 tracking-[-0.01em] text-app-text [overflow-wrap:break-word]">{head.title}</h1>
            <p className="mt-1 text-prose text-app-text-secondary">{head.detail}</p>

            <div data-card-tokens="" className="mt-3 flex flex-wrap items-center gap-1.5">
              <span data-card-stage={head.stage.glyph} className={clsx('inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-2 text-compact font-medium', TONE_CHIP[GLYPH_TONE[head.stage.glyph]])}>
                <StageIcon glyph={head.stage.glyph} size={13} />{head.stage.label}
              </span>
              <Token kind="worker" tip={`${worker.fullName}: ${worker.doing} (${workerTip})`}>
                <Face worker={worker} />
                <span className="font-medium text-app-text">
                  {worker.name}
                  {reviewer.same && <span className="font-normal text-app-text-secondary">{d.workAndCheck}</span>}
                </span>
                {!hideDoing && <span className="min-w-0 [overflow-wrap:break-word]">{worker.doing}</span>}
                <span className="shrink-0 tabular-nums text-app-text-tertiary">{worker.since}</span>
              </Token>
              {!reviewer.same && (
                <Token kind="reviewer">
                  <UserCheck size={13} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                  <span className="shrink-0 text-app-text-tertiary">{d.reviewer}</span>
                  <Avatar text={reviewer.monogram} color={reviewer.color} size={18} />
                  <span className="min-w-0 [overflow-wrap:break-word] font-medium text-app-text">{reviewer.name}</span>
                </Token>
              )}
              {due && (
                <Token kind="due" tone={due.tone === 'neutral' ? undefined : due.tone} tip={due.title}>
                  <CalendarClock size={13} className="shrink-0" aria-hidden="true" />
                  <span className="tabular-nums">{due.text}</span>
                </Token>
              )}
              {priority && (
                <Token kind="priority" tone={priority.tone} tip={priority.title}>
                  <span className="font-medium">{priority.text}</span>
                </Token>
              )}
              {stopped && (
                <Token kind="stopped" tone={stopped.tone} className="items-start py-1">
                  <CirclePause size={13} className="mt-px shrink-0" aria-hidden="true" />
                  <span className="min-w-0 [overflow-wrap:break-word]"><span className="font-semibold">{stopped.text}</span> · {stopped.reason}</span>
                </Token>
              )}
            </div>

            <div data-card-next="" className="mt-4 rounded-lg border border-app-border bg-surface px-4 py-3">
              <div className="mb-1 flex min-w-0 items-center gap-2">
                <Sparkles size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                <h2 className="text-compact font-semibold uppercase tracking-[0.06em] text-app-text-secondary">{next.closed ? d.closed : d.next}</h2>
                {!next.closed && (
                  <span className={clsx('ml-auto shrink-0 text-compact font-semibold tabular-nums', sure ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400')}>{d.confidence(next.confidence)}</span>
                )}
              </div>
              <p className="text-body-lg leading-6 text-app-text-body">{next.text}</p>
              {!next.closed && !sure && (
                <p className="mt-2 flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-compact leading-5 text-amber-800 dark:text-amber-300">
                  <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{d.lowConfidence}
                </p>
              )}
              {actions.length > 0 && (
                <div role="group" aria-label={k.actions.label} className="mt-3 flex flex-wrap items-start gap-2">
                  {actions.map((a) => (
                    <Button key={a.id} variant={a.variant} size={phone ? 'md' : 'lg'} icon={a.icon} onClick={a.onClick} title={a.title}>{a.label}</Button>
                  ))}
                </div>
              )}
              {offActions.length > 0 && (
                <ul data-action-why="" className="mt-2 grid gap-0.5 text-compact leading-5 text-app-text-tertiary">
                  {offActions.map((a) => (
                    <li key={a.id} className="min-w-0 [overflow-wrap:break-word]"><span className="font-medium text-app-text-secondary">{a.label}</span> · {a.title}</li>
                  ))}
                </ul>
              )}
            </div>
          </header>

          <Fold
            id="original"
            title={d.originalSection}
            hint={d.valuesHint}
            summary={d.valuesCount(values.length)}
            open={sections.open.original}
            onToggle={() => sections.onToggle('original')}
          >
            <div className={clsx('grid gap-4', !oneColumn && 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')}>
              {shown && OriginalIcon && (
                <div className="min-w-0">
                  {originals.length > 1 && (
                    <SegmentedControl
                      className="mb-2 max-w-full"
                      ariaLabel={d.originalPick}
                      value={shown.original.id}
                      onChange={setPicked}
                      options={originals.map((o) => ({ value: o.original.id, label: o.original.name }))}
                    />
                  )}
                  <section data-original-block={shown.original.id} aria-label={shown.original.name} className="min-w-0">
                    <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <OriginalIcon size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-compact [overflow-wrap:break-word] text-app-text-secondary">
                        <span className="font-medium text-app-text">{originals.length > 1 ? shown.original.name : shown.original.kindLabel}</span> · {originals.length > 1 ? `${shown.original.kindLabel} · ${shown.original.from}` : shown.original.from}
                      </span>
                      <Button size="sm" variant="ghost" icon={Maximize2} onClick={() => onOpenOriginal(shown.original.id)} className="ml-auto shrink-0">{d.openOriginal}</Button>
                    </div>
                    <div className="max-h-[560px] overflow-y-auto rounded-lg bg-app-inset p-3 sm:p-4">
                      <OriginalSheet original={shown.original} marks={shown.marks} active={activeValue} onMark={pickValue} photoLabel={k.original.photo} />
                    </div>
                    {shown.marks.length === 0 && <p className="mt-2 text-compact text-app-text-tertiary">{d.noValues}</p>}
                  </section>
                </div>
              )}
              <div className="grid min-w-0 content-start gap-3">
                {values.map((v) => (
                  <ClassificationField
                    key={v.id}
                    field={v}
                    focused={v.id === activeValue}
                    copy={copy}
                    onExplain={() => pickValue(v.id)}
                    onEdit={onEditValue ? (nextValue) => onEditValue(v.id, nextValue) : undefined}
                  />
                ))}
              </div>
            </div>
          </Fold>

          <Fold
            id="history"
            title={d.history}
            summary={d.eventsCount(history.length)}
            open={sections.open.history}
            onToggle={() => sections.onToggle('history')}
          >
            <Timeline
              ariaLabel={d.history}
              items={history.map((h) => ({
                id: h.id,
                at: h.at,
                title: h.title,
                detail: h.detail,
                who: h.who,
                icon: h.glyph ? STAGE_GLYPH[h.glyph].icon : h.icon,
                tone: h.current && h.glyph ? GLYPH_TONE[h.glyph] : 'neutral',
                onOpen: h.onOpen,
              }))}
            />
          </Fold>

          <Fold
            id="chat"
            title={d.chat}
            open={sections.open.chat}
            onToggle={() => sections.onToggle('chat')}
          >
            {chat}
          </Fold>
        </div>
      </div>
    </div>
  );
}
