import { useState } from 'react';
import { Copy, ExternalLink, Eye, Link2, Plus, Search, Share2, Trash2 } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { Dialog } from '../primitives/Dialog';
import { EmptyState } from '../primitives/EmptyState';
import { Select, TextField, Toggle } from '../primitives/Field';
import { Table } from '../primitives/Table';
import { Tabs } from '../primitives/Tabs';
import { Timeline } from '../primitives/Timeline';
import type { OptionModel, ShareActions, ShareDetailModel, ShareDraft, ShareFilter, ShareRowModel } from './model';
import { SectionHead } from './parts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** «Nuova condivisione»: a button and the window with its choices. (allow-italian: quotes the Italian interface) */
export function ShareButton({ copy, cases, views, guests, defaultUntil, today, allowed, deniedTitle, onCreate }: {
  copy: UiCopy;
  cases: OptionModel[];
  views: OptionModel[];
  guests: OptionModel[];
  /** YYYY-MM-DD the link expires on unless the reader chooses another. */
  defaultUntil: string;
  /** YYYY-MM-DD of the demo's today: the expiry has to be after it. */
  today: string;
  allowed: boolean;
  deniedTitle?: string;
  onCreate: (draft: ShareDraft) => void;
}) {
  const s = copy.team.shares;
  const d = s.dialog;
  const blank = (): ShareDraft => ({
    scopeKind: 'record', target: cases[0]?.value ?? '', email: '', guest: guests[0]?.value ?? '', can: 'comment', until: defaultUntil,
    includes: { contributor: false, sameContributor: false, assistant: false }, watermark: true,
  });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ShareDraft>(blank);
  const [tried, setTried] = useState(false);
  const set = (patch: Partial<ShareDraft>) => setDraft((v) => ({ ...v, ...patch }));
  const emailOk = EMAIL.test(draft.email.trim());
  const untilOk = draft.until > today;
  const targets = draft.scopeKind === 'record' ? cases : views;
  const close = () => {
    setOpen(false);
    setTried(false);
    setDraft(blank());
  };
  const submit = () => {
    setTried(true);
    if (!emailOk || !untilOk || !draft.target) return;
    onCreate({ ...draft, email: draft.email.trim().toLowerCase() });
    close();
  };
  return (
    <>
      <Button variant="primary" icon={Plus} onClick={allowed ? () => setOpen(true) : false} title={deniedTitle}>{s.newShare}</Button>
      {open && (
        <Dialog
          title={d.title}
          size="md"
          onClose={close}
          closeLabel={copy.team.common.close}
          footer={
            <div className="flex justify-end gap-2">
              <Button onClick={close}>{copy.team.common.cancel}</Button>
              <Button variant="primary" icon={Link2} onClick={submit}>{d.submit}</Button>
            </div>
          }
        >
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label={d.scopeKindField}
                value={draft.scopeKind}
                onChange={(v) => set({ scopeKind: v as ShareDraft['scopeKind'], target: (v === 'record' ? cases : views)[0]?.value ?? '' })}
                options={[{ value: 'record', label: s.scopeKind.record }, { value: 'view', label: s.scopeKind.view }]}
              />
              <Select label={d.targetField} value={draft.target} onChange={(v) => set({ target: v })} options={targets} />
            </div>
            <TextField label={d.emailField} type="email" value={draft.email} onChange={(v) => set({ email: v })} placeholder={d.emailPlaceholder} error={tried && !emailOk ? d.emailInvalid : undefined} autoFocus onEnter={submit} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Select label={d.guestField} value={draft.guest} onChange={(v) => set({ guest: v })} options={guests} />
              <Select label={d.canField} value={draft.can} onChange={(v) => set({ can: v as ShareDraft['can'] })} options={[{ value: 'view', label: s.can.view }, { value: 'comment', label: s.can.comment }]} />
              <TextField label={d.untilField} type="date" value={draft.until} onChange={(v) => set({ until: v })} error={tried && !untilOk ? d.untilInvalid : undefined} />
            </div>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-compact font-medium text-app-text-secondary">{d.seesField}</legend>
              <Toggle checked disabled label={s.includes.record} title={s.includes.record} onChange={() => undefined} />
              <Toggle label={s.includes.contributor} checked={draft.includes.contributor} onChange={(v) => set({ includes: { ...draft.includes, contributor: v } })} />
              <Toggle label={s.includes.sameContributor} checked={draft.includes.sameContributor} onChange={(v) => set({ includes: { ...draft.includes, sameContributor: v } })} />
              <Toggle label={s.includes.assistant} checked={draft.includes.assistant} onChange={(v) => set({ includes: { ...draft.includes, assistant: v } })} />
              <Toggle label={d.watermark} checked={draft.watermark} onChange={(v) => set({ watermark: v })} />
            </fieldset>
            <p className="text-mini text-app-text-tertiary">{d.accessNote}</p>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** The detail of one share: its link, what the guest sees, the rules, who opened it. Its controls are live. */
function ShareDetail({ share, actions, copy, today }: { share: ShareDetailModel; actions: ShareActions; copy: UiCopy; today: string }) {
  const s = copy.team.shares;
  const d = s.detail;
  const [until, setUntil] = useState(share.until);
  const untilBad = until.length > 0 && until <= today;
  return (
    <Card
      title={share.what}
      icon={Share2}
      actions={<Chip tone={share.state.tone}>{share.state.text}</Chip>}
    >
      <div className="flex flex-col gap-4 px-3.5 pb-4 pt-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded-lg bg-app-inset px-3 py-1.5 font-mono text-compact text-app-text" aria-label={d.linkLabel}>{share.link}</span>
          <Button icon={Copy} onClick={actions.onCopy}>{d.copy}</Button>
          <Button icon={Eye} onClick={actions.onTry}>{d.tryLink}</Button>
          <Button icon={ExternalLink} onClick={actions.onOpenScope}>{d.open}</Button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <p className="text-prose text-app-text-secondary">{share.to} · {share.email}</p>
            <div className="grid grid-cols-2 gap-3">
              <Select label={d.canField} value={share.can} onChange={(v) => actions.onCan(v as 'view' | 'comment')} disabled={!share.editable} options={[{ value: 'view', label: s.can.view }, { value: 'comment', label: s.can.comment }]} />
              <TextField
                label={d.untilField}
                type="date"
                value={until}
                disabled={!share.editable}
                error={untilBad ? d.untilInvalid : undefined}
                onChange={(v) => {
                  setUntil(v);
                  if (v > today) actions.onUntil(v);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-compact font-medium text-app-text-secondary">{d.sees}</p>
              {share.base && <Toggle label={share.base} checked disabled title={share.base} onChange={() => undefined} />}
              {share.includes.map((i) => (
                <Toggle key={i.id} label={i.label} checked={i.on} disabled={!share.editable} onChange={(v) => actions.onInclude(i.id, v)} />
              ))}
              <Toggle label={d.watermark} description={d.watermarkHint} checked={share.watermark} disabled={!share.editable} onChange={actions.onWatermark} />
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <p className="text-compact font-medium text-app-text-secondary">{d.opensTitle}</p>
            {share.opens.length === 0 ? (
              <p className="text-prose text-app-text-tertiary">{d.opensEmpty}</p>
            ) : (
              <Timeline ariaLabel={d.opensTitle} items={share.opens.map((o) => ({ id: o.id, at: o.at, title: o.who }))} />
            )}
            <p className="text-mini text-app-text-tertiary">{share.createdBy}</p>
            <p className="text-mini text-app-text-tertiary">{d.codeNote} · {d.accessCode} {share.code}</p>
          </div>
        </div>
        {share.receipt && (
          <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-prose text-emerald-800 dark:text-emerald-300">
            <p className="font-medium">{share.receipt.title}</p>
            {share.receipt.lines.map((l) => <p key={l}>{l}</p>)}
          </div>
        )}
        {share.active && (
          <div className="border-t border-app-border pt-3">
            <Button variant="danger" icon={Trash2} onClick={actions.onRevoke}>{d.revoke}</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** What is shared with people outside: the list, filtered and searched, and the detail of the one picked. */
export function SharesPage({ copy, rows, detail, actions, filter, onFilter, counts, query, onQuery, today, intro }: {
  copy: UiCopy;
  rows: ShareRowModel[];
  detail?: ShareDetailModel;
  actions: ShareActions;
  filter: ShareFilter;
  onFilter: (f: ShareFilter) => void;
  counts: Record<ShareFilter, number>;
  query: string;
  onQuery: (q: string) => void;
  today: string;
  intro: string;
}) {
  const s = copy.team.shares;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-prose leading-6 text-app-text-secondary">{intro}</p>
      <div className="flex flex-col gap-3">
        <Tabs<ShareFilter>
          ariaLabel={s.filterLabel}
          value={filter}
          onChange={onFilter}
          options={[
            { value: 'active', label: s.filters.active, count: counts.active },
            { value: 'expired', label: s.filters.expired, count: counts.expired },
            { value: 'revoked', label: s.filters.revoked, count: counts.revoked },
            { value: 'all', label: s.filters.all, count: counts.all },
          ]}
        />
        <TextField type="search" icon={Search} value={query} onChange={onQuery} placeholder={s.search} />
        <Table
          ariaLabel={copy.app.settingsSections.condivisioni}
          columns={[
            { id: 'what', label: s.columns.what },
            { id: 'who', label: s.columns.who },
            { id: 'can', label: s.columns.can, width: 170 },
            { id: 'until', label: s.columns.until, width: 110 },
            { id: 'state', label: s.columns.state, width: 100 },
          ]}
          rows={rows.map((r) => ({
            id: r.id,
            selected: r.selected,
            onOpen: r.selected ? undefined : r.onSelect,
            cells: {
              what: (
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <Chip>{r.kind}</Chip>
                  <span className="min-w-0 font-medium">{r.what}</span>
                </span>
              ),
              who: <span className="text-app-text-secondary" data-tip={r.email}>{r.who}</span>,
              can: <span className="text-app-text-secondary">{r.can}</span>,
              until: r.until,
              state: <Chip tone={r.state.tone}>{r.state.text}</Chip>,
            },
          }))}
          empty={
            counts.all === 0 ? (
              <EmptyState icon={Share2} title={s.emptyTitle} className="min-h-0 py-4">{s.emptyBody}</EmptyState>
            ) : (
              <EmptyState icon={Search} title={s.noMatchTitle} className="min-h-0 py-4" action={filter !== 'all' || query ? <Button onClick={() => { onFilter('all'); onQuery(''); }}>{copy.team.squad.clear}</Button> : undefined}>
                {s.noMatchBody}
              </EmptyState>
            )
          }
        />
      </div>
      {detail && (
        <section>
          <SectionHead title={s.detail.tag} />
          <ShareDetail key={detail.id} share={detail} actions={actions} copy={copy} today={today} />
        </section>
      )}
    </div>
  );
}

