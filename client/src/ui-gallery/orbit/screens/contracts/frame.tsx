/**
 * The chrome every page of one contract shares: the bar with the way back and
 * the crumbs, the strip of the sections of «Conoscenza», the head (kind,
 * state, facts, family, alerts) with its two controls (compare the open
 * version with the last signed one, draft a new variation: the interview) and
 * the strip with the seven pages of the contract, each at its own address,
 * the current one marked. The page's own content goes under it.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { FileSearch, FileSignature, GitCompareArrows, Library, Link, ListChecks, MessageSquare, Paperclip, Sparkles } from 'lucide-react';
import type { Contract } from '../../../../ui/fixtures/orbit-org/types';
import { personaById, world } from '../../world';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { BackButton, PaneHeader } from '../../../../ui/shell/PaneHeader';
import { SubNav } from '../../../../ui/shell/SubNav';
import { ContractHeader } from '../../../../ui/contracts/ContractHeader';
import { VariantDialog } from '../../../../ui/contracts/VariantDialog';
import type { FactModel, FamilyNodeModel } from '../../../../ui/contracts/model';
import type { ScreenCtx } from '../../../app/kit';
import { liveCards, liveContractById } from '../../model/live';
import { KnowledgeNav } from '../knowledge/KnowledgeNav';
import { contractAlerts, currentValue, currentVersion, formatMoney, formatShare, kindLabel, noticeDate, statusLabel } from '../../model/contracts';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { draftVariant, moneyOf, relDay, shareFor } from './actions';
import { cardsOf, childrenOf, defaultPair, isPublic, longDay, parentOf, STATUS_TONE, valueClauseOf } from './model';
import { alertModels, attachmentsOf, today, variantDenied, variantStateText } from './view';
import { SECTION_STRIP } from '../../../../ui/shell/layout';

/** The nearest box above `el` that scrolls vertically, the page itself when none does. */
function scrollingBoxOf(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

/** The space kept above the strip of pages when a page opens on a phone, in pixels. */
const STRIP_MARGIN = 8;

/** The seven pages of a contract. */
export type ContractPage = 'text' | 'obligations' | 'comments' | 'versions' | 'attachments' | 'signatures' | 'links';

const PAGE_PATH: Record<ContractPage, (id: string) => string> = {
  text: SP.contract,
  obligations: SP.contractObligations,
  comments: SP.contractComments,
  versions: SP.versions,
  attachments: SP.contractAttachments,
  signatures: SP.signatures,
  links: SP.contractLinks,
};

function facts(ctx: ScreenCtx, c: Contract): FactModel[] {
  const t = ctx.copy.contracts;
  const f = t.page.facts;
  const v = currentVersion(c);
  const notice = noticeDate(c);
  const owner = personaById(c.owner);
  const changed = currentValue(c) !== c.value;
  return [
    { label: f.counterparty, value: c.counterparty, detail: c.counterparty.startsWith(c.counterpartyKind) ? undefined : c.counterpartyKind },
    {
      label: f.value,
      value: moneyOf(ctx, c, v.n),
      detail: changed ? f.valueChanged(t.common.version(v.n)) : c.valuePeriod === 'anno' ? t.common.perYear : t.common.vatExcluded, // allow-italian: data code compared by value
    },
    { label: f.start, value: longDay(c.start) },
    { label: f.end, value: c.end ? longDay(c.end) : t.list.noEnd, detail: c.end ? relDay(ctx, c.end, today(ctx)) : undefined },
    {
      label: f.notice,
      value: notice ? longDay(notice) : t.list.noNotice,
      detail: c.renewal.kind === 'tacito' ? t.list.renewal.tacit(c.renewal.months) : c.renewal.kind === 'opzione' ? t.list.renewal.option(c.renewal.months) : undefined, // allow-italian: data codes compared by value
    },
    { label: f.cig, value: c.cig ?? f.noCig, mono: Boolean(c.cig) },
    { label: f.owner, value: owner?.name ?? c.owner, detail: world().people.areaLabel[c.area] },
  ];
}

/** The compare that shows a variation: the last signed version before it against it. */
function variantCompare(c: Contract, n: number): string {
  const before = c.versions.filter((x) => x.n < n && x.signed).reduce((a, b) => (b.n > a ? b.n : a), 0) || n - 1;
  return SP.compare(c.id, before, n);
}

function family(ctx: ScreenCtx, c: Contract): FamilyNodeModel[] {
  const r = ctx.copy.contracts.common.relations;
  const nodeOf = (id: string, relation: string): FamilyNodeModel | undefined => {
    const x = liveContractById(ctx.state, id);
    return x && { id, relation, title: x.title, statusText: statusLabel[x.status], statusTone: STATUS_TONE[x.status] };
  };
  const out: FamilyNodeModel[] = [];
  const parent = parentOf(c.id);
  if (parent) {
    const node = nodeOf(parent.parent, r.parent);
    if (node) out.push(node);
  }
  out.push({ id: c.id, relation: r.self, title: c.title, statusText: statusLabel[c.status], statusTone: STATUS_TONE[c.status], current: true });
  for (const v of c.variants) {
    /* A variation opens the compare that shows it; on that compare it is the place itself, not a link. */
    const here = ctx.path === variantCompare(c, v.version);
    out.push({ id: `variant:${v.version}`, current: here || undefined, relation: r.variant(ctx.copy.contracts.common.version(v.version)), title: v.title, statusText: variantStateText(ctx, v.status), statusTone: v.status === 'in-corso' ? 'amber' : v.status === 'respinta' ? 'red' : 'green' }); // allow-italian: data codes compared by value
  }
  for (const child of childrenOf(c.id)) {
    const parentClause = currentVersion(c).clauses.find((x) => x.id === child.clause)?.n ?? '';
    const relation = child.relation === 'subcontract' ? r.subcontract(ctx.copy.contracts.common.clause(parentClause)) : child.relation === 'staff' ? r.staff : r.agreement;
    const node = nodeOf(child.child, relation);
    if (node) out.push(node);
  }
  return out;
}

export function NotFound({ ctx }: { ctx: ScreenCtx }) {
  const t = ctx.copy.contracts.page;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={orgCrumbs(ctx, [{ label: ctx.copy.orbitData.knowledge.title, to: SP.knowledge() }, { label: ctx.copy.contracts.title }])} />
      <KnowledgeNav ctx={ctx} active="contracts" />
      <EmptyState icon={FileSearch} title={t.notFoundTitle} action={<Button variant="primary" onClick={() => ctx.go(SP.contracts())}>{t.back}</Button>}>{t.notFoundBody}</EmptyState>
    </div>
  );
}

/** The interview of a new variation, open while `contracts.variant` names this contract. */
function VariantInterview({ ctx, c, onClose }: { ctx: ScreenCtx; c: Contract; onClose: () => void }) {
  const t = ctx.copy.contracts;
  const v = currentVersion(c);
  const money = (n: number) => t.common.euro(formatMoney(n));
  return (
    <VariantDialog
      title={t.variant.title(c.title)}
      clauses={v.clauses.map((x) => ({ id: x.id, label: t.page.clauseHeading(x.n, x.title) }))}
      valueClause={valueClauseOf(v)?.id}
      currentValue={currentValue(c)}
      valueText={money}
      shareOf={(value) => formatShare(shareFor(c, value))}
      threshold={(value) => {
        if (!isPublic(c)) return undefined;
        const over = Math.abs(shareFor(c, value)) >= 10;
        return { text: over ? t.compare.threshold.over : t.compare.threshold.under, tone: over ? 'red' : 'green' };
      }}
      onClose={onClose}
      onSubmit={(answers) => {
        onClose();
        draftVariant(ctx, c, answers);
      }}
      copy={ctx.copy}
    />
  );
}

export function ContractFrame({ ctx, c, crumb, page, children }: {
  ctx: ScreenCtx;
  c: Contract;
  /** The sub-place after the contract in the crumbs: «Confronto», «Firme e approvazioni». (allow-italian: quotes the Italian interface) */
  crumb?: string;
  /** Which page of the contract this is: the entry of the strip that is marked. */
  page: ContractPage;
  children: ReactNode;
}) {
  const t = ctx.copy.contracts;
  const [variantFor, setVariantFor] = ctx.ui<string>('contracts.variant', '');
  const scroller = useRef<HTMLDivElement>(null);
  const stripBox = useRef<HTMLDivElement>(null);
  /*
   * Where a page of the contract opens. The base page starts at the top, with
   * the title in view. Any other page, on a phone, starts with the strip of
   * pages at the top of the screen: the head (facts, family, alerts) is taller
   * than the screen there, and a page opened below it would show nothing of
   * itself. Set on every open of a page.
   */
  const phone = ctx.phone;
  useLayoutEffect(() => {
    // The box that really scrolls: this one on a desktop, the phone's shell around it on a phone, where this box grows with its content.
    const box = scrollingBoxOf(stripBox.current) ?? scroller.current;
    const bar = stripBox.current;
    if (!box || !bar) return;
    box.scrollTop = phone && page !== 'text' ? Math.max(0, bar.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - STRIP_MARGIN) : 0;
  }, [c.id, page, phone]);
  const pair = defaultPair(c);
  const denied = variantDenied(ctx, c);
  // On the compare itself the button stays, disabled: the head keeps the same size on every page of the contract.
  const onPair = Boolean(pair && ctx.path === SP.compare(c.id, pair.from, pair.to));
  const head = (
    <>
      <Button
        icon={GitCompareArrows}
        onClick={pair && !onPair ? () => ctx.go(SP.compare(c.id, pair.from, pair.to)) : false}
        title={!pair ? t.page.actions.compareNoneTitle : onPair ? t.page.actions.compareHereTitle : undefined}
      >
        {pair ? t.page.actions.compare(pair.from, pair.to) : t.page.actions.compareNone}
      </Button>
      <Button variant="primary" icon={Sparkles} onClick={denied ? false : () => setVariantFor(c.id)} title={denied}>{t.page.actions.newVariant}</Button>
      {/* the reason stays on show on a screen with a mouse; on a touch screen the Button writes it under itself (`title`), so this one steps aside. `w-0 min-w-full` lets it wrap under the buttons without widening them */}
      {denied && <span className="w-0 min-w-full text-mini leading-4 text-app-text-tertiary coarse:hidden">{denied}</span>}
    </>
  );
  const alerts = alertModels(ctx, c);
  const tabs = t.side.tabs;
  const links = c.links.flows.length + cardsOf(c, liveCards(ctx.state)).length;
  const strip: Array<[ContractPage, string, typeof Library, number | undefined]> = [
    ['text', tabs.text, Library, undefined],
    ['obligations', tabs.obligations, ListChecks, c.obligations.filter((o) => !o.done).length],
    ['comments', tabs.comments, MessageSquare, c.comments.filter((x) => !x.resolved).length],
    ['versions', tabs.versions, GitCompareArrows, c.versions.length],
    ['attachments', tabs.attachments, Paperclip, attachmentsOf(ctx, c).length],
    ['signatures', tabs.signatures, FileSignature, c.approvals.filter((x) => x.state !== 'fatto').length], // allow-italian: data code compared by value
    ['links', tabs.links, Link, links],
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        leading={<BackButton label={t.title} onClick={() => ctx.go(SP.contracts())} copy={ctx.copy} />}
        crumbs={orgCrumbs(ctx, [{ label: ctx.copy.orbitData.knowledge.title, to: SP.knowledge() }, { label: t.title, to: SP.contracts() }, ...(crumb ? [{ label: c.title, to: SP.contract(c.id) }, { label: crumb }] : [{ label: c.title }])])}
      />
      <KnowledgeNav ctx={ctx} active="contracts" />
      <div ref={scroller} data-contract-scroll="true" className="min-h-0 flex-1 overflow-y-auto">
        <ContractHeader
          title={c.title}
          kindText={kindLabel[c.kind]}
          statusText={statusLabel[c.status]}
          statusTone={STATUS_TONE[c.status]}
          facts={facts(ctx, c)}
          family={family(ctx, c)}
          onFamily={(id) => {
            if (id.startsWith('variant:')) ctx.go(variantCompare(c, Number(id.slice(8))));
            else ctx.go(SP.contract(id));
          }}
          alerts={alerts}
          onAlert={(id) => {
            const a = contractAlerts(c, today(ctx), liveCards(ctx.state)).find((x) => x.id === id);
            if (a?.clause) ctx.go(SP.clause(c.id, a.clause));
          }}
          actions={head}
          copy={ctx.copy}
          phone={ctx.phone}
        />
        <div ref={stripBox} className={SECTION_STRIP}>
          <SubNav
            label={t.page.pagesLabel}
            items={strip.map(([id, label, icon, count]) => ({ id, label, icon, count, active: id === page }))}
            onSelect={(id) => ctx.go(PAGE_PATH[id as ContractPage](c.id))}
          />
        </div>
        {children}
      </div>
      {variantFor === c.id && <VariantInterview ctx={ctx} c={c} onClose={() => setVariantFor('')} />}
    </div>
  );
}
