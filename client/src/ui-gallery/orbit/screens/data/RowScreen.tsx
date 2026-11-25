/**
 * orbit-data-row: one row of a table of «Dati», with everything it carries. (allow-italian: quotes the Italian interface)
 * A card shows its fields, the values the agent read with the passage and the
 * confidence, the proposal, the stages it went through, its originals, and
 * the laws and procedures that cite it; it opens on the kanban, in the stages
 * or as the card itself. A contract shows its facts, today's alerts, its
 * obligations (each opening its clause), versions and linked cards. A town
 * shows its service, the public source, its contracts, open cards and
 * deadlines. The arrows walk the rows in the order the table had.
 */
import type { ReactNode } from 'react';
import { ArrowRight, BookOpen, ChevronLeft, ChevronRight, Database, ExternalLink, FileText, Layers, SquareKanban } from 'lucide-react';
import clsx from 'clsx';
import { Button, IconButton } from '../../../../ui/primitives/Button';
import { Card } from '../../../../ui/primitives/Card';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { KeyValue } from '../../../../ui/primitives/Panel';
import { Table } from '../../../../ui/primitives/Table';
import { Timeline } from '../../../../ui/primitives/Timeline';
import { BackButton, PaneHeader } from '../../../../ui/shell/PaneHeader';
import { FOCUS_RING } from '../../../../ui/shell/pressable';
import type { Contract, OrbitCard } from '../../../../ui/fixtures/orbit-org/types';
import type { Tone } from '../../../../ui/types';
import { partsCiting, world } from '../../world';
import type { KnowledgeCitation } from '../../../../ui/fixtures/orbit-org/knowledge';
import type { OrbitTown } from '../../../../ui/fixtures/orbit-org/data';
import { formatDay } from '../../../../ui/fixtures/org/clock';
import type { ScreenCtx } from '../../../app/kit';
import { liveCards, liveContracts, stageOf } from '../../model/live';
import { contractAlerts, currentVersion } from '../../model/contracts';
import { actorName, byActor, momentLabel } from '../../model/who';
import { flowLabel } from '../../model/flows';
import { openDaFare } from '../../model/dafare';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { cardDeadlines, contractDeadlines, relativeDay, STATE_TONE, stateOf, whatOf } from './deadlines';
import { rowsInView } from './filters';
import { KnowledgeNav } from '../knowledge/KnowledgeNav';
import {
  isOpenCard, isTable, openExternal, personShort, rowsOf, stageLabel, STAGE_TONE, STATUS_TONE,
  TABLE_IDS, tableOfCard, townCards, type TableId,
} from './tables';
import { PAGE_GUTTER } from '../../../../ui/shell/layout';

const HIGH: OrbitCard['priority'] = 'alta'; // allow-italian: data code, compared by value

function Section({ title, icon, children, actions }: { title: string; icon?: typeof Database; children: ReactNode; actions?: ReactNode }) {
  return <Card title={title} icon={icon} actions={actions}>{children}</Card>;
}

function LinkRow({ onOpen, title, detail, chip }: { onOpen: () => void; title: string; detail?: string; chip?: ReactNode }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className={clsx('-mx-2 flex w-[calc(100%+16px)] items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-app-hover', FOCUS_RING)}>
        <span className="min-w-0 flex-1">
          <span className="block text-prose font-medium text-app-text [overflow-wrap:break-word]">{title}</span>
          {detail && <span className="block text-compact leading-4 text-app-text-tertiary">{detail}</span>}
        </span>
        {chip}
        <ChevronRight size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
      </button>
    </li>
  );
}

/** The laws and procedures that cite a card or a contract, each opening its part. */
function Cited({ ctx, kind, id }: { ctx: ScreenCtx; kind: KnowledgeCitation['kind']; id: string }) {
  const s = ctx.copy.orbitData;
  const list = partsCiting(kind, id);
  return (
    <Section title={s.row.sections.cited} icon={BookOpen}>
      {list.length === 0 ? <p className="text-compact text-app-text-tertiary">{s.row.noCited}</p> : (
        <ul className="space-y-0.5">
          {list.map(({ doc, part, citation }) => (
            <LinkRow
              key={`${doc.id}/${part.id}/${citation.at ?? ''}`}
              onOpen={() => ctx.go(SP.knowledgeDoc(doc.id, part.id))}
              title={`${doc.label} · ${part.short}`}
              detail={citation.at ? `${s.common.clause(citation.at.replace('art-', ''))} · ${citation.why}` : citation.why}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function CardBody({ ctx, card }: { ctx: ScreenCtx; card: OrbitCard }) {
  const s = ctx.copy.orbitData;
  const stage = stageOf(card);
  const row = rowsOf(tableOfCard(card), ctx.state, s, ctx.now).find((r) => r.id === card.id);
  const high = card.priority === HIGH;
  const text = row?.text ?? {};
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <div>
          <h2 className="text-headline font-semibold tracking-[-0.01em] text-app-text">{card.title}</h2>
          <p className="mt-1 text-prose text-app-text-secondary">{card.detail}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Chip tone={STAGE_TONE[stage]} strong>{stageLabel(stage)}</Chip>
            <Chip>{flowLabel(card.flow)}</Chip>
            {high && <Chip tone="red">{s.values.priority[HIGH]}</Chip>}
            {text.stopped && text.stopped !== s.values.notStopped && <Chip tone={card.blocked ? 'red' : 'amber'}>{card.blocked ? `${text.stopped}: ${card.blocked.reason}` : text.stopped}</Chip>}
          </div>
        </div>
        <Section title={s.row.sections.values} icon={FileText}>
          <div className="overflow-x-auto">
            <Table
              ariaLabel={s.row.sections.values}
              dense
              columns={[{ id: 'label', label: s.columns.field, width: 150 }, { id: 'value', label: s.columns.value }, { id: 'from', label: s.columns.source, width: 200 }]}
              rows={card.values.map((v) => {
                const doc = card.originals.find((o) => o.id === v.doc);
                return {
                  id: v.label,
                  onOpen: () => ctx.go(SP.cardOriginal(card.id, v.doc)),
                  cells: {
                    label: <span className="text-app-text-secondary">{v.label}</span>,
                    value: (
                      <span className="block">
                        <span className="block font-medium text-app-text">{v.value}</span>
                        <span className="block text-compact leading-4 text-app-text-tertiary">«{v.quote}»</span>
                      </span>
                    ),
                    from: (
                      <span className="block text-compact leading-4">
                        <span className="block text-app-text-secondary">{s.row.readFrom(doc?.name ?? v.doc)}</span>
                        <Chip tone={v.confidence < 85 ? 'amber' : 'green'}>{s.row.confidence(v.confidence)}</Chip>
                      </span>
                    ),
                  },
                };
              })}
            />
          </div>
        </Section>
        <Section title={s.row.sections.proposal}>
          <p className="text-prose leading-6 text-app-text">{card.proposal}</p>
        </Section>
        <Cited ctx={ctx} kind="card" id={card.id} />
      </div>
      {/* the facts sit at the side, as for a contract and a town: across the whole width a label and its value were a screen apart */}
      <div className="min-w-0 space-y-4">
        <Section title={s.row.sections.facts} icon={Database}>
          <KeyValue label={s.columns.code} value={card.id} />
          <KeyValue label={s.columns.worker} value={<button type="button" onClick={() => ctx.go(SP.person(card.worker.id))} className={clsx('rounded text-right hover:underline', FOCUS_RING)}>{text.worker}</button>} />
          <KeyValue label={s.columns.doing} value={card.worker.doing} />
          <KeyValue label={s.columns.reviewer} value={<button type="button" onClick={() => ctx.go(SP.person(card.reviewer))} className={clsx('rounded text-right hover:underline', FOCUS_RING)}>{text.reviewer}</button>} />
          {card.due && <KeyValue label={s.columns.due} value={`${formatDay(card.due)} · ${relativeDay(ctx, card.due, ctx.now.slice(0, 10))}`} />}
          {card.place && <KeyValue label={s.columns.place} value={row?.links.place ? <button type="button" onClick={() => ctx.go(row.links.place)} className={clsx('rounded text-right hover:underline', FOCUS_RING)}>{card.place}</button> : card.place} />}
          <KeyValue label={s.columns.flow} value={<button type="button" onClick={() => ctx.go(row?.links.flow ?? SP.flow(card.flow))} className={clsx('rounded text-right hover:underline', FOCUS_RING)}>{text.flow}</button>} />
          <KeyValue label={s.columns.since} value={text.since} />
        </Section>
        <Section title={s.row.sections.history}>
          <Timeline
            items={[...card.history].reverse().map((h, i) => ({
              id: `${h.stage}-${i}`,
              at: momentLabel(h.at, ctx.now, ctx.copy),
              title: stageLabel(h.stage),
              who: actorName(byActor(h.by)),
              tone: STAGE_TONE[h.stage],
            }))}
          />
        </Section>
        <Section title={s.row.sections.originals} icon={FileText}>
          <ul className="space-y-0.5">
            {card.originals.map((o) => <LinkRow key={o.id} onOpen={() => ctx.go(SP.cardOriginal(card.id, o.id))} title={o.name} detail={`${o.from} · ${momentLabel(o.at, ctx.now, ctx.copy)}`} />)}
          </ul>
        </Section>
        {card.links?.contract && (
          <Section title={s.columns.contract}>
            <ul>
              <LinkRow
                onOpen={() => ctx.go(card.links?.clause ? SP.clause(card.links.contract as string, card.links.clause) : SP.contract(card.links?.contract as string))}
                title={liveContracts(ctx.state).find((c) => c.id === card.links?.contract)?.title ?? card.links.contract}
                detail={card.links.clause ? s.common.clause(card.links.clause.replace('art-', '')) : undefined}
              />
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}

function ContractBody({ ctx, contract: c }: { ctx: ScreenCtx; contract: Contract }) {
  const s = ctx.copy.orbitData;
  const today = ctx.now.slice(0, 10);
  const cards = liveCards(ctx.state);
  const row = rowsOf('contratti', ctx.state, s, ctx.now).find((r) => r.id === c.id); // allow-italian: address segment, compared by value
  const text = row?.text ?? {};
  const alerts = contractAlerts(c, today, cards);
  const version = currentVersion(c);
  const clauseN = (id: string) => version.clauses.find((x) => x.id === id)?.n ?? id.replace('art-', '');
  const linked = cards.filter((x) => x.links?.contract === c.id || c.links.cards.includes(x.id));
  const alertTone = (tone: 'error' | 'warn' | 'info'): Tone => (tone === 'error' ? 'red' : tone === 'warn' ? 'amber' : 'blue');
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <div>
          <h2 className="text-headline font-semibold tracking-[-0.01em] text-app-text">{c.title}</h2>
          <p className="mt-1 text-prose text-app-text-secondary">{c.counterparty} · {c.object}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Chip tone={STATUS_TONE[c.status]} strong>{text.status}</Chip>
            <Chip>{text.kind}</Chip>
            <Chip>{text.version}</Chip>
          </div>
        </div>
        <Section title={s.row.sections.alerts}>
          {alerts.length === 0 ? <p className="text-compact text-app-text-tertiary">{s.row.noAlerts}</p> : (
            <ul className="space-y-0.5">
              {alerts.map((a) => (
                <LinkRow key={a.id} onOpen={() => ctx.go(a.clause ? SP.clause(c.id, a.clause) : SP.contract(c.id))} title={a.title} detail={a.body} chip={<Chip tone={alertTone(a.tone)}>{a.clause ? s.common.clause(clauseN(a.clause)) : text.status}</Chip>} />
              ))}
            </ul>
          )}
        </Section>
        <Section title={s.row.sections.obligations}>
          {c.obligations.length === 0 ? <p className="text-compact text-app-text-tertiary">{s.row.noObligations}</p> : (
            <div className="overflow-x-auto">
              <Table
                ariaLabel={s.row.sections.obligations}
                dense
                columns={[{ id: 'what', label: s.deadlines.columns.what }, { id: 'clause', label: s.peek.clauses, width: 80 }, { id: 'owner', label: s.deadlines.columns.owner, width: 120 }, { id: 'due', label: s.deadlines.columns.day, width: 110 }, { id: 'state', label: s.deadlines.columns.status, width: 100 }]}
                rows={c.obligations.map((o) => {
                  const st = o.done ? 'done' : o.due ? stateOf({ id: o.id, day: o.due, kind: 'obligation', area: c.area, owner: o.owner, done: false, path: '' }, today) : 'open';
                  return {
                    id: o.id,
                    muted: o.done,
                    onOpen: () => ctx.go(SP.clause(c.id, o.clause)),
                    cells: {
                      what: <span className="block"><span className="block text-app-text">{o.what}</span>{o.every && <span className="block text-compact text-app-text-tertiary">{o.every}</span>}</span>,
                      clause: s.common.clause(clauseN(o.clause)),
                      owner: personShort(o.owner),
                      due: o.due ? formatDay(o.due) : <span className="text-app-text-faint">{s.common.blank}</span>,
                      state: <Chip tone={STATE_TONE[st]}>{o.done ? s.row.obligationDone : s.deadlines.states[st]}</Chip>,
                    },
                  };
                })}
              />
            </div>
          )}
        </Section>
        <Cited ctx={ctx} kind="contract" id={c.id} />
      </div>
      <div className="min-w-0 space-y-4">
        <Section title={s.row.sections.facts} icon={Database}>
          <KeyValue label={s.columns.counterparty} value={c.counterparty} />
          <KeyValue label={s.columns.value} value={text.value} />
          <KeyValue label={s.columns.start} value={c.start ? formatDay(c.start) : <span className="text-app-text-faint">{s.common.blank}</span>} />
          <KeyValue label={s.columns.end} value={text.end} />
          <KeyValue label={s.columns.notice} value={text.notice} />
          <KeyValue label={s.columns.owner} value={<button type="button" onClick={() => ctx.go(SP.person(c.owner))} className={clsx('rounded hover:underline', FOCUS_RING)}>{text.owner}</button>} />
          <KeyValue label={s.columns.area} value={world().people.areaLabel[c.area]} />
          {c.cig && <KeyValue label={s.columns.cig} value={c.cig} />}
        </Section>
        <Section title={s.row.sections.versions} actions={<Button size="sm" onClick={() => ctx.go(SP.versions(c.id))}>{s.row.openVersions}</Button>}>
          <ul className="space-y-0.5">
            {[...c.versions].sort((a, b) => b.n - a.n).map((v) => (
              <LinkRow key={v.n} onOpen={() => ctx.go(SP.versions(c.id))} title={`${s.values.version(v.n)} · ${v.reason}`} detail={formatDay(v.at.slice(0, 10))} chip={<Chip tone={v.signed ? 'green' : 'amber'}>{v.signed ? s.row.versionSigned : s.row.versionOpen}</Chip>} />
            ))}
          </ul>
        </Section>
        <Section title={s.peek.contractCards}>
          {linked.length === 0 ? <p className="text-compact text-app-text-tertiary">{s.row.noCards}</p> : (
            <ul className="space-y-0.5">
              {linked.map((x) => <LinkRow key={x.id} onOpen={() => ctx.go(SP.card(x.id))} title={`${x.id} · ${x.title}`} detail={flowLabel(x.flow)} chip={<Chip tone={STAGE_TONE[stageOf(x)]}>{stageLabel(stageOf(x))}</Chip>} />)}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function TownBody({ ctx, town }: { ctx: ScreenCtx; town: OrbitTown }) {
  const s = ctx.copy.orbitData;
  const today = ctx.now.slice(0, 10);
  const contracts = liveContracts(ctx.state).filter((c) => town.contracts.includes(c.id));
  const open = townCards(ctx.state, town).filter(isOpenCard);
  const deadlines = [...cardDeadlines(open), ...contractDeadlines(contracts, today)].filter((d) => !d.done).sort((a, b) => a.day.localeCompare(b.day)).slice(0, 8);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <div>
          <h2 className="text-headline font-semibold tracking-[-0.01em] text-app-text">{town.name}</h2>
          <p className="mt-1 text-prose text-app-text-secondary">{town.service}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Chip tone={town.past ? 'neutral' : 'green'} strong>{town.past ? s.values.townPast : s.values.townActive}</Chip>
            <Chip>{town.province}</Chip>
          </div>
        </div>
        <Section title={s.row.sections.contracts}>
          {contracts.length === 0 ? <p className="text-compact text-app-text-tertiary">{s.row.noContracts}</p> : (
            <div className="overflow-x-auto">
              <Table
                ariaLabel={s.row.sections.contracts}
                dense
                columns={[{ id: 'title', label: s.columns.contract }, { id: 'status', label: s.columns.status, width: 130 }, { id: 'end', label: s.columns.end, width: 110 }]}
                rows={contracts.map((c) => ({
                  id: c.id,
                  onOpen: () => ctx.go(SP.contract(c.id)),
                  cells: {
                    title: <span className="font-medium text-app-text">{c.title}</span>,
                    status: <Chip tone={STATUS_TONE[c.status]}>{rowsOf('contratti', ctx.state, s, ctx.now).find((r) => r.id === c.id)?.text.status}</Chip>, // allow-italian: address segment, compared by value
                    end: c.end ? formatDay(c.end) : s.values.noEnd,
                  },
                }))}
              />
            </div>
          )}
        </Section>
        <Section title={s.row.sections.cards}>
          {open.length === 0 ? <p className="text-compact text-app-text-tertiary">{s.row.noCards}</p> : (
            <ul className="space-y-0.5">
              {open.map((x) => <LinkRow key={x.id} onOpen={() => ctx.go(SP.card(x.id))} title={`${x.id} · ${x.title}`} detail={flowLabel(x.flow)} chip={<Chip tone={STAGE_TONE[stageOf(x)]}>{stageLabel(stageOf(x))}</Chip>} />)}
            </ul>
          )}
        </Section>
      </div>
      <div className="min-w-0 space-y-4">
        <Section title={s.row.sections.facts} icon={Database}>
          <KeyValue label={s.columns.province} value={town.province} />
          <KeyValue label={s.columns.from} value={town.since} />
          <KeyValue label={s.columns.source} value={<button type="button" onClick={() => openExternal(ctx, town.source.url)} className={clsx('inline-flex items-center gap-1 rounded text-primary hover:underline dark:text-primary-dark', FOCUS_RING)}>{town.source.host}<ExternalLink size={12} aria-hidden="true" /></button>} />
        </Section>
        <Section title={s.row.sections.deadlines}>
          {deadlines.length === 0 ? <p className="text-compact text-app-text-tertiary">{s.row.noDeadlines}</p> : (
            <ul className="space-y-0.5">
              {deadlines.map((d) => <LinkRow key={d.id} onOpen={() => ctx.go(d.path)} title={whatOf(ctx, d)} detail={`${formatDay(d.day)} · ${relativeDay(ctx, d.day, today)}`} chip={<Chip tone={STATE_TONE[stateOf(d, today)]}>{s.deadlines.tag[d.kind]}</Chip>} />)}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

export function RowScreen({ ctx, table, rowId }: { ctx: ScreenCtx; table: string; rowId: string }) {
  const s = ctx.copy.orbitData;
  const t: TableId = isTable(table) ? table : TABLE_IDS[0];
  const list = isTable(table) ? rowsInView(ctx, t, rowId) : [];
  const index = list.findIndex((r) => r.id === rowId);
  const row = list[index];
  const back = () => ctx.go(SP.data(isTable(table) ? table : undefined));
  if (!row) {
    return (
      <EmptyState icon={Database} title={s.row.notFound.title} action={<Button variant="primary" onClick={back}>{s.row.notFound.back}</Button>}>
        {s.row.notFound.body}
      </EmptyState>
    );
  }
  const prev = list[index - 1];
  const next = list[index + 1];
  const card = row.card;
  const rowLabel = row.card ? row.card.id : row.title;
  const actions = (
    <>
      <span className="text-compact tabular-nums text-app-text-tertiary">{s.row.position(index + 1, list.length)}</span>
      <IconButton icon={ChevronLeft} label={s.row.previous} onClick={prev ? () => ctx.go(SP.dataRow(t, prev.id)) : false} />
      <IconButton icon={ChevronRight} label={s.row.next} onClick={next ? () => ctx.go(SP.dataRow(t, next.id)) : false} />
      {card && <Button icon={SquareKanban} onClick={() => openDaFare(ctx, { view: 'kanban', flow: card.flow })}>{s.row.openKanban}</Button>}
      {card && <Button icon={Layers} onClick={() => openDaFare(ctx, { view: 'stages', flow: card.flow })}>{s.row.openStages}</Button>}
      {card && <Button variant="primary" icon={ArrowRight} onClick={() => ctx.go(SP.card(card.id))}>{s.row.openCard}</Button>}
      {row.contract && <Button variant="primary" icon={ArrowRight} onClick={() => ctx.go(SP.contract(row.id))}>{s.row.openContract}</Button>}
      {row.town && <Button icon={ExternalLink} onClick={() => openExternal(ctx, (row.town as OrbitTown).source.url)}>{s.row.openSource}</Button>}
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        /* on the desk the crumb of the table already leads back; the arrow is for the phone, which shows only the last crumb */
        leading={ctx.phone ? <BackButton label={s.tables[t].label} onClick={back} copy={ctx.copy} /> : undefined}
        crumbs={orgCrumbs(ctx, [{ label: s.knowledge.title, to: SP.knowledge() }, { label: s.title, to: SP.data() }, { label: s.tables[t].label, to: SP.data(t) }, { label: rowLabel }])}
      >
        {!ctx.phone && actions}
      </PaneHeader>
      <KnowledgeNav ctx={ctx} active="data" />
      {ctx.phone && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border px-4 py-2">{actions}</div>}
      <div className={`min-h-0 flex-1 overflow-y-auto ${PAGE_GUTTER} py-5`}>
        {row.card ? <CardBody ctx={ctx} card={row.card} /> : row.contract ? <ContractBody ctx={ctx} contract={row.contract} /> : <TownBody ctx={ctx} town={row.town as OrbitTown} />}
      </div>
    </div>
  );
}
