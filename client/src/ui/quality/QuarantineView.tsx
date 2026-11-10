import type { ReactNode } from 'react';
import { CircleCheck, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { KeyValue, PanelHeading, PanelSection } from '../primitives/Panel';
import { Timeline } from '../primitives/Timeline';
import { TONE_TEXT } from '../tone';
import type { OriginalModel, QuarantineModel } from './model';

function Original({ o }: { o: OriginalModel }) {
  return (
    <Card title={o.title} actions={<Chip>{o.tag}</Chip>}>
      <p className="mb-2 text-compact text-app-text-tertiary">{o.detail}</p>
      {o.rows.map((r) => (
        <KeyValue
          key={r.label}
          label={r.label}
          value={<span className={clsx(r.flag && `font-semibold ${TONE_TEXT.amber}`)}>{r.value}</span>}
        />
      ))}
    </Card>
  );
}

/**
 * A stopped item (q02): why it was stopped, the two originals side by side
 * with the difference marked, why it can be a problem, what is held, what
 * happened so far, and who may unblock it. The decisions are the caller's
 * buttons, passed as `actions`; a decision or a question already sent shows
 * as an outcome with its receipt, and the buttons give way to it.
 */
export function QuarantineView({ model, copy, phone, actions, side }: {
  model: QuarantineModel;
  copy: UiCopy;
  phone: boolean;
  actions?: ReactNode;
  /** Extra blocks for the side panel (a link to the case). */
  side?: ReactNode;
}) {
  const t = copy.dataMore.quarantine;
  const OutcomeIcon = model.outcome?.tone === 'green' ? CircleCheck : ShieldAlert;
  return (
    <div className={clsx('flex min-h-0 min-w-0 flex-1', phone && 'flex-col')}>
      <div className="min-w-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 max-sm:px-3">
        <Card tone={model.outcome ? model.outcome.tone : 'amber'} title={model.headline} actions={<Chip tone="amber">{model.checkLabel}</Chip>}>
          <p className="leading-6">{model.why}</p>
        </Card>
        {model.outcome && (
          <div role="status" className={clsx('flex items-start gap-2.5 rounded-lg border px-3.5 py-3', model.outcome.tone === 'green' ? 'border-emerald-500/35 bg-emerald-500/[0.06]' : 'border-amber-500/40 bg-amber-500/[0.06]')}>
            <OutcomeIcon size={16} className={clsx('mt-0.5 shrink-0', TONE_TEXT[model.outcome.tone])} aria-hidden="true" />
            <div className="min-w-0 text-prose leading-6 text-app-text">
              <p className="font-medium">{model.outcome.text}</p>
              <p className="text-compact text-app-text-tertiary">{model.outcome.at}</p>
              {model.receipt && (
                <div className="mt-2 rounded-md bg-black/[0.04] px-3 py-2 dark:bg-white/[0.06]">
                  <p className="text-compact font-semibold text-app-text">{model.receipt.title}</p>
                  {model.receipt.lines.map((l) => <p key={l} className="text-compact text-app-text-secondary">{l}</p>)}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Original o={model.left} />
          <Original o={model.right} />
        </div>
        <Card title={t.whyProblem}><p className="leading-6">{model.risk}</p></Card>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <aside className={clsx('flex shrink-0 flex-col border-app-border bg-surface', phone ? 'w-full border-t' : 'h-full w-[320px] border-l')}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PanelHeading tag={t.heldTag} title={model.held.title}>{model.held.body}</PanelHeading>
          <PanelSection label={t.history}>
            <Timeline items={model.history.map((h) => ({ id: h.id, at: h.at, title: h.text }))} ariaLabel={t.history} />
          </PanelSection>
          <PanelSection label={t.whoMayUnblock}>
            {model.unblockers.map((u) => <KeyValue key={u.who} label={u.who} value={u.may} />)}
          </PanelSection>
          {side}
        </div>
      </aside>
    </div>
  );
}
