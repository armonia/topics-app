import { ChevronLeft, ChevronRight, Kanban, OctagonPause } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip, FieldChip } from '../primitives/Chip';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import type { CrumbModel } from '../types';
import { StepMarker } from '../flows/FlowStep';
import { ActorBadge } from './WorkParts';
import type { StepCardModel, StepPageModel } from './work-model';

function Fields({ fields, empty }: { fields: StepPageModel['reads']; empty: string }) {
  if (!fields.length) return <span className="text-prose text-app-text-tertiary">{empty}</span>;
  return <div className="flex flex-wrap gap-1.5">{fields.map((f) => <FieldChip key={`${f.kind}-${f.name}`} field={f} />)}</div>;
}

function StepCardRow({ card, copy }: { card: StepCardModel; copy: UiCopy }) {
  const s = copy.orbitWork.flows.step;
  return (
    <li className="border-b border-app-border py-2.5 last:border-b-0">
      <button type="button" onClick={card.onOpen} className={clsx('block w-full rounded-md text-left', FOCUS_RING)}>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-prose font-semibold tabular-nums text-primary dark:text-primary-dark">{card.id}</span>
          <span className="min-w-0 text-prose font-medium text-app-text">{card.title}</span>
          {card.stopped && <Chip tone="red" icon={OctagonPause}>{card.stopped}</Chip>}
        </span>
        <span className="mt-0.5 block text-compact text-app-text-tertiary">{card.detail}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-compact text-app-text-secondary">
          <span className="text-app-text-tertiary">{s.worker}</span>
          <ActorBadge actor={card.worker} />
          <span>{card.doing}</span>
          <span className="tabular-nums text-app-text-tertiary">{card.since}</span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-compact">
          <span className="text-app-text-tertiary">{s.reviewer}</span>
          <ActorBadge actor={card.reviewer} />
        </span>
      </button>
    </li>
  );
}

/**
 * One step of a ORBIT flow as its own page: the steps of the flow on the left
 * (the current one selected), then who does it and what, what it reads and
 * produces, the state of «Da fare» a card here stands in, the cards here now (allow-italian: quotes the Italian interface)
 * and, for a step an agent does, who checks it next.
 * Under 768px the steps become a strip that scrolls sideways.
 */
export function OpsStepScreen({ page, copy, phone, crumbs }: { page: StepPageModel; copy: UiCopy; phone?: boolean; /** Replaces the built-in crumbs when given. */ crumbs?: CrumbModel[] }) {
  const s = copy.orbitWork.flows.step;
  const nav = (
    <div role="tablist" aria-label={s.navLabel} aria-orientation={phone ? 'horizontal' : 'vertical'} className={clsx(phone ? 'flex gap-1.5 overflow-x-auto px-4 py-2' : 'space-y-1.5')}>
      {page.nav.map((n) => {
        const on = n.id === page.id;
        return (
          <button
            key={n.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={n.onOpen}
            className={clsx(
              'flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
              phone ? 'w-[220px] shrink-0' : 'w-full',
              on ? 'border-primary bg-surface shadow-[0_0_0_3px_rgba(0,102,255,0.15)]' : 'border-app-border bg-surface hover:bg-app-hover',
              FOCUS_RING,
            )}
          >
            <StepMarker size={22}>{n.marker}</StepMarker>
            <span className="min-w-0 flex-1">
              <span className="block"><ActorBadge actor={n.actor} /></span>
              <span className="mt-1 block text-compact leading-4 text-app-text [overflow-wrap:break-word]">{n.title}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        leading={<BackButton label={page.flow} onClick={page.onBack} copy={copy} />}
        crumbs={crumbs ?? [{ label: s.org }, { label: s.flows }, { label: page.flow }, { label: page.title, detail: s.crumb(page.marker) }]}
      >
        {!phone && (
          <>
            <Button icon={ChevronLeft} onClick={page.onPrev ?? false}>{s.prev}</Button>
            <Button onClick={page.onNext ?? false} trailing={<ChevronRight size={14} aria-hidden="true" className="shrink-0" />}>{s.next}</Button>
            <Button icon={Kanban} variant="primary" onClick={page.onColumn}>{s.openColumn(page.stage.label)}</Button>
          </>
        )}
      </PaneHeader>
      {phone && (
        <div className="shrink-0 border-b border-app-border">
          {nav}
          <div className="flex items-center gap-2 overflow-x-auto px-4 pb-2">
            <Button icon={ChevronLeft} onClick={page.onPrev ?? false}>{s.prev}</Button>
            <Button onClick={page.onNext ?? false} trailing={<ChevronRight size={14} aria-hidden="true" className="shrink-0" />}>{s.next}</Button>
            <Button icon={Kanban} variant="primary" onClick={page.onColumn}>{s.openColumn(page.stage.label)}</Button>
          </div>
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!phone && <div className="w-[280px] shrink-0 overflow-y-auto border-r border-app-border p-3">{nav}</div>}
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
          <div className="flex items-start gap-3">
            <StepMarker size={28}>{page.marker}</StepMarker>
            <div className="min-w-0 flex-1">
              <ActorBadge actor={page.actor} />
              <h2 className="mt-1.5 text-headline font-semibold leading-tight tracking-[-0.01em] text-app-text">{page.title}</h2>
            </div>
          </div>
          <div className="mt-5 grid gap-4 xl:grid-cols-2">
            <Card title={s.does}>
              <p>{page.does}</p>
            </Card>
            <Card title={s.column}>
              <div className="flex flex-wrap items-center gap-2">
                <Chip strong>{page.stage.label}</Chip>
                <span>{page.stage.hint}</span>
              </div>
              {page.stops && <p className="mt-1.5 text-compact text-app-text-tertiary">{page.stops}</p>}
            </Card>
            <Card title={s.reads}><Fields fields={page.reads} empty={s.nothing} /></Card>
            <Card title={s.produces}><Fields fields={page.produces} empty={s.nothing} /></Card>
            {page.after && (
              <Card title={s.checkedAfter}>
                {page.after.next ? (
                  <button type="button" onClick={page.after.next.onOpen} className={clsx('flex flex-wrap items-center gap-2 rounded text-left', FOCUS_RING)}>
                    <ActorBadge actor={page.after.next.actor} />
                    <span className="text-app-text hover:underline">{page.after.next.step}</span>
                  </button>
                ) : (
                  <span className="text-app-text-tertiary">{s.noPersonAfter}</span>
                )}
              </Card>
            )}
          </div>
          <section aria-label={s.cardsNow} className="mt-4 rounded-lg border border-app-border bg-surface px-4 pb-1 pt-3">
            <h3 className="flex items-center gap-2 text-prose font-semibold text-app-text">
              {s.cardsNow}
              <span className="font-normal tabular-nums text-app-text-tertiary">{page.cards.length}</span>
            </h3>
            {page.cards.length === 0 ? (
              <p className="py-3 text-prose text-app-text-tertiary">{copy.orbitWork.flows.noCardsHere}</p>
            ) : (
              <ul>{page.cards.map((c) => <StepCardRow key={c.id} card={c} copy={copy} />)}</ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
