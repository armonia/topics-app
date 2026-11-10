/**
 * Everything the global search finds in the edition, in one place: the cards
 * (with their numbers, places and extracted values), the flows and their
 * steps, the documents, rules, contracts and clauses, the data (tables,
 * deadlines, towns), the people, teams and agents, the programs. It reads the
 * world of the organization (`world()`) and the live state, so it works the
 * same for every organization, and it also says what to suggest while the
 * field is empty. An area without screens: it only answers `search` and
 * `suggest`.
 */
import { Bot, CalendarClock, CirclePause, Database, FileSignature, FileText, ListChecks, ListOrdered, MapPin, Plug, ScrollText, ShieldCheck, UserRound, Users } from 'lucide-react';
import { NAV_ICON } from '../../ui/icons';
import type { AreaModule, ScreenCtx, SearchEntry } from '../app/kit';
import { SP } from './paths';
import { agentById, teamIdOfPerson, world } from './world';
import { liveCards, liveContracts, stageOf } from './model/live';
import { flowIcon, flowLabel, openCards } from './model/flows';
import { stuckCards } from './model/stages';
import { stoppedAge, stoppedHours } from './model/stopped';
import { currentVersion, dayLabel, kindLabel, statusLabel } from './model/contracts';
import { actorName, stepActor, workerActor } from './model/who';
import { stageLabel } from './model/words';
import { allDeadlines, dueWithin } from './screens/data/deadlines';
import { TABLE_IDS } from './screens/data/tables';
import { flowsUsing } from './screens/programs/state';
import { teamLabel } from './screens/team/labels';
import { foldText } from '../app/search';

const DOC_ICON = { norme: ScrollText, azienda: FileText, procedure: ListChecks } as const; // allow-italian: collection ids of the data

/** Whether a document is issued by the organization on show: every line would repeat its name, so the issuer is not searched then. */
function isOwnIssuer(issuer: string): boolean {
  const w = world();
  const names = [w.name, w.shortName, w.organization.identity.find((f) => f.id === 'name')?.value ?? ''];
  const first = (n: string) => foldText(n).split(/[\s,]+/)[0];
  const issuerFirst = first(issuer);
  return names.some((n) => n !== '' && first(n) === issuerFirst);
}

const compact = (parts: Array<string | undefined>): string[] => parts.filter((p): p is string => Boolean(p));

function cardEntries(ctx: ScreenCtx): SearchEntry[] {
  const s = ctx.copy.app.search;
  /* Cards still to do come first: among equal matches the order is the order given. */
  const cards = [...liveCards(ctx.state)].sort((a, b) => Number(stageOf(a) === 'fatto') - Number(stageOf(b) === 'fatto')); // allow-italian: stage id, compared by value
  return cards.map((card): SearchEntry => ({
    id: `card:${card.id}`,
    kind: 'card',
    group: s.groups.card,
    title: card.title,
    ref: card.id,
    detail: [card.id, flowLabel(card.flow), stageLabel(stageOf(card)), actorName(workerActor(card.worker))].join(' · '),
    facets: compact([card.detail, card.place, ...card.values.map((v) => `${v.label}: ${v.value}`), ...card.originals.map((o) => o.name), card.blocked?.reason]),
    path: SP.card(card.id),
    icon: flowIcon(card.flow),
    needs: 'view:inbox',
  }));
}

function flowEntries(ctx: ScreenCtx): SearchEntry[] {
  const s = ctx.copy.app.search;
  const open = openCards(liveCards(ctx.state));
  const flows = world().opsFlows.map((f): SearchEntry => ({
    id: `flow:${f.id}`,
    kind: 'flussi',
    group: s.groups.flussi,
    title: f.name,
    detail: [f.outcome ?? f.source, s.detail.openCards(open.filter((c) => c.flow === f.id).length)].join(' · '),
    facets: compact([f.source, f.outcome, f.trigger, agentById(f.agent)?.name, ...f.programs, ...f.steps.map((step) => step.title)]),
    path: SP.flow(f.id),
    icon: flowIcon(f.id),
    needs: 'view:flows',
  }));
  const steps = world().opsFlows.flatMap((f) => f.steps.map((step, i): SearchEntry => ({
    id: `flow-step:${f.id}/${step.id}`,
    kind: 'flussi',
    group: s.groups.flussi,
    title: step.title,
    detail: [s.detail.step(i + 1, f.name), actorName(stepActor(step.actor, ctx.copy))].join(' · '),
    path: SP.flowStep(f.id, step.id),
    icon: ListOrdered,
    needs: 'view:flows',
  })));
  return [...flows, ...steps];
}

function documentEntries(ctx: ScreenCtx): SearchEntry[] {
  const s = ctx.copy.app.search;
  const docs = world().knowledge.docs.map((doc): SearchEntry => ({
    id: `doc:${doc.id}`,
    kind: 'documenti',
    group: s.groups.documenti,
    title: doc.label,
    /* The kind of document: where the word was found comes after it, as an excerpt. */
    detail: s.detail.docKind[doc.collection],
    facets: compact([doc.title, doc.subtitle, isOwnIssuer(doc.issuer) ? undefined : doc.issuer, doc.note, doc.keywords]),
    path: SP.knowledgeDoc(doc.id),
    icon: DOC_ICON[doc.collection],
    needs: 'view:knowledge',
  }));
  const parts = world().knowledge.docs.flatMap((doc) => doc.parts.map((part): SearchEntry => ({
    id: `doc-part:${doc.id}/${part.id}`,
    kind: 'documenti',
    group: s.groups.documenti,
    title: `${doc.label} · ${part.short}`,
    detail: part.heading,
    facets: compact([part.summary, part.quote, part.keywords]),
    path: SP.knowledgeDoc(doc.id, part.id),
    icon: FileText,
    needs: 'view:knowledge',
  })));
  const contracts = liveContracts(ctx.state);
  const lists = contracts.map((c): SearchEntry => ({
    id: `contract:${c.id}`,
    kind: 'documenti',
    group: s.groups.documenti,
    title: c.title,
    detail: compact([c.counterparty, statusLabel[c.status], c.end ? s.detail.expires(dayLabel(c.end)) : undefined]).join(' · '),
    facets: compact([c.object, c.cig, c.counterpartyKind, kindLabel[c.kind], ...(c.tags ?? [])]),
    path: SP.contract(c.id),
    icon: NAV_ICON.contracts,
    needs: 'view:contracts',
  }));
  const clauses = contracts.flatMap((c) => currentVersion(c).clauses.map((clause): SearchEntry => ({
    id: `clause:${c.id}/${clause.id}`,
    kind: 'documenti',
    group: s.groups.documenti,
    title: `${clause.n} ${clause.title}`,
    detail: s.detail.clause(c.title),
    facets: [clause.text],
    path: SP.clause(c.id, clause.id),
    icon: FileSignature,
    needs: 'view:contracts',
  })));
  return [...docs, ...lists, ...parts, ...clauses];
}

function dataEntries(ctx: ScreenCtx): SearchEntry[] {
  const s = ctx.copy.app.search;
  const d = ctx.copy.orbitData;
  const tables = TABLE_IDS.map((t): SearchEntry => ({
    id: `data:${t}`,
    kind: 'dati',
    group: s.groups.dati,
    title: d.tables[t].label,
    detail: d.tables[t].about,
    path: SP.data(t),
    icon: Database,
    needs: 'view:data',
  }));
  const deadlines: SearchEntry = {
    id: 'data:deadlines',
    kind: 'dati',
    group: s.groups.dati,
    title: d.deadlines.title,
    detail: Object.values(d.deadlines.tag).join(' · '),
    facets: Object.values(d.deadlines.kinds),
    path: SP.deadlines(),
    icon: CalendarClock,
    needs: 'view:data',
  };
  const towns = world().towns.map((town): SearchEntry => ({
    id: `town:${town.id}`,
    kind: 'dati',
    group: s.groups.dati,
    title: town.name,
    detail: `${town.province} · ${town.service}`,
    facets: [town.since],
    path: SP.dataRow('comuni', town.id), // allow-italian: address segment, not shown
    icon: MapPin,
    needs: 'view:data',
  }));
  return [...tables, deadlines, ...towns];
}

function peopleEntries(ctx: ScreenCtx): SearchEntry[] {
  const s = ctx.copy.app.search;
  const t = ctx.copy.orbitTeam;
  const people = world().people.personas.map((p): SearchEntry => {
    const team = teamLabel(ctx, teamIdOfPerson(p.id) ?? p.area);
    return {
      id: `person:${p.id}`,
      kind: 'persone',
      group: s.groups.persone,
      title: p.name,
      detail: team,
      facets: [p.short],
      path: SP.person(p.id),
      icon: UserRound,
      needs: 'view:team',
    };
  });
  const agents = world().people.agents.map((a): SearchEntry => ({
    id: `agent:${a.id}`,
    kind: 'persone',
    group: s.groups.persone,
    title: a.name,
    detail: `${s.detail.agent} · ${a.does}`,
    path: SP.person(a.id),
    icon: Bot,
    needs: 'view:team',
  }));
  const teams = [...world().people.teams.map((x) => ({ id: x.id as string, label: x.label, detail: x.does })), { id: world().people.agentsTeam.id as string, label: t.agentsTeam, detail: t.page.flowsAgents }]
    .map((x): SearchEntry => ({
      id: `team:${x.id}`,
      kind: 'persone',
      group: s.groups.persone,
      title: `${s.detail.team} · ${x.label}`,
      detail: x.detail,
      facets: [x.label],
      path: SP.teamOf(x.id),
      icon: Users,
      needs: 'view:team',
    }));
  const permissions: SearchEntry = {
    id: 'team:permissions',
    kind: 'persone',
    group: s.groups.persone,
    title: `${t.title} · ${t.permissions.crumb}`,
    detail: t.permissions.matrixTitle,
    facets: [...Object.values(t.permissions.sections), ...Object.values(t.permissions.actions).map((a) => a.label)],
    path: SP.teamPermissions(),
    icon: ShieldCheck,
    needs: 'view:team',
  };
  return [...people, ...agents, ...teams, permissions];
}

function programEntries(ctx: ScreenCtx): SearchEntry[] {
  const s = ctx.copy.app.search;
  return world().programs.map((p): SearchEntry => ({
    id: `program:${p.id}`,
    kind: 'programmi',
    group: s.groups.programmi,
    title: p.name,
    detail: p.sub,
    facets: compact([p.how, p.external, ...p.reads, ...p.writes.map((w) => w.what), ...flowsUsing(p).map((f) => f.name)]),
    path: SP.program(p.id),
    icon: Plug,
    needs: 'view:programs',
  }));
}

/** What to offer while the field is empty: what is stopped, what is due, where the work piles up. */
function suggestions(ctx: ScreenCtx): SearchEntry[] {
  const s = ctx.copy.app.search;
  const out: SearchEntry[] = [];

  const stuck = stuckCards(liveCards(ctx.state), ctx.now);
  if (stuck.length) {
    /* The one stopped longest, by the same age the token «Ferma da» of the card shows. allow-italian: quotes the words on screen */
    const oldest = stuck.reduce((a, b) => (stoppedHours(a, ctx.now) >= stoppedHours(b, ctx.now) ? a : b));
    out.push({
      id: 'suggest:stuck',
      kind: 'card',
      group: s.groups.card,
      title: s.suggest.stuck(stuck.length),
      detail: s.suggest.stuckOldest(oldest.title, stoppedAge(oldest, ctx.now)),
      path: SP.card(oldest.id),
      icon: CirclePause,
      needs: 'view:inbox',
    });
  }

  /* The same count as «Entro 7 giorni» in Dati: cards and contract dates, late ones included. allow-italian: quotes the words on screen */
  const today = ctx.now.slice(0, 10);
  const due = dueWithin(allDeadlines(ctx.state, today), today);
  if (due.length) {
    const first = due[0];
    out.push({
      id: 'suggest:due',
      kind: 'dati',
      group: s.groups.dati,
      title: s.suggest.dueSoon(due.length),
      detail: s.suggest.dueFirst(first.card ? `${first.card.id} ${first.card.title}` : first.contract?.title ?? '', dayLabel(first.day, today), first.day < today),
      path: SP.deadlines(),
      icon: CalendarClock,
      needs: 'view:data',
    });
  }

  const open = openCards(liveCards(ctx.state));
  const busiest = world().opsFlows
    .map((f) => ({ flow: f, n: open.filter((c) => c.flow === f.id).length }))
    .sort((a, b) => b.n - a.n)[0];
  if (busiest && busiest.n > 0) {
    out.push({
      id: 'suggest:busiest',
      kind: 'flussi',
      group: s.groups.flussi,
      title: s.suggest.busiest(busiest.flow.name),
      detail: s.suggest.busiestHint(busiest.n),
      path: SP.flow(busiest.flow.id),
      icon: flowIcon(busiest.flow.id),
      needs: 'view:flows',
    });
  }
  out.push({
    id: 'suggest:new-chat',
    group: s.groups.card,
    title: s.suggest.newChat,
    detail: s.suggest.newChatHint,
    path: SP.chatNew(),
    icon: NAV_ICON.assistant,
  });
  return out;
}

export const ORBIT_SEARCH_AREA: AreaModule = {
  screens: [],
  search: (ctx) => [...cardEntries(ctx), ...flowEntries(ctx), ...documentEntries(ctx), ...dataEntries(ctx), ...peopleEntries(ctx), ...programEntries(ctx)],
  suggest: suggestions,
};
