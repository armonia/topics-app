/**
 * The log of the ORBIT edition: what the world already holds (every column a
 * card entered and who moved it there, every approval step done on a
 * contract, every version written, the connection events of the programs)
 * from 30 days before the demo's today, then every action of this visit
 * (`state.audit`). Oldest first, each line with a fingerprint chained to the
 * one before.
 *
 * Settings > Log draws all of it; a person's or an agent's page draws their
 * own lines. One function, so the two never disagree.
 */
import type { OrbitAdminCopy } from '../../../ui/copy/orbit-admin';
import type { LogActorModel } from '../../../ui/team/model';
import { agentById, personaById, world } from '../world';
import { DEMO_TODAY, addDays } from '../../../ui/fixtures/org/clock';
import type { AuditEntry, DemoState } from '../../app/store/state';
import { chainOf, type ChainLine } from '../../app/screens/team/chain';
import { actionLabel } from './contracts';
import { SP } from '../paths';

export interface OrbitLogLine extends ChainLine {
  id: string;
  /** A persona id, `agent:<id>` or `program:<id>`. */
  actorId: string;
  actor: LogActorModel;
  kind: AuditEntry['kind'];
  path: string;
  /** Written in this visit of the preview. */
  live: boolean;
  hash: string;
}

/** How the log names whoever did it: a person, an agent of Topics, a program. */
export function actorOf(id: string): LogActorModel {
  const person = personaById(id);
  if (person) return { kind: 'person', label: person.short, monogram: person.monogram, color: person.color };
  if (id.startsWith('agent:')) {
    const agent = agentById(id.slice(6));
    return { kind: 'ai', label: agent?.name ?? id.slice(6) };
  }
  if (id.startsWith('program:')) {
    const program = world().programs.find((p) => p.id === id.slice(8));
    return { kind: 'robot', label: program?.name ?? id.slice(8) };
  }
  return { kind: 'system', label: id };
}

/** The first day the log keeps (30 days before the demo's today). */
export const LOG_FROM = addDays(DEMO_TODAY, -30);

type Seed = Omit<OrbitLogLine, 'hash' | 'actor'>;

function seedLines(words: OrbitAdminCopy['log']): Seed[] {
  const out: Seed[] = [];
  const stageLabel = (id: string) => world().stages.find((s) => s.id === id)?.label ?? id;

  for (const card of world().cards) {
    card.history.forEach((e, i) => {
      const what = e.stage === 'fatto' ? words.cardClosed : i === 0 ? words.cardArrived(stageLabel(e.stage)) : words.cardMoved(stageLabel(e.stage)); // allow-italian: stage id, compared by value
      out.push({
        id: `card-${card.id}-${i}`, at: e.at, who: e.by, actorId: e.by, what,
        subject: `${card.id} · ${card.title}`, detail: card.detail, kind: 'case', path: SP.card(card.id), live: false,
      });
    });
  }

  for (const c of world().contracts) {
    for (const s of c.approvals) {
      if (s.state !== 'fatto' || !s.at) continue; // allow-italian: state id, compared by value
      out.push({
        id: `contract-${c.id}-${s.id}`, at: s.at, who: s.who, actorId: s.who, what: words.contractStep(actionLabel[s.action]),
        subject: c.title, detail: s.note ?? '', kind: 'case', path: SP.signatures(c.id), live: false,
      });
    }
    for (const v of c.versions) {
      out.push({
        id: `version-${c.id}-${v.n}`, at: v.at, who: v.author, actorId: v.author, what: words.version(v.n),
        subject: c.title, detail: v.reason, kind: 'case', path: SP.versions(c.id), live: false,
      });
    }
  }

  for (const p of world().programs) {
    p.history.forEach((h, i) => {
      out.push({
        id: `program-${p.id}-${i}`, at: h.at, who: h.who, actorId: h.who, what: h.what,
        subject: p.name, detail: '', kind: h.kind === 'test' ? 'test' : h.kind === 'read' ? 'access' : h.kind === 'use' ? 'case' : 'structure',
        path: SP.program(p.id), live: false,
      });
    });
  }

  return out.filter((l) => l.at.slice(0, 10) >= LOG_FROM);
}

/** Every line, oldest first, each with its fingerprint. */
export function orbitLogLines(audit: AuditEntry[], words: OrbitAdminCopy['log']): OrbitLogLine[] {
  const seed = seedLines(words).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const live: Seed[] = [...audit].reverse().map((a) => ({
    id: a.id, at: a.at, who: a.who, actorId: a.who, what: a.what, subject: '', detail: '', kind: a.kind, path: a.path ?? SP.settings('registro'), live: true,
  }));
  const lines = [...seed, ...live];
  const hashes = chainOf(lines);
  return lines.map((l, i) => ({ ...l, actor: actorOf(l.actorId), hash: hashes[i] }));
}

/** The lines of one actor, newest first. */
export function linesOf(state: DemoState, words: OrbitAdminCopy['log'], actorId: string): OrbitLogLine[] {
  return orbitLogLines(state.audit, words).filter((l) => l.actorId === actorId).reverse();
}
