/**
 * One contract. The text of the version on show is at the left, with numbered
 * clauses; the page is chosen in the strip under the head, and each one has
 * its own address: the text (`/conoscenza/contratti/:id`, one clause on it
 * `/clausola/:clause`), the obligations (`/obblighi`), the comments
 * (`/commenti`), the versions (`/versioni`) with the switch to compare two, (allow-italian: address segments)
 * the attachments (`/allegati`) and the links to flows and cards
 * (`/collegamenti`); the signatures are their own page (`SignaturesPlace`).
 * Beside the text sits the panel of the page; the text page has none, unless
 * a clause is on show: then the panel holds what is attached to that clause. An
 * obligation lights its exact words in the clause beside it: the original is
 * always in view.
 */
import type { ReactNode } from 'react';
import { CircleAlert, FileText, MessageSquare } from 'lucide-react';
import clsx from 'clsx';
import type { Contract } from '../../../../ui/fixtures/sarim-org/types';
import { personaById, world } from '../../world';
import { Button } from '../../../../ui/primitives/Button';
import { Select, TextArea } from '../../../../ui/primitives/Field';
import { SectionLabel } from '../../../../ui/primitives/Panel';
import { ContractText, VersionPicker } from '../../../../ui/contracts/ContractText';
import { AttachmentList, CommentList, LinkList, ObligationList, VersionList } from '../../../../ui/contracts/SidePanels';
import type { AttachmentModel, ClauseBlockModel, CommentModel, LinkModel, ObligationModel, VersionModel } from '../../../../ui/contracts/model';
import type { Tone } from '../../../../ui/types';
import type { ScreenCtx } from '../../../app/kit';
import { contractsSlice, liveCards, liveContractById, stageOf } from '../../model/live';
import { currentVersion, dayLabel, formatMoney, formatShare, kindLabel, latestVersion, variantShare, versionOf } from '../../model/contracts';
import { flowIcon, flowLabel } from '../../model/flows';
import { SP } from '../../paths';
import { addComment, closeObligation, relDay, replyComment, resolveComment } from './actions';
import { ContractFrame, NotFound } from './frame';
import { attachmentKind, attachmentsOf, obligationKind, today } from './view';
import { actorOf, cardsOf, clauseText, defaultPair, isReadOnly, lastChange, stamp, teamLabelOf, underApproval } from './model';

/** The pages that draw the text with a panel beside it. */
export type ContractMode = 'text' | 'obligations' | 'comments' | 'versions' | 'attachments' | 'links';

const STAGE_TONE: Record<string, Tone> = { arrivo: 'neutral', lavorazione: 'blue', verifica: 'amber', approvazione: 'violet', fatto: 'green' }; // allow-italian: stage ids mapped to tones

function obligationModels(ctx: ScreenCtx, c: Contract, shown: number, focus: string, onlyClause?: string): ObligationModel[] {
  const t = ctx.copy.contracts;
  const s = t.side.obligations;
  const day = today(ctx);
  const done = contractsSlice(ctx.state).obligationsDone;
  const cards = liveCards(ctx.state);
  return c.obligations
    .filter((o) => !onlyClause || o.clause === onlyClause)
    .map((o): ObligationModel => {
      const k = obligationKind(ctx, o.kind);
      const n = versionOf(c, shown)?.clauses.find((x) => x.id === o.clause)?.n ?? o.clause.replace('art-', '');
      const late = !o.done && o.due && o.due < day;
      const soon = !o.done && o.due && !late && Math.round((Date.parse(o.due) - Date.parse(day)) / 86_400_000) <= 30;
      const proof = done[o.id];
      const card = cards.find((x) => x.links?.contract === c.id && x.links.clause === o.clause && stageOf(x) !== 'fatto'); // allow-italian: stage id compared by value
      const text = clauseText(c, shown, o.clause);
      return {
        id: o.id,
        what: o.what,
        clauseLabel: t.common.clause(n),
        kindText: k.text,
        kindTone: k.tone,
        owner: actorOf(o.owner),
        whenText: o.due ? s.due(dayLabel(o.due, day), relDay(ctx, o.due, day)) : o.every ?? s.noDate,
        whenTone: late ? 'red' : soon ? 'amber' : undefined,
        every: o.due ? o.every : undefined,
        done: Boolean(o.done),
        proof: proof ? s.doneBy(personaById(proof.by)?.name ?? proof.by, stamp(proof.at), proof.proof) : o.done ? s.doneNoProof : undefined,
        quote: o.quote,
        versionNote: text && !text.includes(o.quote) ? t.page.quoteMissing(o.version) : undefined,
        card: card && { id: card.id, label: s.card(card.id, world().stages.find((x) => x.id === stageOf(card))?.label ?? '') },
        focused: o.id === focus,
      };
    });
}

function commentModels(ctx: ScreenCtx, c: Contract, shown: number, onlyClause?: string, focusClause?: string): CommentModel[] {
  const t = ctx.copy.contracts;
  return c.comments
    .filter((cm) => !onlyClause || cm.clause === onlyClause)
    .map((cm): CommentModel => {
      const n = versionOf(c, cm.version)?.clauses.find((x) => x.id === cm.clause)?.n ?? cm.clause.replace('art-', '');
      const then = clauseText(c, cm.version, cm.clause);
      const now = clauseText(c, shown, cm.clause);
      const changed = then !== undefined && now !== undefined && then !== now;
      return {
        id: cm.id,
        clauseLabel: `${t.common.clause(n)} · ${t.common.version(cm.version)}`,
        author: actorOf(cm.author),
        at: stamp(cm.at),
        text: cm.text,
        resolved: Boolean(cm.resolved),
        changedNote: !changed ? undefined : cm.version > shown ? t.side.comments.onDraft(cm.version) : t.side.comments.changedSince(cm.version),
        here: cm.clause === focusClause && cm.version === shown,
        replies: (cm.replies ?? []).map((r, i) => ({ id: `${cm.id}-r${i}`, author: actorOf(r.author), at: stamp(r.at), text: r.text })),
      };
    })
    .sort((a, b) => Number(a.resolved) - Number(b.resolved));
}

function versionModels(ctx: ScreenCtx, c: Contract, shown: number): VersionModel[] {
  const t = ctx.copy.contracts;
  const o = t.side.versions.origin;
  const inForce = currentVersion(c).n;
  const ordered = [...c.versions].sort((a, b) => a.n - b.n);
  const latestN = ordered[ordered.length - 1]?.n;
  return ordered.map((v, i): VersionModel => {
    const variant = c.variants.find((x) => x.version === v.n);
    const prev = ordered[i - 1];
    const valueChanged = v.value !== undefined && (!prev || v.value !== (prev.value ?? c.value));
    return {
      n: v.n,
      label: t.common.version(v.n),
      author: actorOf(v.author),
      draftedBy: v.draftedBy ? t.side.versions.draftedBy(actorOf(v.draftedBy).name) : undefined,
      at: stamp(v.at),
      reason: v.reason,
      originText: variant ? o.variant : i === 0 ? o.first : v.signed ? o.signed : v.draftedBy ? o.agent : o.edited,
      signed: Boolean(v.signed),
      inForce: v.n === inForce && Boolean(v.signed),
      draft: !v.signed,
      toApprove: !v.signed && underApproval(c) && v.n === latestN,
      valueText: valueChanged ? t.side.versions.value(t.common.euro(formatMoney(v.value ?? c.value)), formatShare(variantShare(c, v.n))) : undefined,
      onShow: v.n === shown,
    };
  });
}

function linkModels(ctx: ScreenCtx, c: Contract): { flows: LinkModel[]; cards: LinkModel[] } {
  const l = ctx.copy.contracts.side.links;
  const flows = c.links.flows.map((id): LinkModel | undefined => {
    const f = world().opsFlows.find((x) => x.id === id);
    if (!f) return undefined;
    const tone: Tone = f.status === 'attivo' ? 'green' : f.status === 'collaudo' ? 'amber' : 'neutral'; // allow-italian: data codes compared by value
    return { id, kind: 'flow', icon: flowIcon(id), title: f.name, detail: l.flowDetail(f.steps.length, f.perMonth), statusText: f.status === 'attivo' ? l.flowStates.live : f.status === 'collaudo' ? l.flowStates.testing : l.flowStates.draft, statusTone: tone }; // allow-italian: data codes compared by value
  }).filter((x): x is LinkModel => Boolean(x));
  const cards = cardsOf(c, liveCards(ctx.state)).map((card): LinkModel => {
    const stage = stageOf(card);
    return { id: card.id, kind: 'card', title: `${card.id} · ${card.title}`, detail: `${flowLabel(card.flow)} · ${actorOf(card.worker.id).name}: ${card.worker.doing}`, statusText: world().stages.find((s) => s.id === stage)?.label, statusTone: STAGE_TONE[stage] };
  });
  return { flows, cards };
}

export function ContractPlace({ ctx, id, clause, mode }: { ctx: ScreenCtx; id: string; clause?: string; mode: ContractMode }) {
  const c = liveContractById(ctx.state, id);
  if (!c) return <NotFound ctx={ctx} />;
  const t = ctx.copy.contracts;
  const s = t.side;
  const inForceV = currentVersion(c);
  const latest = latestVersion(c);
  const [shownN, setShown] = ctx.ui<number>(`contracts.show.${c.id}`, inForceV.n);
  const shown = versionOf(c, shownN) ?? inForceV;
  const [focusOb, setFocusOb] = ctx.ui<string>(`contracts.ob.${c.id}`, '');
  const [showResolved, setShowResolved] = ctx.ui<boolean>(`contracts.resolved.${c.id}`, false);
  const [draft, setDraft] = ctx.ui<string>(`contracts.comment.${c.id}`, '');
  const [draftClause, setDraftClause] = ctx.ui<string>(`contracts.commentClause.${c.id}`, '');
  const pair = defaultPair(c);
  const [cmp, setCmp] = ctx.ui<{ on: boolean; picked: number[] }>(`contracts.cmp.${c.id}`, { on: false, picked: [] });
  /* With a clause open, its two counts narrow the panel beside the text to its comments or its obligations; a second press shows both again. */
  const [sideOnly, setSideOnly] = ctx.ui<'' | 'comments' | 'obligations'>(`contracts.sideOnly.${c.id}`, '');

  const fo = c.obligations.find((o) => o.id === focusOb);
  const foText = fo ? clauseText(c, shown.n, fo.clause) : undefined;
  const quoteMissing = fo && foText !== undefined && !foText.includes(fo.quote);
  /* the clause on show: the one of the address, else the one of the obligation picked in the list of obligations */
  const addressClause = clause && shown.clauses.some((x) => x.id === clause) ? clause : undefined;
  const focusClause = addressClause ?? (mode === 'obligations' && fo && shown.clauses.some((x) => x.id === fo.clause) ? fo.clause : undefined);
  const onlyClause = mode === 'text' ? addressClause : undefined;
  const clauseN = (cid: string) => shown.clauses.find((x) => x.id === cid)?.n ?? cid.replace('art-', '');
  const draftAhead = !latest.signed && latest.n > shown.n ? latest : undefined;

  const blocks: ClauseBlockModel[] = shown.clauses.map((cl) => {
    const comments = c.comments.filter((x) => x.clause === cl.id);
    const badges: ClauseBlockModel['badges'] = [];
    const change = lastChange(c, cl.id, shown.n);
    if (change) badges.push({ id: `changed:${change.from}:${change.to}`, label: t.page.badges.changedIn(change.to, versionOf(c, change.to)?.reason ?? ''), tone: 'blue', opens: true });
    if (draftAhead && clauseText(c, draftAhead.n, cl.id) !== cl.text) badges.push({ id: `draft:${shown.n}:${draftAhead.n}`, label: t.page.badges.changesInDraft(draftAhead.n), tone: 'amber', opens: true });
    return {
      id: cl.id,
      n: cl.n,
      title: cl.title,
      text: cl.text,
      mark: fo && fo.clause === cl.id ? fo.quote : undefined,
      focused: cl.id === focusClause,
      sideOpen: mode === 'text' && cl.id === addressClause && sideOnly ? sideOnly : undefined,
      comments: comments.length,
      openComments: comments.filter((x) => !x.resolved).length,
      obligations: c.obligations.filter((o) => o.clause === cl.id).length,
      badges,
    };
  });

  const goClause = (cid: string) => ctx.go(SP.clause(c.id, cid));
  const narrowTo = (part: 'comments' | 'obligations') => (cid: string) => {
    if (mode === 'text' && cid === addressClause) { setSideOnly(sideOnly === part ? '' : part); return; }
    setSideOnly(part);
    goClause(cid);
  };

  const stampText = shown.signed
    ? shown.n === inForceV.n ? t.page.stamp.inForce(stamp(shown.at).slice(0, 10)) : t.page.stamp.superseded(stamp(shown.at).slice(0, 10), inForceV.n)
    : underApproval(c) && shown.n === latest.n ? t.page.stamp.locked : t.page.stamp.draft;
  const stampTone = shown.signed ? 'sealed' : underApproval(c) && shown.n === latest.n ? 'locked' : 'draft';

  const canComment = ctx.can('edit:contracts') || ctx.can('edit:data');
  const commentDenied = canComment ? undefined : isReadOnly(ctx.persona.id) ? t.common.readOnly(teamLabelOf(ctx.persona.id)) : ctx.deniedTitle('edit:data');
  const obligations = obligationModels(ctx, c, shown.n, focusOb, onlyClause);
  const comments = commentModels(ctx, c, shown.n, onlyClause, focusClause);
  const attachments = attachmentsOf(ctx, c);
  const links = linkModels(ctx, c);

  const obligationsPanel = (
    <ObligationList
      items={obligations}
      onFocus={(oid) => {
        const o = c.obligations.find((x) => x.id === oid);
        if (oid === focusOb) { setFocusOb(''); return; }
        setFocusOb(oid);
        /* the list of all obligations stays where it is: the text beside it shows the clause */
        if (o && mode !== 'obligations') goClause(o.clause);
      }}
      onClose={(oid) => {
        const o = c.obligations.find((x) => x.id === oid);
        return o && (o.owner === ctx.persona.id || ctx.can('edit:contracts')) ? (x: string, proof: string) => closeObligation(ctx, c, x, proof) : false;
      }}
      closeDenied={(oid) => {
        const o = c.obligations.find((x) => x.id === oid);
        if (!o || o.owner === ctx.persona.id || ctx.can('edit:contracts')) return undefined;
        return isReadOnly(ctx.persona.id) ? t.common.readOnly(teamLabelOf(ctx.persona.id)) : s.obligations.closeDenied(actorOf(o.owner).name);
      }}
      onOpenCard={(cardId) => {
        const card = liveCards(ctx.state).find((x) => x.id === cardId);
        if (card) ctx.go(SP.card(card.id));
      }}
      copy={ctx.copy}
      emptyText={onlyClause ? s.obligations.emptyClause(t.common.clause(clauseN(onlyClause))) : s.obligations.empty}
    />
  );

  const commentClause = draftClause && shown.clauses.some((x) => x.id === draftClause) ? draftClause : onlyClause ?? focusClause ?? shown.clauses[0]?.id ?? '';
  const commentsPanel = (
    <div className="space-y-3">
      <div className="space-y-2 rounded-lg border border-app-border bg-app-inset p-2.5">
        {!onlyClause && (
          <Select
            label={s.comments.clauseField}
            value={commentClause}
            options={shown.clauses.map((x) => ({ value: x.id, label: t.page.clauseHeading(x.n, x.title) }))}
            onChange={setDraftClause}
            disabled={!canComment}
            title={commentDenied}
          />
        )}
        <TextArea value={draft} onChange={setDraft} placeholder={s.comments.placeholder} rows={2} disabled={!canComment} />
        <div className="flex justify-end">
          <Button
            variant="primary"
            icon={MessageSquare}
            onClick={canComment && draft.trim() ? () => { addComment(ctx, c, commentClause, shown.n, draft.trim()); setDraft(''); } : false}
            title={commentDenied}
          >
            {s.comments.send}
          </Button>
        </div>
      </div>
      <CommentList
        items={comments}
        onReply={canComment ? (cid, text) => replyComment(ctx, c, cid, text) : false}
        onResolve={canComment ? (cid) => resolveComment(ctx, c, cid) : false}
        denied={commentDenied}
        onOpenClause={(cid) => {
          const cm = c.comments.find((x) => x.id === cid);
          if (!cm) return;
          if (versionOf(c, cm.version) && cm.version !== shown.n) setShown(cm.version);
          goClause(cm.clause);
        }}
        showResolved={showResolved}
        onShowResolved={setShowResolved}
        copy={ctx.copy}
        emptyText={onlyClause ? s.comments.emptyClause(t.common.clause(clauseN(onlyClause))) : s.comments.empty}
      />
    </div>
  );

  /* the panel of the page; the text page has one only for a clause */
  let side: ReactNode = null;
  if (mode === 'obligations') side = obligationsPanel;
  else if (mode === 'comments') side = commentsPanel;
  else if (mode === 'versions') {
    side = (
      <VersionList
        items={versionModels(ctx, c, shown.n)}
        comparing={cmp.on}
        picked={cmp.picked}
        onToggleCompare={() => setCmp(cmp.on ? { on: false, picked: [] } : { on: true, picked: pair ? [pair.from, pair.to] : [] })}
        onPick={(n) => setCmp({ on: true, picked: cmp.picked.includes(n) ? cmp.picked.filter((x) => x !== n) : [...cmp.picked, n].slice(-2) })}
        onShow={setShown}
        onCompare={cmp.picked.length === 2 ? () => ctx.go(SP.compare(c.id, Math.min(...cmp.picked), Math.max(...cmp.picked))) : false}
        copy={ctx.copy}
      />
    );
  } else if (mode === 'attachments') {
    side = (
      <AttachmentList
        items={attachments.map((a): AttachmentModel => {
          const k = attachmentKind(ctx, a.kind);
          return { id: a.id, name: a.name, kindText: k.text, kindTone: k.tone, detail: s.attachments.detail(a.version ? t.common.version(a.version) : '', stamp(a.at).slice(0, 10)) };
        })}
        onOpen={(aid) => ctx.go(SP.attachment(c.id, aid))}
        copy={ctx.copy}
      />
    );
  } else if (mode === 'links') {
    side = (
      <LinkList
        flows={links.flows}
        cards={links.cards}
        onOpen={(l) => {
          if (l.kind === 'flow') ctx.go(SP.flow(l.id));
          else {
            const card = liveCards(ctx.state).find((x) => x.id === l.id);
            if (card) ctx.go(SP.card(card.id));
          }
        }}
        copy={ctx.copy}
      />
    );
  } else if (onlyClause) {
    side = (
      <div className="space-y-4">
        {sideOnly !== 'comments' && (
          <section aria-label={s.tabs.obligations} className="space-y-2">
            <SectionLabel>{s.tabs.obligations}</SectionLabel>
            {obligationsPanel}
          </section>
        )}
        {sideOnly !== 'obligations' && (
          <section aria-label={s.tabs.comments} className="space-y-2">
            <SectionLabel>{s.tabs.comments}</SectionLabel>
            {commentsPanel}
          </section>
        )}
      </div>
    );
  }

  const crumb = mode === 'text' ? (focusClause ? t.common.clause(clauseN(focusClause)) : undefined) : s.tabs[mode];
  const panelLabel = onlyClause ? s.clauseTitle(clauseN(onlyClause)) : s.tabs[mode];

  return (
    <ContractFrame ctx={ctx} c={c} page={mode} crumb={crumb}>
      <div className={clsx('grid gap-4 px-4 py-4', side && !ctx.phone && 'lg:grid-cols-[minmax(0,1fr)_400px]')}>
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-compact font-medium text-app-text-secondary">{t.page.versionPicker}</span>
            <VersionPicker
              ariaLabel={t.page.versionPicker}
              value={shown.n}
              onChange={setShown}
              versions={[...c.versions].sort((a, b) => a.n - b.n).map((v) => ({
                n: v.n,
                label: t.common.version(v.n),
                signed: Boolean(v.signed),
                draft: !v.signed,
                title: `${v.reason} · ${stamp(v.at).slice(0, 10)}`,
              }))}
            />
          </div>
          {quoteMissing && fo && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.08] px-3 py-2 text-compact text-amber-900 dark:text-amber-200">
              <CircleAlert size={14} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{t.page.quoteMissing(fo.version)}</span>
              {versionOf(c, fo.version) && <Button size="sm" onClick={() => setShown(fo.version)}>{t.page.showVersion(fo.version)}</Button>}
            </div>
          )}
          <ContractText
            heading={c.title}
            subheading={`${kindLabel[c.kind]} · ${c.counterparty} · ${t.common.version(shown.n)}`}
            stamp={stampText}
            stampTone={stampTone}
            clauses={blocks}
            focusKey={`${focusClause ?? ''}:${focusOb}`}
            onClause={goClause}
            onComments={narrowTo('comments')}
            onObligations={narrowTo('obligations')}
            onBadge={(_cid, badgeId) => {
              const [, from, to] = badgeId.split(':');
              ctx.go(SP.compare(c.id, Number(from), Number(to)));
            }}
            copy={ctx.copy}
            footer={(
              <span className="flex items-center gap-1.5">
                <FileText size={13} aria-hidden="true" />
                {t.page.paperBy(actorOf(shown.author).name, stamp(shown.at))} · {shown.reason}
              </span>
            )}
          />
        </div>
        {/* On a phone the panel of the page comes first, the text under it. */}
        {side && (
          <aside aria-label={panelLabel} data-panel={mode} className={clsx('min-w-0 overflow-hidden rounded-lg border border-app-border bg-surface', ctx.phone ? 'order-first' : 'lg:sticky lg:top-3 lg:flex lg:max-h-[calc(100dvh-7.5rem)] lg:flex-col lg:self-start')}>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">{side}</div>
          </aside>
        )}
      </div>
    </ContractFrame>
  );
}
