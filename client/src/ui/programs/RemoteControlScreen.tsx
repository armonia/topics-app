import { Check, Hand, Keyboard, ScrollText, ShieldCheck, X } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { TONE_CHIP } from '../tone';
import { Button } from '../primitives/Button';
import { Select } from '../primitives/Field';
import { SectionLabel } from '../primitives/Panel';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import { DesktopFrame, DrawnWindow, MaskWindow } from './DesktopFrame';
import type { MaskModel, RemoteStatus } from './model';

export interface RemoteLiveModel {
  /** «OP ha consentito alle 09:14». (allow-italian: quotes the Italian interface) */
  consented: string;
  remaining: string;
  mask: MaskModel;
  keyboardBy: 'armonia' | 'person';
  note: string;
  keyboardLabel: string;
  keyboardChip: string;
  passwordSaved?: string;
}

export interface RemoteEndedModel {
  title: string;
  body: string;
  rows: Array<[string, string]>;
}

/**
 * Remote control with consent (e02): two views of one session side by side,
 * the PC of the organization (where a person decides) and Topics (where
 * Armonia works). Nothing is seen before the person at the PC says yes; the
 * session has a time limit, is recorded in the log, and either side can end
 * it. All of it is driven by `status`, which the container keeps.
 */
export function RemoteControlScreen({
  copy, status, pcName, windowName, pcOptions, onPc, reasonOptions, reason, onReason, requestAllowed, onRequest, onCancelAsk,
  consentReason, onAllow, onDeny, onPersonStop, remainingLabel, live, onClose, onKeyboard, denied, onAskAgain, ended, onOpenLog, backLabel, onBack, phone,
}: {
  copy: UiCopy;
  status: RemoteStatus;
  pcName: string;
  windowName: string;
  pcOptions: Array<{ value: string; label: string }>;
  onPc: (id: string) => void;
  reasonOptions: Array<{ value: string; label: string }>;
  reason: string;
  onReason: (id: string) => void;
  requestAllowed: boolean;
  onRequest: Action;
  onCancelAsk: Action;
  consentReason: string;
  onAllow: Action;
  onDeny: Action;
  onPersonStop: Action;
  remainingLabel: string;
  live?: RemoteLiveModel;
  onClose: Action;
  onKeyboard: Action;
  denied?: string;
  onAskAgain: Action;
  ended?: RemoteEndedModel;
  onOpenLog: Action;
  backLabel: string;
  onBack: () => void;
  phone?: boolean;
}) {
  const r = copy.programs.remote;
  const d = r.dialog;
  const left = (
    <div className="min-w-0">
      <SectionLabel className="mb-2">{r.pcSide}</SectionLabel>
      <DesktopFrame taskbarLeft={[windowName]} taskbarRight={pcName} minHeight={phone ? 300 : 400}>
        {status === 'asked' && (
          <DrawnWindow program={d.app} title={d.kind} width={380}>
            <div className="p-5">
              <h3 className="text-body-lg font-semibold">{d.title}</h3>
              <p className="mt-2 text-prose leading-5" style={{ color: '#333' }}>{d.body(consentReason)}</p>
              <dl className="mt-4 space-y-1.5 text-prose" style={{ color: '#333' }}>
                <div className="flex justify-between gap-3"><dt>{d.maxTime}</dt><dd className="font-semibold" style={{ color: '#1a1a1a' }}>{d.maxTimeValue(30)}</dd></div>
                <div className="flex justify-between gap-3"><dt>{d.recording}</dt><dd className="font-semibold" style={{ color: '#1a1a1a' }}>{d.recordingValue}</dd></div>
              </dl>
              <div className="mt-5 grid grid-cols-2 gap-2.5">
                <button type="button" onClick={onAllow || undefined} className="h-9 rounded-md text-prose font-medium text-white" style={{ backgroundColor: '#1f9d55' }}>{d.allow}</button>
                <button type="button" onClick={onDeny || undefined} className="h-9 rounded-md text-prose font-medium" style={{ backgroundColor: '#e5e5e5', color: '#1a1a1a' }}>{d.deny}</button>
              </div>
            </div>
          </DrawnWindow>
        )}
        {status === 'live' && live && (
          <div className="flex w-full max-w-[380px] flex-col items-stretch gap-3">
            <DrawnWindow program={d.app} title={d.kind} width={380}>
              <div className="flex items-center gap-3 p-4">
                <ShieldCheck size={18} style={{ color: '#1f9d55' }} aria-hidden="true" />
                <p className="min-w-0 flex-1 text-prose leading-5" style={{ color: '#1a1a1a' }}>{r.whileLive.banner(live.keyboardBy === 'armonia' ? r.who.armonia : r.who.person)} · {r.whileLive.remaining(remainingLabel)}</p>
              </div>
              <div className="px-4 pb-4">
                <button type="button" onClick={onPersonStop || undefined} className="h-8 w-full rounded-md text-prose font-medium" style={{ backgroundColor: '#e5e5e5', color: '#1a1a1a' }}>{r.whileLive.stop}</button>
              </div>
            </DrawnWindow>
          </div>
        )}
        {status !== 'asked' && status !== 'live' && (
          <p className="max-w-[320px] rounded-md bg-black/25 px-3 py-2 text-center text-prose text-white">
            {status === 'ended' ? r.desktopEnded : r.desktopIdle}
          </p>
        )}
      </DesktopFrame>
    </div>
  );
  const right = (
    <div className="min-w-0">
      <SectionLabel className="mb-2">{r.topicsSide}</SectionLabel>
      <div className="overflow-hidden rounded-xl border border-app-border bg-surface">
        {status === 'live' && live ? (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
              <span className={clsx('inline-flex h-5 items-center gap-1 rounded-full px-2 text-mini', TONE_CHIP.red)}><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />{r.live.chip}</span>
              <span className="text-prose font-semibold text-app-text">{pcName}</span>
              <span className="text-prose text-app-text-tertiary">{live.consented}</span>
              <span className="ml-auto tabular-nums text-prose text-app-text-secondary">{r.live.remaining(live.remaining)}</span>
              <Button variant="danger" icon={X} onClick={onClose} className="bg-rose-500/10">{r.live.close}</Button>
            </div>
            <DesktopFrame taskbarLeft={[windowName]} className="rounded-none" minHeight={phone ? 320 : 360}>
              <MaskWindow mask={live.mask} width={560} />
            </DesktopFrame>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-prose text-app-text-secondary">
              <span className="min-w-0 flex-1">{live.passwordSaved ?? live.note}</span>
              <Button icon={live.keyboardBy === 'armonia' ? Hand : Keyboard} onClick={onKeyboard} title={live.keyboardLabel}>
                {live.keyboardChip}
              </Button>
            </div>
          </>
        ) : (
          <div className="p-5">
            {status === 'idle' && (
              <>
                <h2 className="text-body-lg font-semibold text-app-text">{r.request.title}</h2>
                <p className="mt-1 text-prose leading-5 text-app-text-secondary">{r.request.body}</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Select label={r.request.pc} value={pcName} options={pcOptions} onChange={onPc} />
                  <Select label={r.request.reason} value={reason} options={reasonOptions} onChange={onReason} />
                </div>
                <div className="mt-4"><Button variant="primary" icon={ShieldCheck} onClick={requestAllowed ? onRequest : false} title={requestAllowed ? undefined : r.request.permission}>{r.request.submit}</Button></div>
              </>
            )}
            {status === 'asked' && (
              <>
                <h2 className="text-body-lg font-semibold text-app-text">{r.asked.title(pcName)}</h2>
                <p className="mt-1 text-prose leading-5 text-app-text-secondary">{r.asked.body(r.who.person)}</p>
                <div className="mt-4"><Button onClick={onCancelAsk}>{r.asked.cancel}</Button></div>
              </>
            )}
            {status === 'denied' && (
              <>
                <h2 className="text-body-lg font-semibold text-app-text">{r.denied.title(pcName)}</h2>
                <p className="mt-1 text-prose leading-5 text-app-text-secondary">{r.denied.body}{denied ? ` ${r.denied.at(denied)}` : ''}</p>
                <div className="mt-4"><Button variant="primary" onClick={onAskAgain}>{r.denied.again}</Button></div>
              </>
            )}
            {status === 'ended' && ended && (
              <>
                <h2 className="flex items-center gap-2 text-body-lg font-semibold text-app-text"><Check size={16} className="text-emerald-600" aria-hidden="true" />{ended.title}</h2>
                <p className="mt-1 text-prose leading-5 text-app-text-secondary">{ended.body}</p>
                <dl className="mt-3 space-y-1">
                  {ended.rows.map(([k, v]) => <div key={k} className="flex gap-3 text-prose"><dt className="text-app-text-secondary">{k}</dt><dd className="ml-auto font-medium text-app-text">{v}</dd></div>)}
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button icon={ScrollText} onClick={onOpenLog}>{r.ended.openLog}</Button>
                  <Button variant="primary" onClick={onAskAgain}>{r.ended.again}</Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader leading={<BackButton label={backLabel} onClick={onBack} copy={copy} />} crumbs={[{ label: r.root }]} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <h1 className="mb-6 text-center text-[20px] font-semibold tracking-[-0.01em] text-app-text">{r.title}</h1>
        <div className={clsx('mx-auto grid max-w-[1180px] gap-6', phone ? 'grid-cols-1' : 'grid-cols-[minmax(0,5fr)_minmax(0,6fr)]')}>
          {left}
          {right}
        </div>
      </div>
    </div>
  );
}
