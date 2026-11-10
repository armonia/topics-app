import { CheckCircle2, MapPin, PhoneCall, PhoneIncoming, Sparkles, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { TextField } from '../primitives/Field';
import { ProgressBar, Spinner } from '../primitives/Progress';
import type { CallModel } from './model';

const TONE = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  idle: 'text-app-text-tertiary',
} as const;

/**
 * A call (s03): the transcript as it is heard, the form the AI fills from it
 * (each field can be corrected), the check of the address against the street
 * index, and the way to open a report from it. A ringing call can be answered;
 * while it is live the lines and the fields appear one after the other.
 */
export function CallDetail({ call, copy, onAnswer, onField, onUseSuggestion, onOpenReport, onGoReport, reportTitle }: {
  call: CallModel;
  copy: UiCopy;
  onAnswer: Action;
  onField: (id: string, value: string) => void;
  onUseSuggestion: (street: string) => void;
  onOpenReport: Action;
  onGoReport: () => void;
  reportTitle?: string;
}) {
  const c = copy.orgs.callCenter;
  const ringing = call.status === 'ringing';
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5 md:px-7">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-headline font-semibold leading-7 text-app-text">{call.caller}</h1>
        <Chip tone={ringing ? 'amber' : call.status === 'live' ? 'green' : 'neutral'} icon={ringing ? PhoneIncoming : PhoneCall}>
          {ringing ? c.statusRinging : call.status === 'live' ? c.statusLive : c.statusEnded(call.when)}
        </Chip>
      </div>
      <div className="mt-4 flex max-w-[960px] flex-col gap-3">
        {ringing ? (
          <Card icon={PhoneIncoming} tone="amber" title={c.incomingTitle}>
            <p className="text-prose leading-6">{c.incomingBody}</p>
            <div className="mt-3"><Button variant="confirm" size="lg" icon={PhoneCall} onClick={onAnswer} title={reportTitle}>{c.answer}</Button></div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card title={<span className="flex items-center gap-2">{c.transcript}{call.status === 'live' && <Spinner size={12} label={c.statusLive} />}</span>}>
              <ol className="space-y-2" aria-label={c.transcript}>
                {call.lines.map((l) => (
                  <li key={l.id} className="flex gap-2">
                    <span className={clsx('w-[74px] shrink-0 text-mini font-semibold uppercase tracking-wide', l.who === 'operator' ? 'text-app-text-tertiary' : 'text-primary dark:text-primary-dark')}>
                      {l.who === 'operator' ? c.operator : c.caller}
                    </span>
                    <span className="min-w-0 flex-1 text-prose leading-5 text-app-text-body">{l.text}</span>
                  </li>
                ))}
                {call.lines.length === 0 && <li className="text-app-text-tertiary">{c.waitingAudio}</li>}
              </ol>
              {call.status === 'live' && <ProgressBar className="mt-3" value={call.progress} label={c.transcribing} />}
            </Card>
            <Card title={<span className="flex items-center gap-2"><Chip tone="pink" icon={Sparkles} strong>{copy.common.ai}</Chip>{c.formTitle}</span>}>
              <div className="flex flex-col gap-2.5">
                {call.fields.map((f) => (
                  <TextField
                    key={f.id}
                    label={f.label}
                    value={f.value}
                    onChange={(v) => onField(f.id, v)}
                    placeholder={f.filled ? undefined : c.notHeardYet}
                    error={f.error}
                    disabled={call.status === 'live'}
                  />
                ))}
              </div>
            </Card>
          </div>
        )}
        {!ringing && (
          <Card icon={call.address.tone === 'warn' ? TriangleAlert : MapPin} tone={call.address.tone === 'ok' ? 'green' : call.address.tone === 'warn' ? 'amber' : 'neutral'} title={c.addressCheck}>
            <p className={clsx('text-prose font-medium leading-6', TONE[call.address.tone])}>{call.address.title}</p>
            <p className="text-prose leading-6">{call.address.body}</p>
            {call.address.suggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-compact text-app-text-tertiary">{c.didYouMean}</span>
                {call.address.suggestions.map((s) => (
                  <Button key={s} size="sm" onClick={() => onUseSuggestion(s)}>{s}</Button>
                ))}
              </div>
            )}
          </Card>
        )}
        {call.opening && (
          <Card title={c.opening}><ProgressBar value={call.opening.progress} label={call.opening.label} /></Card>
        )}
        {call.status === 'ended' && !call.opening && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {call.ticketId ? (
              <>
                <Chip tone="green" icon={CheckCircle2}>{c.reportOpened}</Chip>
                <Button size="lg" onClick={onGoReport}>{c.goToReport}</Button>
              </>
            ) : (
              <Button variant="primary" size="lg" onClick={onOpenReport} title={reportTitle}>{c.openReport}</Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
