import { CheckCircle2, FileText, Phone, Repeat2, Sparkles } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { Select, TextField } from '../primitives/Field';
import { ProgressBar } from '../primitives/Progress';
import { SectionLabel } from '../primitives/Panel';
import type { TicketModel } from './model';

/**
 * One item of the call center's queue (s03): what the customer asked, the
 * service the rules propose (each field can be corrected), what was already
 * checked and the three things a person does with it. Confirmed, it shows the
 * receipt of what left the system.
 */
export function TicketDetail({ ticket, copy, onChange, onConfirm, onChangeTurn, onCallBack, actionsTitle }: {
  ticket: TicketModel;
  copy: UiCopy;
  onChange: (patch: Partial<TicketModel['service']>) => void;
  onConfirm: Action;
  onChangeTurn: Action;
  onCallBack: Action;
  /** Why the actions are off, when they are. */
  actionsTitle?: string;
}) {
  const c = copy.orgs.callCenter;
  const done = Boolean(ticket.receipt);
  const busy = Boolean(ticket.running);
  const lock = done || busy;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5 md:px-7">
      <h1 className="text-[20px] font-semibold leading-7 text-app-text">{ticket.title}</h1>
      <div className="mt-4 flex max-w-[860px] flex-col gap-3">
        <Card title={<span className="flex items-center gap-2"><Chip tone="pink" icon={Sparkles} strong>{copy.common.ai}</Chip>{c.asked}</span>}>
          <p className="text-prose leading-6 text-app-text-body">
            {ticket.asked.text}{' '}
            <Chip tone="blue" icon={FileText} className="align-middle">{ticket.asked.source}</Chip>
          </p>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Chip tone="blue" strong>{copy.flows.rule}</Chip>{c.proposedService}</span>}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select label={c.turn} value={ticket.service.turn} options={ticket.turnOptions} onChange={(v) => onChange({ turn: v })} disabled={lock} />
            <TextField label={c.site} value={ticket.service.site} onChange={(v) => onChange({ site: v })} disabled={lock} />
            <TextField label={c.vehicle} value={ticket.service.vehicle} onChange={(v) => onChange({ vehicle: v })} disabled={lock} />
            <TextField label={c.notice} value={ticket.service.notice} onChange={(v) => onChange({ notice: v })} disabled={lock} />
          </div>
        </Card>
        <Card title={c.checked}>
          <ul className="list-disc space-y-0.5 pl-4 text-prose leading-6">
            {ticket.checked.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </Card>
        {ticket.receipt && (
          <Card tone="green" icon={CheckCircle2} title={ticket.receipt.title}>
            <ul className="space-y-0.5 text-prose leading-6">
              {ticket.receipt.lines.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </Card>
        )}
        {ticket.running && (
          <Card title={c.inProgress}>
            <ProgressBar value={ticket.running.progress} label={ticket.running.label} />
          </Card>
        )}
        {ticket.events.length > 0 && (
          <section>
            <SectionLabel className="mb-1.5">{c.history}</SectionLabel>
            <ul className="space-y-1 text-compact text-app-text-secondary">
              {ticket.events.map((e) => (
                <li key={e.id} className="flex gap-2"><span className="w-12 shrink-0 tabular-nums text-app-text-tertiary">{e.at}</span>{e.what}</li>
              ))}
            </ul>
          </section>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="confirm" size="lg" onClick={lock ? false : onConfirm} title={done ? c.alreadyConfirmed : actionsTitle}>{c.confirm}</Button>
          <Button size="lg" icon={Repeat2} onClick={lock ? false : onChangeTurn} title={done ? c.alreadyConfirmed : actionsTitle}>{c.changeTurn}</Button>
          <Button size="lg" icon={Phone} onClick={busy ? false : onCallBack} title={actionsTitle}>{c.callBack}</Button>
        </div>
      </div>
    </div>
  );
}
