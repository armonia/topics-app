/**
 * The gallery page `kit` (`ui.html#kit`): every shared control of the UI layer
 * in its states, filled from `copy.kit.demo`. The page is the harness, so it
 * owns the state the controls report to (values, open overlays, the page of
 * the viewer). Overlays sit in stages that carry a transform: a `fixed`
 * surface takes its stage as its frame, so all of them show at once.
 */
import { useState, type ReactNode } from 'react';
import {
  Archive, CalendarDays, CircleAlert, Copy, FileSpreadsheet, FileText, ListFilter, FolderOpen, Hash, Inbox, Mail, Menu as MenuGlyph,
  MoreHorizontal, Scale, Search, Sparkles, Trash2, User, Workflow, Clock, LayoutList, type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../ui/copy/types';
import type { Tone } from '../ui/types';
import { Button, IconButton } from '../ui/primitives/Button';
import { Chip } from '../ui/primitives/Chip';
import { SectionLabel } from '../ui/primitives/Panel';
import { Checkbox, Select, TextArea, TextField, Toggle } from '../ui/primitives/Field';
import { Tabs } from '../ui/primitives/Tabs';
import { ProgressBar, Spinner } from '../ui/primitives/Progress';
import { ErrorState, LoadingState, Skeleton } from '../ui/primitives/States';
import { Timeline } from '../ui/primitives/Timeline';
import { Table } from '../ui/primitives/Table';
import { Card, StatCard } from '../ui/primitives/Card';
import { ConfirmDialog, Dialog } from '../ui/primitives/Dialog';
import { Menu, MenuButton, type MenuItemModel } from '../ui/primitives/Menu';
import { ToastStack, type ToastModel } from '../ui/primitives/Toast';
import { Popover } from '../ui/primitives/Popover';
import { DocumentViewer } from '../ui/primitives/DocumentViewer';
import { Stepper, type StepState } from '../ui/primitives/Stepper';
import { CommandPalette } from '../ui/shell/CommandPalette';
import { SearchButton } from '../ui/shell/SearchButton';
import { NotificationsPanel } from '../ui/shell/NotificationsPanel';
import { PersonaMenu } from '../ui/shell/PersonaMenu';
import { PhoneShell } from '../ui/shell/PhoneShell';
import { NoAccess } from '../ui/shell/NoAccess';
import { Sidebar } from '../ui/shell/Sidebar';
import { adminSidebar } from '../ui/fixtures/shell';
import { FiltersDemo } from './KitFilters';

/* ---------- harness pieces ---------- */

function Section({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className={clsx('flex min-w-0 flex-col gap-3', wide && 'lg:col-span-2')}>
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  );
}

/** A bordered box on the inset ground, for a component that needs a frame. */
function Frame({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('flex min-w-0 flex-col overflow-hidden rounded-lg border border-app-border bg-surface', className)}>{children}</div>;
}

/**
 * A stage for an overlay. The transform makes it the containing block of
 * `position: fixed`, so a modal or a toast stack fills the stage instead of
 * the window. Closing the overlay leaves a way to open it again.
 */
function Stage({ copy, height = 400, children }: { copy: UiCopy; height?: number; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ height }} className="relative min-w-0 overflow-hidden rounded-lg border border-app-border bg-app-inset [transform:translateZ(0)]">
      {open ? children(() => setOpen(false)) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-prose text-app-text-tertiary">
          {copy.kit.demo.closed}
          <Button onClick={() => setOpen(true)}>{copy.kit.demo.reopen}</Button>
        </div>
      )}
    </div>
  );
}

/** A page of a made-up document: a title bar and grey lines, no words. */
function pageImage(n: number): string {
  const lines = Array.from({ length: 24 }, (_, i) => {
    const w = 455 - ((i * 37 + n * 23) % 140);
    return `<rect x="70" y="${130 + i * 27}" width="${w}" height="8" rx="2" fill="#c8cbd2"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="595" height="842" viewBox="0 0 595 842"><rect width="595" height="842" fill="#fff"/><rect x="70" y="70" width="${180 + (n % 3) * 40}" height="14" rx="3" fill="#8a8e98"/>${lines}<rect x="287" y="800" width="20" height="8" rx="2" fill="#a3a7b0"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
const PAGES = Array.from({ length: 6 }, (_, i) => pageImage(i + 1));

/* ---------- sections ---------- */

function FieldsDemo({ copy }: { copy: UiCopy }) {
  const d = copy.kit.demo.field;
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [taxCode, setTaxCode] = useState('RSSMRA80A01');
  const [date, setDate] = useState('2026-12-03');
  const [note, setNote] = useState('');
  const [office, setOffice] = useState('legal');
  const [officeSm, setOfficeSm] = useState('protocol');
  const options = [
    { value: 'protocol', label: d.offices[0] },
    { value: 'taxes', label: d.offices[1] },
    { value: 'legal', label: d.offices[2] },
  ];
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      <TextField label={d.name} value={name} onChange={setName} placeholder={d.namePlaceholder} hint={d.nameHint} />
      <TextField label={copy.kit.demo.sections.search} type="search" icon={Search} value={query} onChange={setQuery} placeholder={d.search} />
      <TextField label={d.taxCode} value={taxCode} onChange={setTaxCode} error={taxCode.length === 16 ? undefined : d.taxCodeError} />
      <TextField label={d.deadline} type="date" icon={CalendarDays} value={date} onChange={setDate} />
      <TextField label={d.locked} value={d.lockedValue} onChange={() => undefined} disabled title={d.lockedTitle} icon={Hash} />
      <div className="flex min-w-0 items-end gap-2">
        <Select label={d.office} value={office} options={options} onChange={setOffice} className="min-w-0 flex-1" />
        <Select size="sm" value={officeSm} options={options} onChange={setOfficeSm} title={d.office} className="w-32 pb-0.5" />
      </div>
      <TextArea label={d.note} value={note} onChange={setNote} placeholder={d.notePlaceholder} hint={d.noteHint} className="sm:col-span-2" />
    </div>
  );
}

function ChoicesDemo({ copy }: { copy: UiCopy }) {
  const d = copy.kit.demo.choice;
  const [email, setEmail] = useState(true);
  const [digest, setDigest] = useState(false);
  const [agree, setAgree] = useState(true);
  const [archived, setArchived] = useState(false);
  return (
    <Frame className="gap-3 px-4 py-3.5">
      <Toggle checked={email} onChange={setEmail} label={d.emailLabel} description={d.emailDescription} />
      <Toggle checked={digest} onChange={setDigest} label={d.digestLabel} description={d.digestDescription} />
      <Toggle checked onChange={() => undefined} label={d.signLabel} disabled title={d.signTitle} />
      <div className="flex flex-wrap gap-x-5 border-t border-app-border pt-2">
        <Checkbox checked={agree} onChange={setAgree} label={d.agree} />
        <Checkbox checked={archived} onChange={setArchived} label={d.archived} />
        <Checkbox checked={false} onChange={() => undefined} label={d.lockedBox} disabled title={d.signTitle} />
      </div>
    </Frame>
  );
}

function menuItems(copy: UiCopy): MenuItemModel[] {
  const d = copy.kit.demo.menu;
  return [
    { id: 'open', label: d.open, icon: FolderOpen, hint: '↵' },
    { id: 'duplicate', label: d.duplicate, icon: Copy, hint: '⌘D' },
    { id: 'export', label: d.export, icon: FileSpreadsheet },
    { id: 'sep', label: '', separator: true },
    { id: 'archive', label: d.archive, icon: Archive, danger: true },
    { id: 'delete', label: d.delete, icon: Trash2, disabled: true, title: d.deleteTitle },
  ];
}

function MenusDemo({ copy }: { copy: UiCopy }) {
  const d = copy.kit.demo.menu;
  const [picked, setPicked] = useState<string>();
  const items = menuItems(copy);
  return (
    <>
      <div className="flex min-h-7 flex-wrap items-center gap-2">
        <MenuButton label={d.actions} icon={LayoutList} items={items} onSelect={setPicked} />
        <MenuButton label={d.actions} items={items} onSelect={setPicked} variant="ghost" size="sm" />
        <MenuButton label={d.more} icon={MoreHorizontal} iconOnly items={items} onSelect={setPicked} variant="ghost" align="right" />
        <MenuButton label={d.actions} items={items} onSelect={setPicked} disabled title={d.deleteTitle} />
        {picked && <Chip tone="blue">{items.find((i) => i.id === picked)?.label}</Chip>}
      </div>
      <Stage copy={copy} height={236}>
        {(close) => <Menu items={items} onSelect={setPicked} onClose={close} x={16} y={16} ariaLabel={d.context} />}
      </Stage>
    </>
  );
}

function TabsDemo({ copy }: { copy: UiCopy }) {
  const d = copy.kit.demo.tabs;
  const [tab, setTab] = useState<'documents' | 'data' | 'history'>('documents');
  const [plain, setPlain] = useState<'documents' | 'data' | 'history'>('data');
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        ariaLabel={d.label}
        options={[
          { value: 'documents', label: d.documents, icon: FileText, count: 3 },
          { value: 'data', label: d.data, icon: Hash },
          { value: 'history', label: d.history, icon: Clock, count: 12 },
        ]}
      />
      <Tabs
        value={plain}
        onChange={setPlain}
        ariaLabel={d.label}
        options={[
          { value: 'documents', label: d.documents },
          { value: 'data', label: d.data },
          { value: 'history', label: d.history },
        ]}
      />
    </>
  );
}

function ProgressDemo({ copy }: { copy: UiCopy }) {
  const d = copy.kit.demo.progress;
  return (
    <Frame className="gap-4 px-4 py-4">
      <ProgressBar value={0.4} label={d.sending} detail={d.sendingDetail} />
      <ProgressBar value={1} tone="green" label={d.test} detail={d.testDetail} />
      <ProgressBar value={0.7} tone="amber" label={d.space} detail={d.spaceDetail} />
      <ProgressBar value={0.9} tone="red" label={d.overdue} detail={d.overdueDetail} />
      <div className="flex items-center gap-4 border-t border-app-border pt-3">
        <Spinner size={12} />
        <Spinner />
        <Spinner size={24} label={copy.kit.loading} />
      </div>
    </Frame>
  );
}

function StatesDemo({ copy }: { copy: UiCopy }) {
  const d = copy.kit.demo.states;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      <Frame className="gap-2.5 px-4 py-4">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="w-11/12" />
        <Skeleton className="w-4/5" />
        <Skeleton className="w-2/3" />
      </Frame>
      <Frame><LoadingState title={d.loading} lines={3} /></Frame>
      <Frame>
        <ErrorState title={d.errorTitle} body={d.errorBody} details={d.errorDetails} action={<Button variant="primary" onClick={() => undefined}>{d.retry}</Button>} />
      </Frame>
      <Frame>
        <NoAccess title={d.noAccessTitle} body={d.noAccessBody} action={<Button onClick={() => undefined}>{d.askAccess}</Button>} />
      </Frame>
    </div>
  );
}

const TIMELINE_LOOK: Array<{ icon: LucideIcon; tone: Tone }> = [
  { icon: Mail, tone: 'blue' },
  { icon: Sparkles, tone: 'pink' },
  { icon: User, tone: 'amber' },
  { icon: Hash, tone: 'green' },
  { icon: CircleAlert, tone: 'red' },
];

function TimelineDemo({ copy }: { copy: UiCopy }) {
  return (
    <Frame className="px-3 py-3">
      <Timeline
        ariaLabel={copy.kit.demo.sections.timeline}
        items={copy.kit.demo.timeline.map((e, i) => ({
          id: `t${i}`,
          ...e,
          ...TIMELINE_LOOK[i % TIMELINE_LOOK.length],
          onOpen: i === 0 || i === 3 ? () => undefined : undefined,
        }))}
      />
    </Frame>
  );
}

const STATUS_TONE: Tone[] = ['amber', 'blue', 'red', 'neutral'];

function TableDemo({ copy }: { copy: UiCopy }) {
  const d = copy.kit.demo.table;
  const [selected, setSelected] = useState('r1');
  const columns = [
    { id: 'record', label: d.columns.record },
    { id: 'person', label: d.columns.person, width: 170 },
    { id: 'status', label: d.columns.status, width: 140 },
    { id: 'due', label: d.columns.due, width: 96, align: 'right' as const },
  ];
  return (
    <>
      <Table
        ariaLabel={d.label}
        columns={columns}
        rows={d.rows.map((r, i) => ({
          id: `r${i}`,
          selected: selected === `r${i}`,
          muted: i === 3,
          onOpen: i === 3 ? undefined : () => setSelected(`r${i}`),
          cells: {
            record: <span className="font-medium">{r.record}</span>,
            person: r.person,
            status: <Chip tone={STATUS_TONE[i]}>{r.status}</Chip>,
            due: r.due,
          },
        }))}
      />
      <Table ariaLabel={d.label} dense columns={columns} rows={[]} empty={d.empty} />
    </>
  );
}

function CardsDemo({ copy }: { copy: UiCopy }) {
  const d = copy.kit.demo.cards;
  const stats: Tone[] = ['neutral', 'neutral', 'amber', 'red'];
  return (
    <>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Card title={d.deadlinesTitle} icon={CalendarDays} tone="amber" actions={<MenuButton label={copy.kit.demo.menu.more} icon={MoreHorizontal} iconOnly variant="ghost" size="sm" align="right" items={menuItems(copy)} onSelect={() => undefined} />}>
          {d.deadlinesBody}
        </Card>
        <Card title={d.flowTitle} icon={Workflow} onOpen={() => undefined}>{d.flowBody}</Card>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-3">
        {d.stats.map((s, i) => <StatCard key={s.label} label={s.label} value={s.value} detail={s.detail} tone={stats[i]} onOpen={i === 3 ? () => undefined : undefined} />)}
      </div>
    </>
  );
}

function StepperDemo({ copy }: { copy: UiCopy }) {
  const states: StepState[] = ['done', 'done', 'current', 'todo', 'todo'];
  const steps = copy.kit.demo.steps.map((s, i) => ({ id: `s${i}`, label: s.label, detail: s.detail, state: states[i] }));
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[220px_minmax(0,1fr)]">
      <Frame className="px-3 py-3"><Stepper steps={steps} copy={copy} /></Frame>
      <Frame className="justify-center px-4 py-4">
        <Stepper steps={steps} orientation="horizontal" copy={copy} onOpen={() => undefined} />
      </Frame>
    </div>
  );
}

function OverlaysDemo({ copy }: { copy: UiCopy }) {
  const d = copy.kit.demo.overlays;
  const tones: ToastModel['tone'][] = ['ok', 'info', 'warn', 'error'];
  const [toasts, setToasts] = useState<ToastModel[]>(() => d.toasts.map((t, i) => ({ id: `toast${i}`, tone: tones[i], title: t.title, body: t.body, actionLabel: t.action })));
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string>('p0-0');
  const [unread, setUnread] = useState([true, true, false]);
  const [persona, setPersona] = useState('pe0');
  const [popover, setPopover] = useState(true);
  const paletteIcons: LucideIcon[] = [FileText, Scale, Workflow];
  const q = query.trim().toLowerCase();
  const groups = d.paletteGroups.map((g, gi) => ({
    label: g.label,
    items: g.items
      .map((it, ii) => ({ id: `p${gi}-${ii}`, title: it.title, detail: it.detail, icon: paletteIcons[gi] }))
      .filter((it) => !q || `${it.title} ${it.detail}`.toLowerCase().includes(q)),
  }));
  const notificationTones: Array<'warn' | 'error' | 'ok'> = ['warn', 'error', 'ok'];
  const personaColors = ['#475569', '#15803d', '#0f766e'];
  const personaMonograms = ['AM', 'ME', 'DG'];
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
      <Stage copy={copy}>
        {(close) => (
          <Dialog
            title={d.dialogTitle}
            onClose={close}
            closeLabel={copy.common.close}
            footer={<><Button onClick={close}>{d.cancel}</Button><Button variant="primary" onClick={close}>{d.save}</Button></>}
          >
            <p className="mb-3">{d.dialogBody}</p>
            <TextField value={copy.kit.demo.tabs.documents} onChange={() => undefined} title={d.dialogTitle} />
          </Dialog>
        )}
      </Stage>
      <Stage copy={copy}>
        {(close) => (
          <ConfirmDialog title={d.confirmTitle} body={d.confirmBody} confirmLabel={d.confirmLabel} cancelLabel={d.cancel} tone="danger" onConfirm={close} onCancel={close} />
        )}
      </Stage>
      <Stage copy={copy} height={360}>
        {() => <ToastStack toasts={toasts} dismissLabel={d.dismiss} onDismiss={(id) => setToasts((all) => all.filter((t) => t.id !== id))} onAction={(id) => setToasts((all) => all.filter((t) => t.id !== id))} />}
      </Stage>
      <Stage copy={copy} height={320}>
        {() => (
          <div className="p-4">
            <span className="relative inline-flex">
              <Button icon={ListFilter} onClick={() => setPopover((v) => !v)}>{d.popover}</Button>
              {popover && (
                <Popover ariaLabel={d.popover} onClose={() => setPopover(false)} className="w-[280px] p-3.5">
                  <p className="mb-3 text-prose leading-5 text-app-text-secondary">{d.popoverBody}</p>
                  <Checkbox checked onChange={() => undefined} label={copy.kit.demo.choice.archived} />
                </Popover>
              )}
            </span>
          </div>
        )}
      </Stage>
      <Stage copy={copy} height={560}>
        {(close) => (
          <CommandPalette
            query={query}
            onQuery={setQuery}
            groups={groups}
            activeId={active}
            onActive={setActive}
            onOpen={close}
            onClose={close}
            placeholder={d.palette}
            empty={d.paletteEmpty}
            footer={d.paletteFooter}
            copy={copy}
          />
        )}
      </Stage>
      <Stage copy={copy} height={440}>
        {(close) => (
          <NotificationsPanel
            title={d.notifications}
            items={d.notificationItems.map((n, i) => ({ id: `n${i}`, ...n, tone: notificationTones[i], unread: unread[i] }))}
            onOpen={(id) => setUnread((u) => u.map((v, i) => (`n${i}` === id ? false : v)))}
            onMarkAllRead={() => setUnread([false, false, false])}
            markAllLabel={d.markAll}
            empty={d.noNotifications}
            unreadLabel={copy.kit.notifications.unread}
            onClose={close}
          />
        )}
      </Stage>
      <Stage copy={copy} height={300}>
        {(close) => (
          <PersonaMenu
            title={d.personas}
            personas={d.personaItems.map((p, i) => ({ id: `pe${i}`, ...p, monogram: personaMonograms[i], color: personaColors[i], current: persona === `pe${i}`, example: i > 0 }))}
            onSelect={setPersona}
            onClose={close}
            exampleLabel={d.example}
            currentLabel={d.current}
          />
        )}
      </Stage>
      <Stage copy={copy} height={300}>
        {(close) => (
          <NotificationsPanel title={d.notifications} items={[]} onOpen={() => undefined} markAllLabel={d.markAll} empty={d.noNotifications} onClose={close} />
        )}
      </Stage>
    </div>
  );
}

function ViewerDemo({ copy, phone }: { copy: UiCopy; phone?: boolean }) {
  const d = copy.kit.demo.viewer;
  const [page, setPage] = useState(3);
  const [zoom, setZoom] = useState(1);
  return (
    <Frame className={phone ? 'h-[760px]' : 'h-[620px]'}>
      <DocumentViewer
        name={d.name}
        detail={d.detail}
        pages={PAGES}
        page={page}
        onPage={setPage}
        zoom={zoom}
        onZoom={setZoom}
        pdfHref={PAGES[0]}
        quote={{ text: d.quote, page: 3 }}
        copy={copy}
        phone={phone}
        aside={(
          <div className="px-4 py-4">
            <SectionLabel className="mb-2">{d.summary}</SectionLabel>
            <p className="text-prose leading-6 text-app-text-secondary">{d.summaryBody}</p>
          </div>
        )}
      />
    </Frame>
  );
}

function PhoneDemo({ copy }: { copy: UiCopy }) {
  const d = copy.kit.demo;
  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState('ph0');
  const icons: LucideIcon[] = [Inbox, FileText, Search, MenuGlyph];
  return (
    <div className="flex min-w-0 flex-wrap gap-4">
      <div className="h-[700px] w-[390px] max-w-full overflow-hidden rounded-[28px] border border-app-border shadow-lg [transform:translateZ(0)]">
        <PhoneShell
          title={d.phone.title}
          leading={<IconButton icon={MenuGlyph} label={copy.kit.phone.menu} onClick={() => setDrawer(true)} className="bg-transparent" />}
          actions={<SearchButton compact label={d.search.label} shortcut={d.search.shortcut} onClick={() => undefined} />}
          nav={d.phone.nav.map((label, i) => ({ id: `ph${i}`, label, icon: icons[i], active: tab === `ph${i}`, count: i === 0 ? 5 : undefined }))}
          onNav={setTab}
          navLabel={copy.kit.phone.nav}
          drawerLabel={copy.shell.appName}
          drawer={drawer ? <Sidebar model={adminSidebar('nav-flows')} copy={copy} onSelect={() => setDrawer(false)} /> : undefined}
          onCloseDrawer={() => setDrawer(false)}
        >
          <div className="flex flex-col gap-3 p-3">
            <p className="text-mini text-app-text-tertiary">{d.phone.body}</p>
            {d.table.rows.map((r, i) => (
              <Card key={r.record} title={r.record} icon={FileText} tone={STATUS_TONE[i]} onOpen={() => undefined}>
                {r.person} · {r.due}
              </Card>
            ))}
            <StatCard label={d.cards.stats[0].label} value={d.cards.stats[0].value} detail={d.cards.stats[0].detail} />
          </div>
        </PhoneShell>
      </div>
      <div className="h-[700px] w-[390px] max-w-full overflow-hidden rounded-[28px] border border-app-border shadow-lg [transform:translateZ(0)]">
        <PhoneShell
          title={d.phone.title}
          leading={<IconButton icon={MenuGlyph} label={copy.kit.phone.menu} onClick={() => undefined} className="bg-transparent" />}
          nav={d.phone.nav.map((label, i) => ({ id: `pd${i}`, label, icon: icons[i], active: i === 0 }))}
          onNav={() => undefined}
          navLabel={copy.kit.phone.nav}
          drawerLabel={copy.shell.appName}
          drawer={<Sidebar model={adminSidebar('nav-flows')} copy={copy} />}
          onCloseDrawer={() => undefined}
        >
          <div className="p-3"><Skeleton className="h-24 w-full" /></div>
        </PhoneShell>
      </div>
    </div>
  );
}

function SearchDemo({ copy }: { copy: UiCopy }) {
  const d = copy.kit.demo.search;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-app-chrome px-3 py-2">
      <SearchButton label={d.label} shortcut={d.shortcut} onClick={() => undefined} />
      <SearchButton compact label={d.label} shortcut={d.shortcut} onClick={() => undefined} />
    </div>
  );
}

/* ---------- page ---------- */

export function KitPage({ copy }: { copy: UiCopy }) {
  const d = copy.kit.demo;
  const s = d.sections;
  return (
    <div data-kit-scroll="true" className="h-full max-h-[100dvh] w-full max-w-[100vw] overflow-y-auto bg-surface font-sans text-prose text-app-text antialiased">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-9 px-4 py-6 sm:px-8 sm:py-8">
        <header>
          <h1 className="text-headline font-semibold tracking-[-0.01em] text-app-text">{d.title}</h1>
          <p className="mt-1 text-prose text-app-text-secondary">{d.lead}</p>
        </header>
        <div className="grid min-w-0 grid-cols-1 gap-x-10 gap-y-9 lg:grid-cols-2">
          <Section title={s.fields}><FieldsDemo copy={copy} /></Section>
          <Section title={s.choices}><ChoicesDemo copy={copy} /></Section>
          <Section title={s.menus}><MenusDemo copy={copy} /></Section>
          <Section title={s.tabs}><TabsDemo copy={copy} /><SectionLabel className="mt-3">{s.search}</SectionLabel><SearchDemo copy={copy} /></Section>
          <Section title={copy.filters.demo.title} wide><FiltersDemo copy={copy} /></Section>
          <Section title={s.progress}><ProgressDemo copy={copy} /></Section>
          <Section title={s.timeline}><TimelineDemo copy={copy} /></Section>
          <Section title={s.states} wide><StatesDemo copy={copy} /></Section>
          <Section title={s.table}><TableDemo copy={copy} /></Section>
          <Section title={s.cards}><CardsDemo copy={copy} /></Section>
          <Section title={s.stepper} wide><StepperDemo copy={copy} /></Section>
          <Section title={s.overlays} wide><OverlaysDemo copy={copy} /></Section>
          <Section title={s.viewer} wide><ViewerDemo copy={copy} /></Section>
          <Section title={s.phone} wide><PhoneDemo copy={copy} /></Section>
        </div>
      </div>
    </div>
  );
}
