/**
 * The queue of «Da fare» (n12) and the origin of a value (v02): the cases (allow-italian: quotes the Italian interface)
 * waiting for a person, the original beside every claim, confirm or correct
 * in place. The queue, the filters, the keys and the count in the sidebar all
 * read the same list (`queueFor`), so confirming a case shrinks it everywhere.
 */
import { Inbox, Search } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { TextField } from '../../../../ui/primitives/Field';
import { MenuButton } from '../../../../ui/primitives/Menu';
import { InboxScreen, ReviewScreen } from '../../../../ui/inbox/InboxScreen';
import { PhoneQueue, PhoneReview } from '../../../../ui/inbox/PhoneInbox';
import { KeyboardArea } from '../../../../ui/work/KeyboardArea';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { recordName } from '../../../../ui/fixtures/work';
import { findLiveCase, queueFor, visibleCases, type LiveCase } from '../../store/cases';
import { P } from '../../paths';
import { inboxOf, mainDocument, originOf, recordPathOf, reviewOf } from './adapters';
import { confirmCase, rejectCase, setFieldValue } from './actions';
import { openOriginal, openSource } from './keys';

const EDIT_KEY = 'work.inbox.edit';

/** The field with the lowest confidence: where «correct» starts. */
function weakestField(c: LiveCase): string | undefined {
  return c.fields.reduce<LiveCase['fields'][number] | undefined>((w, f) => (!w || f.confidence < w.confidence ? f : w), undefined)?.id;
}

export function InboxPlace({ ctx, item }: { ctx: ScreenCtx; item?: string }) {
  const w = ctx.copy.work.inbox;
  const [filter, setFilter] = ctx.ui<'all' | 'overdue'>('work.inbox.filter', 'all');
  const [office, setOffice] = ctx.ui<string>('work.inbox.office', 'all');
  const [query, setQuery] = ctx.ui<string>('work.inbox.query', '');
  const [editing, setEditing] = ctx.ui<string>(EDIT_KEY, '');

  const queue = queueFor(ctx.state, ctx.persona);
  const visible = visibleCases(ctx.state, ctx.persona, 'nocera');
  /* Without a filter match the first of the list is on show; an address names its own. */
  const probe = inboxOf(queue, { filter, office, query }, undefined, undefined, ctx.copy, ctx.now);
  const shown = probe.shown;
  const current: LiveCase | undefined = item ? visible.find((c) => c.id === item) : (ctx.phone ? undefined : shown[0]);
  const decided = Boolean(current) && current!.status !== 'da-confermare';
  const review = current ? reviewOf(current, ctx.copy, ctx.now) : undefined;
  const { inbox, offices } = inboxOf(queue, { filter, office, query }, current?.id, review, ctx.copy, ctx.now);

  const goAfter = (c: LiveCase) => {
    const at = shown.findIndex((x) => x.id === c.id);
    const next = shown[at + 1] ?? shown[at - 1];
    ctx.go(next ? P.inbox(next.id) : P.inbox());
  };
  const confirm = (c: LiveCase) => ctx.allow('edit:data', () => {
    confirmCase(ctx, c);
    goAfter(c);
  });
  const reject = (c: LiveCase) => ctx.allow('edit:data', () => rejectCase(ctx, c));

  const clearFilters = () => {
    setFilter('all');
    setOffice('all');
    setQuery('');
  };

  const toolbar = (
    <>
      <TextField size="sm" type="search" icon={Search} value={query} onChange={setQuery} placeholder={w.searchPlaceholder} className="min-w-0 flex-1" />
      <MenuButton
        size="sm"
        label={office === 'all' ? w.officeFilter : OFFICE_LABEL[office as keyof typeof OFFICE_LABEL] ?? office}
        items={[{ id: 'all', label: w.allOffices }, ...offices.map((o) => ({ id: o.id, label: o.label, hint: String(o.count) }))]}
        onSelect={setOffice}
      />
    </>
  );
  const empty = queue.length === 0 ? (
    <EmptyState icon={Inbox} title={w.emptyTitle} action={<Button variant="primary" onClick={() => ctx.go(P.today())}>{w.goToday}</Button>}>{w.emptyBody}</EmptyState>
  ) : (
    <EmptyState icon={Search} title={w.noMatchTitle} action={<Button onClick={clearFilters}>{w.clearFilters}</Button>}>{w.noMatchBody}</EmptyState>
  );

  const open = (id: string) => ctx.go(P.inbox(id));

  /* Phone: the list first, an input full screen. */
  if (ctx.phone && !current) {
    return <PhoneQueue inbox={inbox} copy={ctx.copy} filter={filter} onFilterChange={setFilter} onOpen={open} toolbar={toolbar} empty={empty} />;
  }

  const notFound = item && !current;
  const detail = notFound ? (
    <EmptyState icon={Inbox} title={w.notFoundTitle} action={<Button onClick={() => ctx.go(P.inbox())}>{w.backToQueue}</Button>}>{w.notFoundBody}</EmptyState>
  ) : !current ? (
    <EmptyState icon={Inbox} title={queue.length === 0 ? w.emptyTitle : w.selectOne}>{queue.length === 0 ? w.emptyBody : undefined}</EmptyState>
  ) : undefined;

  const explainLinks = current ? Object.fromEntries(current.fields.map((f) => [f.id, () => ctx.go(P.inboxOrigin(current.id, f.id))])) : undefined;
  const banner = current && decided ? (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-app-border bg-app-inset px-3 py-2 text-prose text-app-text-secondary">
      <Chip tone="green">{ctx.copy.work.record.statusOf[current.status]}</Chip>
      <span className="min-w-0 flex-1">{w.decidedBanner(ctx.copy.work.record.statusOf[current.status])}</span>
      <Button onClick={() => ctx.go(recordPathOf(current))}>{ctx.copy.work.toast.openRecord}</Button>
    </div>
  ) : undefined;
  const onEditField = current ? (fieldId: string, value: string) => {
    setFieldValue(ctx, current, fieldId, value);
    setEditing('');
  } : undefined;
  const editingFieldId = current && editing.startsWith(`${current.id}|`) ? editing.slice(current.id.length + 1) : undefined;

  if (ctx.phone && current && review) {
    return (
      <PhoneReview
        review={review}
        copy={ctx.copy}
        backLabel={ctx.copy.shell.nav.inbox}
        onBack={() => ctx.go(P.inbox())}
        decided={decided}
        banner={banner}
        onConfirm={decided ? undefined : confirm(current)}
        onReject={decided ? undefined : reject(current)}
        onOpenOriginals={() => { const d = mainDocument(current); if (d) openOriginal(ctx, current, d.id); }}
        onOpenSource={(s) => openSource(ctx, current, s)}
        onExplainField={explainLinks}
        onEditField={ctx.can('edit:data') ? onEditField : undefined}
        editingFieldId={editingFieldId}
        onCancelEdit={() => setEditing('')}
        onOpenRecord={() => ctx.go(recordPathOf(current))}
      />
    );
  }

  const onKey = (key: string, on: { control: boolean; selectedRow: boolean }) => {
    const at = shown.findIndex((x) => x.id === current?.id);
    if (key === 'j' || key === 'k') {
      const next = shown[Math.max(0, Math.min(shown.length - 1, (at < 0 ? -1 : at) + (key === 'j' ? 1 : -1)))];
      if (!next || next.id === current?.id) return false;
      ctx.go(P.inbox(next.id));
      return true;
    }
    if (!current) return false;
    if (key === 'Enter' && (!on.control || on.selectedRow) && !decided) {
      const run = confirm(current);
      if (run) run();
      return true;
    }
    if (key === 'e' && !on.control) {
      const f = weakestField(current);
      if (f) ctx.go(P.inboxOrigin(current.id, f));
      return Boolean(f);
    }
    return false;
  };

  return (
    <KeyboardArea onKey={onKey} label={ctx.copy.shell.nav.inbox}>
      <InboxScreen
        inbox={inbox}
        copy={ctx.copy}
        filter={filter}
        onFilterChange={setFilter}
        toolbar={toolbar}
        empty={empty}
        onSelect={open}
        onOpenSource={current ? (s) => openSource(ctx, current, s) : undefined}
        onExplainField={explainLinks}
        onOpenRecord={current ? () => ctx.go(recordPathOf(current)) : undefined}
        onConfirm={current ? confirm(current) : undefined}
        onReject={current ? reject(current) : undefined}
        onAsk={current ? () => ctx.go(recordPathOf(current)) : undefined}
        onEditField={ctx.can('edit:data') ? onEditField : undefined}
        editingFieldId={editingFieldId}
        onCancelEdit={() => setEditing('')}
        banner={banner}
        decided={decided}
        detail={detail}
      />
    </KeyboardArea>
  );
}

/** The origin of one value (v02), from the queue or from the record the input became. */
export function OriginPlace({ ctx, id, field, from }: { ctx: ScreenCtx; id: string; field: string; from: 'inbox' | 'record' }) {
  const w = ctx.copy.work.inbox;
  const [editing, setEditing] = ctx.ui<string>(EDIT_KEY, '');
  const c = visibleCases(ctx.state, ctx.persona).find((x) => x.id === id) ?? findLiveCase(ctx.state, id);
  const back = c ? (from === 'inbox' ? P.inbox(id) : recordPathOf(c)) : P.inbox();
  const backLabel = from === 'inbox' ? ctx.copy.shell.nav.inbox : recordName(id);
  if (!c || !c.fields.some((f) => f.id === field)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EmptyState icon={Inbox} title={w.fieldNotFound} action={<Button onClick={() => ctx.go(back)}>{w.backToQueue}</Button>} />
      </div>
    );
  }
  const review = reviewOf(c, ctx.copy, ctx.now);
  const origin = originOf(c, field);
  const decided = c.status !== 'da-confermare';
  const seedValue = origin?.value ?? '';
  const applied = c.live.values?.[field] === seedValue;
  /* The value already explained closes its explanation, like a toggle (it is drawn pressed). */
  const toOrigin = (f: string) => ctx.go(f === field ? back : from === 'inbox' ? P.inboxOrigin(id, f) : P.recordOrigin(id, f));
  const explainLinks = Object.fromEntries(c.fields.map((f) => [f.id, () => toOrigin(f.id)]));
  const seedSource = origin?.source;
  const openDoc = () => {
    if (seedSource?.id) openOriginal(ctx, c, seedSource.id, seedSource.page, field);
  };
  const common = {
    review,
    copy: ctx.copy,
    explain: { fieldId: field, origin },
    decided,
    onConfirm: decided ? undefined : ctx.allow('edit:data', () => { confirmCase(ctx, c); ctx.go(P.record(id)); }),
    onReject: decided ? undefined : ctx.allow('edit:data', () => rejectCase(ctx, c)),
    onOpenSource: (s: Parameters<typeof openSource>[2]) => openSource(ctx, c, s),
    onExplainField: explainLinks,
    onEditField: ctx.can('edit:data') ? (f: string, value: string) => { setFieldValue(ctx, c, f, value); setEditing(''); } : undefined,
    editingFieldId: editing === `${id}|${field}` ? field : undefined,
    onCancelEdit: () => setEditing(''),
    explainActions: {
      onUse: ctx.allow('edit:data', () => { setFieldValue(ctx, c, field, seedValue); ctx.go(back); }),
      onEdit: ctx.allow('edit:data', () => setEditing(`${id}|${field}`)),
      applied,
      onOpenDocument: openDoc,
      onOpenSource: openDoc,
      onClose: () => ctx.go(back),
    },
  };
  if (ctx.phone) {
    return (
      <PhoneReview
        {...common}
        backLabel={backLabel}
        onBack={() => ctx.go(back)}
        onOpenOriginals={() => { const d = mainDocument(c); if (d) openOriginal(ctx, c, d.id); }}
        onOpenRecord={() => ctx.go(recordPathOf(c))}
      />
    );
  }
  const onKey = (key: string, on: { control: boolean }) => {
    if (key === 'Enter' && !on.control && !decided) {
      const run = common.onConfirm;
      if (run) run();
      return Boolean(run);
    }
    return false;
  };
  return (
    <KeyboardArea onKey={onKey} label={backLabel}>
      <ReviewScreen
        inbox={{ items: [], counts: { all: 0, overdue: 0 }, review }}
        {...common}
        onBack={() => ctx.go(back)}
        backLabel={backLabel}
        onOpenOriginals={() => { const d = mainDocument(c); if (d) openOriginal(ctx, c, d.id); }}
      />
    </KeyboardArea>
  );
}
