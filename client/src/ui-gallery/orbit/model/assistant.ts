/**
 * The answers of the chat with the AI, built from the world of the
 * organization on show and nothing else: the live cards (what is stopped, what
 * is due, what waits for a person), the contracts and their dates, the flows
 * and their steps, the towns. A question is read in two moves: the things it
 * names (a card by its id, a contract, a flow, a town, a person) and the idea
 * it asks for (stopped, due, waiting, summary, missing, who approves, what the
 * original says). Nothing is invented: an answer lists what the data holds and
 * every card, contract, flow or original it names is a token that opens it.
 * A question it cannot read gets an honest answer that says what it can do.
 *
 * Pure: the same state and the same question always give the same answer.
 */
import type { ChatBlock, ChatRef, ChatReply, ChatSeg } from '../../../ui/chat/model';
import type { ChatCopy, ChatWord } from '../../../ui/copy/chat';
import type { Persona } from '../../../ui/fixtures/org/people';
import { DEMO_TODAY, addDays, daysFromToday, formatDay, formatShortDay } from '../../../ui/fixtures/org/clock';
import type { Contract, OpsFlow, OrbitCard, StageId } from '../../../ui/fixtures/orbit-org/types';
import type { DemoState } from '../../app/store/state';
import type { OrbitTown } from '../../../ui/fixtures/orbit-org/data';
import { agentById, personaById, townOfPlace, world } from '../world';
import { SP } from '../paths';
import { flowLevel, sectionLevel } from './access';
import { actionLabel, contractDates, currentValue, dayLabel, daysTo, formatMoney, noticeDate, statusLabel, type ContractDate } from './contracts';
import { LOW_CONFIDENCE, liveStep, opsFlowById, openCards } from './flows';
import { liveCards, liveContracts, stageOf, waitingFor } from './live';
import { formatHours, isStuck } from './stages';
import { stoppedAge, stoppedSince } from './stopped';

export interface AssistantEnv {
  copy: ChatCopy;
  state: DemoState;
  persona: Persona;
  /** The demo's now (`ctx.now`). */
  now: string;
}

/** The longest list an answer prints before it says how many more there are. */
const LIST_MAX = 6;
const WEEK = 7;

/* ---------- reading a question ---------- */

/** Lowercase, no accents, no punctuation: ids keep their hyphen. */
const norm = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
/** The last vowel of a word of four letters or more goes, so a plural and a singular meet («fatture», «fattura»). */
const stem = (w: string): string => (w.length >= 4 && !/[0-9-]/.test(w) ? w.replace(/[aeiou]$/, '') : w);
const stemmed = (s: string): string => norm(s).split(' ').map(stem).join(' ');
const withoutNote = (s: string): string => s.replace(/\s*\([^)]*\)/g, '');

/** Whether the question holds one of the beginnings of words of an idea. */
function asks(text: string, copy: ChatCopy, word: ChatWord): boolean {
  const framed = ` ${norm(text)} `;
  return copy.words[word].some((k) => framed.includes(` ${norm(k)}`));
}

/** The items a question names by a whole name, else (when `loose` lists the words that ask for this kind of thing) by words only they carry. */
function named<T>(text: string, items: T[], namesOf: (t: T) => string[], loose: false | string[]): T[] {
  const framed = ` ${stemmed(text)} `;
  const exact: Array<{ item: T; size: number }> = [];
  for (const item of items) {
    const hit = namesOf(item).map((n) => stemmed(withoutNote(n))).filter((n) => n.length >= 3 && framed.includes(` ${n} `)).sort((a, b) => b.length - a.length)[0];
    if (hit) exact.push({ item, size: hit.length });
  }
  if (exact.length) {
    const best = Math.max(...exact.map((e) => e.size));
    return exact.filter((e) => e.size === best).map((e) => e.item);
  }
  if (!loose) return [];
  const skip = new Set(loose.flatMap((k) => stemmed(k).split(' ')));
  const words = (t: T) => new Set(namesOf(t).flatMap((n) => stemmed(withoutNote(n)).split(' ')).filter((w) => w.length >= 4 && !skip.has(w)));
  const sets = items.map(words);
  const count = new Map<string, number>();
  sets.forEach((s) => s.forEach((w) => count.set(w, (count.get(w) ?? 0) + 1)));
  const asked = new Set(framed.trim().split(' '));
  const scored = items.map((item, i) => ({ item, score: [...sets[i]].filter((w) => count.get(w) === 1 && asked.has(w)).length })).filter((s) => s.score > 0);
  if (!scored.length) return [];
  const best = Math.max(...scored.map((s) => s.score));
  return scored.filter((s) => s.score === best).map((s) => s.item);
}

/* ---------- what the person may see ---------- */

interface Scope {
  cards: OrbitCard[];
  contracts: Contract[];
  flows: OpsFlow[];
}

function scopeOf(env: AssistantEnv): Scope {
  const { state, persona } = env;
  return {
    cards: liveCards(state).filter((c) => flowLevel(state, persona, c.flow) !== 'none'),
    contracts: sectionLevel(state, persona, 'contracts') === 'none' ? [] : liveContracts(state),
    flows: world().opsFlows.filter((f) => flowLevel(state, persona, f.id) !== 'none'),
  };
}

/* ---------- tokens ---------- */

const stageLabel = (id: StageId): string => world().stages.find((s) => s.id === id)?.label ?? id;

const isOpen = (c: OrbitCard): boolean => stageOf(c) !== 'fatto'; // allow-italian: stage id, compared by value

function cardRef(c: OrbitCard, env: AssistantEnv): ChatRef {
  return { kind: 'card', id: c.id, label: c.id, detail: c.title, flow: c.flow, path: SP.card(c.id), tone: isOpen(c) && isStuck(c, world().opsFlows, env.now) ? 'red' : undefined };
}

const contractRef = (c: Contract): ChatRef => ({ kind: 'contract', id: c.id, label: c.title, path: SP.contract(c.id) });
const flowRef = (f: OpsFlow): ChatRef => ({ kind: 'flow', id: f.id, label: f.name, flow: f.id, path: SP.flow(f.id) });

function actorName(actor: OpsFlow['steps'][number]['actor'], copy: ChatCopy): string {
  switch (actor.kind) {
    case 'rule': return copy.reply.actorRule;
    case 'agent': return agentById(actor.id)?.name ?? actor.id;
    case 'program': return actor.name;
    case 'person': return personaById(actor.id)?.short ?? actor.id;
  }
}

const personName = (id: string): string => personaById(id)?.short ?? agentById(id.replace(/^agent:/, ''))?.name ?? id;

/* ---------- blocks ---------- */

const text = (...segs: ChatSeg[]): ChatBlock => ({ kind: 'text', segs });
const list = (items: ChatSeg[][]): ChatBlock => ({ kind: 'list', items });

/** The address of the token «Vedi tutte…» of the stopped cards: the chat screen opens «Da fare» with the filter «Ferme» on. (allow-italian: quotes the Italian interface) */
export const LIST_STUCK_PATH = 'chat-list:stuck';

/** Where the link under a cut list goes: the page of that kind of thing. */
interface MoreLink {
  path: string;
  place: keyof ChatCopy['reply']['places'];
  feminine: boolean;
}

const CARDS_LINK = { path: SP.inbox(), place: 'inbox', feminine: true } as const;
const FLOWS_LINK = { path: SP.flows(), place: 'flows', feminine: false } as const;
const CONTRACTS_LINK = { path: SP.contracts(), place: 'contracts', feminine: false } as const;

/** At most `LIST_MAX` items, then a link that opens the whole list. */
function capped(items: ChatSeg[][], copy: ChatCopy, more: MoreLink): ChatBlock[] {
  const blocks: ChatBlock[] = [list(items.slice(0, LIST_MAX))];
  if (items.length > LIST_MAX) {
    const label = copy.reply.moreLink(items.length, copy.reply.places[more.place], more.feminine);
    blocks.push(text({ kind: 'list', id: more.path, label, path: more.path }));
  }
  return blocks;
}

/** A role («Resp. tecnico», «Direttore gen.») or an agent takes the article in a sentence; a person's name does not. */
const TAKES_ARTICLE = /^(\p{Lu}\p{Ll}+\.|Agente\b|Direttore\b|Sindaco\b)/u;

/** A name with the article a sentence needs: «il Resp. tecnico», «l'Agente fatture». */
function withArticle(name: string): string {
  if (!TAKES_ARTICLE.test(name)) return name;
  return /^[AEIOUaeiou]/.test(name) ? `l'${name}` : `il ${name}`;
}

/** The same name after «di», the preposition and the article fused: «del Resp. tecnico», «dell'Agente fatture». allow-italian: quotes the words on screen */
function ofName(name: string): string {
  if (!TAKES_ARTICLE.test(name)) return `di ${name}`;
  return /^[AEIOUaeiou]/.test(name) ? `dell'${name}` : `del ${name}`;
}

const lowerFirst = (s: string): string => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;

/** A column inside a sentence: lower case, as it is said («è in arrivo», «è da verificare»). allow-italian: quotes the words on screen */
const stageInSentence = (id: StageId): string => lowerFirst(stageLabel(id));

/** Where a card sits while it waits, with its own preposition («in lavorazione», «in verifica»): the column names say «Da verificare», a sentence says «in verifica». allow-italian: quotes the words on screen */
/** What a person is asked for in the columns that wait for one («per la verifica»). allow-italian: quotes the words on screen */
const WAITS_FOR: Record<'verifica' | 'approvazione', string> = { verifica: 'la verifica', approvazione: "l'approvazione" }; // allow-italian: stage ids of the data, and the words said on screen

const STAY_IN: Record<StageId, string> = { arrivo: 'in arrivo', lavorazione: 'in lavorazione', verifica: 'in verifica', approvazione: 'in approvazione', fatto: 'chiusa' }; // allow-italian: stage ids of the data, and the words said on screen
const withoutDot = (s: string): string => s.replace(/[.\s]+$/, '');

/* ---------- the questions to suggest ---------- */

type Idea = 'stuck' | 'mine' | 'due' | 'contract' | 'flow';
const IDEAS: Idea[] = ['stuck', 'mine', 'due', 'contract', 'flow'];

/** The contract worth asking about: one that waits for a step, else the first. */
function contractToAsk(contracts: Contract[]): Contract | undefined {
  return contracts.find((c) => c.status !== 'attivo' && c.status !== 'scaduto') ?? contracts[0]; // allow-italian: status codes, compared by value
}

/** The flow with most open cards, the one most worth explaining. */
function flowToAsk(flows: OpsFlow[], cards: OrbitCard[]): OpsFlow | undefined {
  return [...flows].sort((a, b) => openCards(cards.filter((c) => c.flow === b.id)).length - openCards(cards.filter((c) => c.flow === a.id)).length)[0];
}

function questionFor(idea: Idea, env: AssistantEnv, scope: Scope): string | undefined {
  const e = env.copy.examples;
  if (idea === 'contract') {
    const c = contractToAsk(scope.contracts);
    return c ? e.contract(withoutNote(c.counterparty)) : undefined;
  }
  if (idea === 'flow') {
    const f = flowToAsk(scope.flows, scope.cards);
    return f ? e.flow(f.name) : undefined;
  }
  return e[idea];
}

/** Four questions to start a chat from, taken from this world. */
export function startQuestions(env: AssistantEnv): string[] {
  const scope = scopeOf(env);
  return (['stuck', 'mine', 'due', 'contract'] as Idea[]).map((i) => questionFor(i, env, scope)).filter((q): q is string => Boolean(q));
}

/** Questions to ask next, other than the idea just answered. */
function followUps(except: Idea | undefined, env: AssistantEnv, scope: Scope): string[] {
  return IDEAS.filter((i) => i !== except).map((i) => questionFor(i, env, scope)).filter((q): q is string => Boolean(q)).slice(0, 3);
}

/** The two questions the example chats of a new demo were asked: what is due, and how the busiest flow works (not what is stopped, which is the first suggestion a reader presses). */
export function exampleQuestions(env: AssistantEnv): string[] {
  const scope = scopeOf(env);
  return (['due', 'flow'] as Idea[]).map((i) => questionFor(i, env, scope)).filter((q): q is string => Boolean(q));
}

/** The name of the flow the example chat asks about. */
export function exampleFlowName(env: AssistantEnv): string | undefined {
  const scope = scopeOf(env);
  return flowToAsk(scope.flows, scope.cards)?.name;
}

type CardIdea = 'summary' | 'missing' | 'approver' | 'value';

/** The questions suggested in the chat of a card, all about that card. */
export function cardQuestions(card: OrbitCard, env: AssistantEnv): string[] {
  const q = env.copy.card.questions;
  const first = card.values[0];
  return [q.summary, q.missing, q.approver, ...(first ? [q.value(first.label)] : [])];
}

/* ---------- answers about a card ---------- */

function stepOf(card: OrbitCard): { flow?: OpsFlow; index: number } {
  const flow = opsFlowById(card.flow);
  const step = flow ? liveStep(card, flow) : undefined;
  return { flow, index: flow && step ? flow.steps.indexOf(step) : -1 };
}

function cardSummary(card: OrbitCard, env: AssistantEnv): ChatBlock[] {
  const r = env.copy.reply.summary;
  const { flow, index } = stepOf(card);
  const stage = stageOf(card);
  const open = isOpen(card);
  /* Where the card is, then what holds it (or who has it), then the move that comes next, in a few sentences. */
  const where: ChatSeg[] = flow && index >= 0 && open
    ? r.is(cardRef(card, env), stageInSentence(stage), flowRef(flow), index + 1, flow.steps.length, flow.steps[index].title)
    : flow ? r.isDone(cardRef(card, env), flowRef(flow)) : [cardRef(card, env)];
  const first: ChatSeg[] = [...where];
  if (open) {
    const age = stoppedAge(card, env.now);
    const person = (id: string) => withArticle(personName(id));
    const personOf = (id: string) => ofName(personName(id));
    if (card.blocked) first.push(' ', r.blocked(age, card.blocked.reason));
    else if (isStuck(card, world().opsFlows, env.now)) first.push(' ', r.stuck(age, STAY_IN[stage]));
    else if (stage === 'verifica') first.push(' ', r.waitsCheck(personOf(card.reviewer))); // allow-italian: stage id, compared by value
    else if (stage === 'approvazione') first.push(' ', r.waitsApprove(personOf(card.reviewer))); // allow-italian: stage id, compared by value
    else first.push(' ', r.worker(person(card.worker.kind === 'agent' ? `agent:${card.worker.id}` : card.worker.id), withoutDot(card.worker.doing)));
  }
  const next: string[] = [];
  if (open && card.proposal) next.push(env.copy.reply.summary.proposal(withoutDot(card.proposal)));
  if (open && card.due) next.push(r.due(formatShortDay(card.due), daysFromToday(card.due)));
  const low = card.values.filter((v) => v.confidence < LOW_CONFIDENCE).length;
  if (open && low) next.push(r.values(low));
  return next.length ? [text(...first), text(next.join(' '))] : [text(...first)];
}

function cardMissing(card: OrbitCard, env: AssistantEnv): ChatBlock[] {
  const r = env.copy.reply;
  const head = text(...r.about.missing(cardRef(card, env)));
  if (!isOpen(card)) return [head, text(r.missingDone)];
  const { flow, index } = stepOf(card);
  const now: ChatSeg[][] = [];
  if (card.blocked) now.push([r.missingStopped(card.blocked.reason, stoppedAge(card, env.now))]);
  else if (isStuck(card, world().opsFlows, env.now)) now.push([r.cardStopped(stoppedAge(card, env.now), r.stuckOver(STAY_IN[stageOf(card)], formatHours(flow?.stuckAfterHours ?? 0)))]);
  const stage = stageOf(card);
  if (stage === 'verifica' || stage === 'approvazione') now.push([r.approverNow(withArticle(personName(card.reviewer)), WAITS_FOR[stage])]); // allow-italian: stage ids, compared by value
  const low = card.values.filter((v) => v.confidence < LOW_CONFIDENCE).map((v) => `${v.label} (${v.confidence}%)`);
  if (low.length) now.push([r.missingLow(low)]);
  const ahead = flow && index >= 0 ? flow.steps.slice(index + 1) : [];
  const blocks: ChatBlock[] = [head];
  if (now.length) blocks.push(list(now));
  if (ahead.length) {
    blocks.push(text(r.missingSteps(ahead.length)));
    blocks.push(list(ahead.map((s) => [s.title, ' · ', actorName(s.actor, env.copy)])));
  } else blocks.push(text(r.missingNothing));
  return blocks;
}

function cardApprover(card: OrbitCard, env: AssistantEnv): ChatBlock[] {
  const r = env.copy.reply;
  const flow = opsFlowById(card.flow);
  const items: ChatSeg[][] = [];
  const stage = stageOf(card);
  if (stage === 'verifica' || stage === 'approvazione') items.push([r.approverNow(withArticle(personName(card.reviewer)), WAITS_FOR[stage])]); // allow-italian: stage ids, compared by value
  const personStep = (at: StageId) => flow?.steps.find((s) => s.stage === at && s.actor.kind === 'person');
  const check = personStep('verifica'); // allow-italian: stage id, compared by value
  const approve = personStep('approvazione'); // allow-italian: stage id, compared by value
  if (check && isOpen(card)) items.push([r.approverCheck(actorName(check.actor, env.copy), check.title)]);
  if (approve && isOpen(card)) items.push([r.approverApprove(actorName(approve.actor, env.copy), approve.title)]);
  if (!items.length) items.push([r.approverNone]);
  items.push([card.due && isOpen(card) ? r.approverDue(formatShortDay(card.due), daysFromToday(card.due)) : r.approverNoDue]);
  return [text(...r.about.approver(cardRef(card, env))), list(items)];
}

function cardValues(card: OrbitCard, question: string, env: AssistantEnv): ChatBlock[] {
  const r = env.copy.reply;
  const head = text(...r.about.value(cardRef(card, env)));
  if (!card.values.length) return [head, text(r.valuesNone)];
  const asked = ` ${stemmed(question)} `;
  const hit = card.values.find((v) => asked.includes(` ${stemmed(v.label)} `));
  if (hit) {
    const doc = card.originals.find((o) => o.id === hit.doc);
    const from: ChatSeg[] = doc ? r.valueFrom({ kind: 'document', id: doc.id, label: doc.name, path: SP.cardOriginal(card.id, doc.id) }) : [];
    return [head, text(r.valueIs(hit.label, hit.value, hit.confidence)), { kind: 'quote', text: hit.quote, from }];
  }
  return [head, text(r.valuesIntro(card.values.length)), list(card.values.map((v) => [{ strong: v.label }, `: ${v.value} · ${v.confidence}%`]))];
}

function pickCardIdea(question: string, card: OrbitCard, env: AssistantEnv): CardIdea | undefined {
  const asked = ` ${stemmed(question)} `;
  if (asks(question, env.copy, 'value') || card.values.some((v) => asked.includes(` ${stemmed(v.label)} `))) return 'value';
  if (asks(question, env.copy, 'approver')) return 'approver';
  if (asks(question, env.copy, 'missing')) return 'missing';
  if (asks(question, env.copy, 'summary')) return 'summary';
  return undefined;
}

function cardAnswer(card: OrbitCard, idea: CardIdea, question: string, env: AssistantEnv): ChatBlock[] {
  switch (idea) {
    case 'summary': return cardSummary(card, env);
    case 'missing': return cardMissing(card, env);
    case 'approver': return cardApprover(card, env);
    case 'value': return cardValues(card, question, env);
  }
}

/* ---------- lists across the work ---------- */

interface Filters {
  flow?: OpsFlow;
  town?: OrbitTown;
  who?: Persona;
}

function filtered(cards: OrbitCard[], f: Filters): OrbitCard[] {
  return cards.filter((c) => (!f.flow || c.flow === f.flow.id) && (!f.town || townOfPlace(c.place)?.id === f.town.id));
}

function scopeText(f: Filters, copy: ChatCopy): string | undefined {
  if (f.flow) return copy.reply.scope.flow(f.flow.name);
  if (f.town) return copy.reply.scope.town(withoutNote(f.town.name));
  return undefined;
}

function stuckAnswer(scope: Scope, f: Filters, env: AssistantEnv): ChatBlock[] {
  const r = env.copy.reply;
  const stuck = filtered(scope.cards, f)
    .filter((c) => isOpen(c) && isStuck(c, world().opsFlows, env.now))
    .sort((a, b) => stoppedSince(a).localeCompare(stoppedSince(b)));
  const where = scopeText(f, env.copy);
  if (!stuck.length) return [text(r.stuckNone(where))];
  const items = stuck.map((c): ChatSeg[] => {
    const limit = formatHours(opsFlowById(c.flow)?.stuckAfterHours ?? 0);
    return [cardRef(c, env), ' · ', r.stuckSince(stoppedAge(c, env.now)), ' · ', c.blocked?.reason ?? r.stuckOver(STAY_IN[stageOf(c)], limit)];
  });
  return [text(r.stuckIntro(stuck.length, where)), ...capped(items, env.copy, { ...CARDS_LINK, path: LIST_STUCK_PATH })];
}

function whatOf(d: ContractDate, copy: ChatCopy): string {
  return d.kind === 'end' ? copy.reply.dateKind.end : d.kind === 'notice' ? copy.reply.dateKind.notice : d.obligation?.what ?? '';
}

function dueAnswer(scope: Scope, f: Filters, env: AssistantEnv): ChatBlock[] {
  const r = env.copy.reply;
  const end = addDays(DEMO_TODAY, WEEK);
  const due = filtered(scope.cards, f)
    .filter((c) => isOpen(c) && c.due && c.due <= end)
    .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
  const late = due.filter((c) => daysFromToday(c.due as string) < 0);
  const soon = due.filter((c) => daysFromToday(c.due as string) >= 0);
  const where = scopeText(f, env.copy);
  const line = (c: OrbitCard): ChatSeg[] => [cardRef(c, env), ' · ', r.dueLine(daysFromToday(c.due as string), formatShortDay(c.due as string))];
  const dates = f.flow || f.town
    ? []
    : contractDates(scope.contracts).filter((d) => !d.done && d.day >= DEMO_TODAY && d.day <= end).sort((a, b) => a.day.localeCompare(b.day));
  const blocks: ChatBlock[] = [];
  if (!soon.length && !dates.length) blocks.push(text(r.dueNone(formatShortDay(end), where)));
  if (late.length) blocks.push(text(r.overdueIntro(late.length)), ...capped(late.map(line), env.copy, CARDS_LINK));
  if (soon.length) blocks.push(text(r.dueIntro(soon.length, formatShortDay(end), where)), ...capped(soon.map(line), env.copy, CARDS_LINK));
  if (dates.length) {
    blocks.push(text(r.contractDatesIntro(dates.length)));
    blocks.push(...capped(dates.map((d): ChatSeg[] => [contractRef(d.contract), ' · ', whatOf(d, env.copy), ' · ', r.dueLine(daysTo(d.day), dayLabel(d.day))]), env.copy, CONTRACTS_LINK));
  }
  return blocks;
}

function mineAnswer(scope: Scope, f: Filters, env: AssistantEnv): ChatBlock[] {
  const r = env.copy.reply;
  const who = f.who ?? env.persona;
  const other = who.id !== env.persona.id ? withArticle(personName(who.id)) : undefined;
  const cards = waitingFor(filtered(scope.cards, f), who.id).sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9'));
  const contracts = scope.contracts.filter((c) => c.approvals.some((a) => a.who === who.id && a.state === 'in-attesa')); // allow-italian: state code, compared by value
  if (!cards.length && !contracts.length) return [text(r.mineNone(other))];
  const blocks: ChatBlock[] = [];
  if (cards.length) {
    blocks.push(text(r.mineIntro(cards.length, other)));
    blocks.push(...capped(cards.map((c): ChatSeg[] => [cardRef(c, env), ' · ', stageLabel(stageOf(c)), ...(c.due ? [' · ', r.dueLine(daysFromToday(c.due), formatShortDay(c.due))] : [])]), env.copy, CARDS_LINK));
  }
  if (contracts.length) {
    blocks.push(text(r.contractsWaiting(contracts.length, other)));
    blocks.push(...capped(contracts.map((c): ChatSeg[] => {
      const step = c.approvals.find((a) => a.who === who.id && a.state === 'in-attesa'); // allow-italian: state code, compared by value
      return [contractRef(c), ' · ', step ? actionLabel[step.action] : ''];
    }), env.copy, CONTRACTS_LINK));
  }
  return blocks;
}

/* ---------- contracts, flows, towns ---------- */

function contractAnswer(found: Contract[], scope: Scope, env: AssistantEnv): ChatBlock[] {
  const r = env.copy.reply;
  if (found.length > 1) return [text(r.contractMany(found.length)), ...capped(found.map((c): ChatSeg[] => [contractRef(c), ' · ', statusLabel[c.status]]), env.copy, CONTRACTS_LINK)];
  const c = found[0];
  const items: ChatSeg[][] = [[r.contractValue(formatMoney(currentValue(c)), c.valuePeriod)]];
  const notice = noticeDate(c);
  if (c.renewal.kind === 'nessuno' || !notice) items.push([r.renewal.none]); // allow-italian: data code, compared by value
  else if (c.renewal.kind === 'tacito') items.push([r.renewal.tacit(c.renewal.months, dayLabel(notice), daysTo(notice))]); // allow-italian: data code, compared by value
  else items.push([r.renewal.option(c.renewal.months, dayLabel(notice), daysTo(notice))]);
  const next = contractDates([c]).filter((d) => !d.done && d.day >= DEMO_TODAY).sort((a, b) => a.day.localeCompare(b.day))[0];
  items.push([next ? r.nextDate(whatOf(next, env.copy), dayLabel(next.day), daysTo(next.day)) : r.nothingAhead]);
  const waiting = c.approvals.find((a) => a.state === 'in-attesa'); // allow-italian: state code, compared by value
  if (waiting) items.push([r.waitsFor(withArticle(personName(waiting.who)), actionLabel[waiting.action].toLowerCase())]);
  for (const v of c.variants.filter((x) => x.status === 'in-corso')) items.push([r.variant(v.title)]); // allow-italian: status code, compared by value
  const blocks: ChatBlock[] = [text(...r.contractHead(contractRef(c), statusLabel[c.status], withoutNote(c.counterparty), formatDay(c.start), c.end ? formatDay(c.end) : undefined)), list(items)];
  const linked = scope.cards.filter((x) => c.links.cards.includes(x.id) && isOpen(x)).slice(0, 4);
  if (linked.length) blocks.push(text(r.linkedCards, ' ', ...linked.map((x) => cardRef(x, env))));
  return blocks;
}

function contractsOverview(scope: Scope, env: AssistantEnv): ChatBlock[] {
  const r = env.copy.reply;
  const ordered = [...scope.contracts].sort((a, b) => Number(a.status === 'attivo') - Number(b.status === 'attivo')); // allow-italian: status code, compared by value
  return [text(r.contractsIntro(ordered.length)), ...capped(ordered.map((c): ChatSeg[] => [contractRef(c), ' · ', statusLabel[c.status]]), env.copy, CONTRACTS_LINK)];
}

function flowAnswer(flow: OpsFlow, scope: Scope, env: AssistantEnv): ChatBlock[] {
  const r = env.copy.reply;
  const cards = scope.cards.filter((c) => c.flow === flow.id);
  const open = openCards(cards);
  const stopped = open.filter((c) => isStuck(c, world().opsFlows, env.now));
  const facts: ChatSeg[][] = [[r.flowFrom(flow.source)]];
  if (flow.outcome) facts.push([r.flowGives(flow.outcome)]);
  facts.push([r.flowNow(open.length, stopped.length)]);
  const blocks: ChatBlock[] = [text(...r.flowHead(flowRef(flow), flow.trigger)), list(facts)];
  blocks.push(text(r.flowSteps(flow.steps.length)));
  blocks.push(list(flow.steps.map((s, i): ChatSeg[] => [`${i + 1}. ${s.title}`, ' · ', actorName(s.actor, env.copy)])));
  const shown = [...stopped, ...open.filter((c) => !stopped.includes(c))].slice(0, 4);
  if (shown.length) blocks.push(text(r.linkedCards, ' ', ...shown.map((c) => cardRef(c, env))));
  return blocks;
}

function flowsOverview(scope: Scope, env: AssistantEnv): ChatBlock[] {
  const r = env.copy.reply;
  return [text(r.flowsIntro(scope.flows.length)), ...capped(scope.flows.map((f): ChatSeg[] => [flowRef(f), ...(f.outcome ? [' · ', f.outcome] : [])]), env.copy, FLOWS_LINK)];
}

function townAnswer(town: OrbitTown, scope: Scope, env: AssistantEnv): ChatBlock[] {
  const r = env.copy.reply;
  const name = withoutNote(town.name);
  const cards = filtered(scope.cards, { town }).filter(isOpen);
  const contracts = scope.contracts.filter((c) => ` ${stemmed(c.counterparty)} `.includes(` ${stemmed(name)} `));
  const blocks: ChatBlock[] = cards.length
    ? [text(r.townIntro(name, cards.length)), ...capped(cards.map((c): ChatSeg[] => [cardRef(c, env)]), env.copy, CARDS_LINK)]
    : [text(r.townNone(name))];
  if (contracts.length) blocks.push(text(r.townContracts(name), ' ', ...contracts.map(contractRef)));
  return blocks;
}

function unknownAnswer(env: AssistantEnv, examples: string[]): ChatReply {
  const r = env.copy.reply;
  return { blocks: [text(r.unknownIntro(world().name)), list(r.abilities.map((a): ChatSeg[] => [a])), text(r.unknownTry)], examples };
}

/* ---------- the answer ---------- */

/** What the chat answers to one question. `card` is the card the chat belongs to, when it is the chat of a card. */
export function answer(question: string, env: AssistantEnv, card?: OrbitCard): ChatReply {
  const copy = env.copy;
  const scope = scopeOf(env);
  const framed = ` ${norm(question)} `;
  const namedCard = scope.cards.find((c) => framed.includes(` ${c.id.toLowerCase()} `));
  const target = namedCard ?? card;

  /* A card named, or the card the chat belongs to: its summary, what is missing, who approves, what the original says. */
  if (target) {
    const idea = pickCardIdea(question, target, env) ?? (namedCard ? 'summary' : undefined);
    if (idea) {
      const asked = idea === 'value' ? undefined : copy.card.questions[idea];
      return { blocks: cardAnswer(target, idea, question, env), examples: cardQuestions(target, env).filter((q) => q !== asked).slice(0, 3) };
    }
  }

  const contracts = named(question, scope.contracts, (c) => [c.title, c.counterparty, c.id], asks(question, copy, 'contract') && copy.words.contract);
  const flows = named(question, scope.flows, (f) => [f.name, f.id], asks(question, copy, 'flow') && copy.words.flow);
  const towns = named(question, world().towns, (t) => [t.name.split(' (')[0], t.place ?? ''], false);
  const persons = named(question, world().people.personas, (p) => [p.short, p.name], false);
  const filters: Filters = { flow: flows[0], town: towns[0], who: persons[0] };
  const examples = (except: Idea | undefined): string[] => (card ? cardQuestions(card, env).slice(0, 3) : followUps(except, env, scope));

  if (asks(question, copy, 'mine')) return { blocks: mineAnswer(scope, filters, env), examples: examples('mine') };
  if (asks(question, copy, 'stuck')) return { blocks: stuckAnswer(scope, filters, env), examples: examples('stuck') };
  if (asks(question, copy, 'due') && !contracts.length) return { blocks: dueAnswer(scope, filters, env), examples: examples('due') };
  if (contracts.length) return { blocks: contractAnswer(contracts, scope, env), examples: examples('contract') };
  if (flows.length) return { blocks: flowAnswer(flows[0], scope, env), examples: examples('flow') };
  if (towns.length) return { blocks: townAnswer(towns[0], scope, env), examples: examples(undefined) };
  if (persons.length) return { blocks: mineAnswer(scope, filters, env), examples: examples('mine') };
  if (asks(question, copy, 'contract') && scope.contracts.length) return { blocks: contractsOverview(scope, env), examples: examples('contract') };
  if (asks(question, copy, 'flow') && scope.flows.length) return { blocks: flowsOverview(scope, env), examples: examples('flow') };
  return unknownAnswer(env, card ? cardQuestions(card, env).slice(0, 3) : startQuestions(env).slice(0, 3));
}
