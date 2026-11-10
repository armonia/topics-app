/**
 * t02: sharing with an outside person. A share is a link with a scope, an
 * expiry, rights, a watermark and an access code; the list, the openings and
 * the revocation live in the slice `shares`, every change goes to the log
 * (kind `share`). Other places that offer «Condividi» can read the same slice.
 */
import type { ReactNode } from 'react';
import { addDays } from '../../../../ui/fixtures/org/clock';
import { GUEST_KINDS, SEED_SHARES, SHAREABLE_VIEWS, type ShareOpen, type ShareSeed } from '../../../../ui/fixtures/team';
import { SharesPage, ShareButton } from '../../../../ui/team/SharesPage';
import type { ShareActions, ShareDetailModel, ShareDraft, ShareFilter, ShareRowModel } from '../../../../ui/team/model';
import type { Tone } from '../../../../ui/types';
import type { ScreenCtx, ScreenDef } from '../../kit';
import { P } from '../../paths';
import { orgCases } from '../../store/cases';
import { settingsFrame } from '../settings-frame';
import { dayOf, formatDay, secondsOf, whenLabel, personName } from './format';

export type ShareState = Omit<ShareSeed, 'revoked'> & { revoked?: boolean; receipt?: string[] };

export interface SharesSlice {
  items: ShareState[];
}

export const SHARES_INITIAL: SharesSlice = { items: SEED_SHARES };

type Status = 'active' | 'expired' | 'revoked';

const statusOf = (s: ShareState, today: string): Status => (s.revoked ? 'revoked' : s.until < today ? 'expired' : 'active');
const TONE: Record<Status, Tone> = { active: 'green', expired: 'amber', revoked: 'neutral' };

/** A short code from what is shared and with whom: the same input gives the same code. */
function codeOf(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}

export function sharesScreen(_p: Record<string, string>, ctx: ScreenCtx): ReactNode {
  const s = ctx.copy.team.shares;
  const [shares, setShares] = ctx.slice<SharesSlice>('shares', SHARES_INITIAL);
  const [filter, setFilter] = ctx.ui<ShareFilter>('team.shares.filter', 'active');
  const [query, setQuery] = ctx.ui<string>('team.shares.query', '');
  const [sel, setSel] = ctx.ui<string>('team.shares.sel', '');
  const today = dayOf(ctx.now);
  const canShare = ctx.can('edit:data');
  const denied = ctx.deniedTitle('edit:data');

  const caseOptions = orgCases(ctx.state, 'nocera').map((c) => ({ value: c.id, label: `${c.id} · ${c.title}` }));
  const viewOptions = SHAREABLE_VIEWS.map((v) => ({ value: v.id, label: v.label }));
  const guestOptions = GUEST_KINDS.map((g) => ({ value: g.id, label: g.label }));

  const patch = (id: string, fn: (x: ShareState) => ShareState) => setShares((prev) => ({ items: prev.items.map((x) => (x.id === id ? fn(x) : x)) }));
  const scopePath = (x: ShareState) => (x.scope.kind === 'record' ? P.record(x.scope.id) : P.views());
  const label = (x: ShareState) => `${x.scope.kind === 'record' ? `${x.scope.id} ` : ''}${x.scope.label}`;
  const guestLine = (x: ShareState) => x.to.label;

  const create = (d: ShareDraft) => {
    const isRecord = d.scopeKind === 'record';
    const target = isRecord
      ? caseOptions.find((c) => c.value === d.target)
      : viewOptions.find((v) => v.value === d.target);
    const scopeLabel = isRecord ? (orgCases(ctx.state, 'nocera').find((c) => c.id === d.target)?.title ?? d.target) : (target?.label ?? d.target);
    const guest = GUEST_KINDS.find((g) => g.id === d.guest)?.label ?? '';
    const id = `sh-${shares.items.length + 1}`;
    const code = codeOf(`${d.target}${d.email}${d.until}`);
    const title = isRecord ? `${d.target} ${scopeLabel}` : scopeLabel;
    ctx.startJob({
      id: `share:${id}`,
      title: s.job.title(title),
      steps: [
        { label: s.job.steps.link, ms: 600 },
        { label: s.job.steps.code, ms: 500 },
        { label: s.job.steps.mail, ms: 800 },
      ],
      onDone: () => {
        const item: ShareState = {
          id,
          scope: { kind: d.scopeKind, id: d.target, label: scopeLabel },
          to: { email: d.email, label: guest ? `${d.email} (${guest})` : d.email },
          can: d.can,
          until: d.until,
          watermark: d.watermark,
          includes: d.includes,
          createdAt: ctx.now,
          by: ctx.persona.id,
          code,
          opens: [],
          receipt: s.receipt.lines(d.email, formatDay(d.until)),
        };
        setShares((prev) => ({ items: [item, ...prev.items] }));
        setFilter('active');
        setSel(id);
        ctx.log(s.log.created(title, d.email), 'share', P.settings('condivisioni'));
        ctx.notify({ title: s.notifyTitle, body: s.notifyBody(title, d.email), path: P.settings('condivisioni'), tone: 'info', to: ['direzione', 'attilio'].filter((p) => p !== ctx.persona.id) });
        ctx.toast({ tone: 'ok', title: s.created, body: s.createdBody(d.email), action: { label: ctx.copy.team.common.open, path: P.settings('condivisioni') } });
      },
    });
  };

  /* The list. */
  const q = query.trim().toLowerCase();
  const all = shares.items;
  const counts: Record<ShareFilter, number> = {
    active: all.filter((x) => statusOf(x, today) === 'active').length,
    expired: all.filter((x) => statusOf(x, today) === 'expired').length,
    revoked: all.filter((x) => statusOf(x, today) === 'revoked').length,
    all: all.length,
  };
  const visible = all
    .filter((x) => filter === 'all' || statusOf(x, today) === filter)
    .filter((x) => q === '' || `${label(x)} ${x.to.email} ${x.to.label}`.toLowerCase().includes(q));
  const selected = visible.find((x) => x.id === sel) ?? visible[0];
  const rows: ShareRowModel[] = visible.map((x) => {
    const st = statusOf(x, today);
    return {
      id: x.id,
      what: label(x),
      kind: s.scopeKind[x.scope.kind],
      who: guestLine(x),
      email: x.to.email,
      can: s.can[x.can],
      until: formatDay(x.until),
      opens: x.opens.length ? s.opensCount(x.opens.length) : s.neverOpened,
      state: { tone: TONE[st], text: s.state[st] },
      selected: x.id === selected?.id,
      onSelect: () => setSel(x.id),
    };
  });

  /* The detail. */
  const detail: ShareDetailModel | undefined = selected && (() => {
    const x = selected;
    const st = statusOf(x, today);
    return {
      id: x.id,
      what: label(x),
      kind: s.scopeKind[x.scope.kind],
      state: { tone: TONE[st], text: s.state[st] },
      active: st === 'active',
      editable: st === 'active' && canShare,
      link: `${s.linkBase}${x.code}`,
      code: x.code,
      to: x.to.label,
      email: x.to.email,
      can: x.can,
      until: x.until,
      base: x.scope.kind === 'record' ? s.includes.record : undefined,
      includes: [
        { id: 'contributor', label: s.includes.contributor, on: x.includes.contributor },
        { id: 'sameContributor', label: s.includes.sameContributor, on: x.includes.sameContributor },
        { id: 'assistant', label: s.includes.assistant, on: x.includes.assistant },
      ],
      watermark: x.watermark,
      opens: [...x.opens].reverse().map((o: ShareOpen, i) => ({ id: `${x.id}-o-${i}`, at: whenLabel(ctx.copy.team, o.at, ctx.now), who: o.who })),
      createdBy: s.detail.createdBy(personName(x.by), whenLabel(ctx.copy.team, x.createdAt, ctx.now)),
      receipt: x.receipt ? { title: s.receipt.title, lines: x.receipt } : undefined,
    };
  })();

  const changed = (x: ShareState) => ctx.log(s.log.changed(label(x)), 'share', P.settings('condivisioni'));
  const actions: ShareActions | undefined = selected && (() => {
    const x = selected;
    return {
      onCopy: () => {
        try {
          void navigator.clipboard?.writeText(`https://${s.linkBase}${x.code}`);
        } catch {
          /* The clipboard may be refused; the toast still tells what the link is. */
        }
        ctx.toast({ tone: 'ok', title: s.detail.copied, body: s.detail.copiedBody });
      },
      onTry: () => {
        const open: ShareOpen = { at: ctx.now, who: x.to.email };
        patch(x.id, (v) => ({ ...v, opens: [...v.opens, open] }));
        ctx.log(s.log.opened(label(x), x.to.email), 'share', P.settings('condivisioni'));
        ctx.toast({ tone: 'info', title: s.detail.tryLinkToast(x.to.email), body: secondsOf(ctx.now) });
      },
      onOpenScope: () => ctx.go(scopePath(x)),
      onRevoke: ctx.allow('edit:data', () => {
        ctx.confirm({
          title: s.revokeTitle,
          body: s.revokeBody(x.to.label),
          confirmLabel: s.revokeConfirm,
          tone: 'danger',
          onConfirm: () => {
            patch(x.id, (v) => ({ ...v, revoked: true }));
            ctx.log(s.log.revoked(label(x), x.to.email), 'share', P.settings('condivisioni'));
            ctx.toast({ tone: 'info', title: s.revokedToast });
          },
        });
      }),
      onCan: (v) => {
        if (!canShare) return;
        patch(x.id, (y) => ({ ...y, can: v }));
        changed(x);
      },
      onUntil: (v) => {
        if (!canShare) return;
        patch(x.id, (y) => ({ ...y, until: v }));
        changed(x);
      },
      onInclude: (id, next) => {
        if (!canShare) return;
        patch(x.id, (y) => ({ ...y, includes: { ...y.includes, [id]: next } }));
        changed(x);
      },
      onWatermark: (next) => {
        if (!canShare) return;
        patch(x.id, (y) => ({ ...y, watermark: next }));
        changed(x);
      },
    };
  })();

  const control = (
    <ShareButton
      copy={ctx.copy}
      cases={caseOptions}
      views={viewOptions}
      guests={guestOptions}
      defaultUntil={addDays(today, 30)}
      today={today}
      allowed={canShare}
      deniedTitle={denied}
      onCreate={create}
    />
  );

  return settingsFrame(ctx, 'condivisioni', {
    actions: control,
    children: (
      <SharesPage
        copy={ctx.copy}
        rows={rows}
        detail={detail}
        actions={actions ?? NO_ACTIONS}
        filter={filter}
        onFilter={setFilter}
        counts={counts}
        query={query}
        onQuery={setQuery}
        today={today}
        intro={s.intro}
      />
    ),
  });
}

const NO_ACTIONS: ShareActions = {
  onCopy: () => undefined, onTry: () => undefined, onOpenScope: () => undefined, onRevoke: false,
  onCan: () => undefined, onUntil: () => undefined, onInclude: () => undefined, onWatermark: () => undefined,
};

export const SHARES_SCREEN: ScreenDef = {
  id: 't02',
  path: '/impostazioni/condivisioni',
  org: 'nocera',
  nav: 'settings',
  needs: 'view:settings',
  samples: [P.settings('condivisioni')],
  title: (_p, ctx) => ctx.copy.app.settingsSections.condivisioni,
  render: sharesScreen,
};
