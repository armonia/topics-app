/**
 * The lines of the log, in the order they happened: the month before the demo's
 * today (`SEED_LOG`) and then everything the reader did in the preview
 * (`state.audit`). The fingerprints chain through all of them.
 */
import { DEMO_TODAY, addDays } from '../../../../ui/fixtures/org/clock';
import { PERSONAS } from '../../../../ui/fixtures/org/people';
import { LOG_ACTORS, SEED_LOG, type SeedLogLine } from '../../../../ui/fixtures/team';
import type { LogActorModel } from '../../../../ui/team/model';
import { P } from '../../paths';
import type { AuditEntry } from '../../store/state';
import { chainOf, type ChainLine } from './chain';
import { bindUnits } from '../../../../ui/units';
import { romeIso } from './format';

export interface LogLine extends ChainLine {
  id: string;
  /** A persona id or a log actor id. */
  actorId: string;
  actor: LogActorModel;
  kind: AuditEntry['kind'];
  path: string;
  live: boolean;
  hash: string;
}

export function actorOf(id: string): LogActorModel {
  const person = PERSONAS.find((p) => p.id === id);
  if (person) return { kind: 'person', label: person.name, monogram: person.monogram, color: person.color };
  const other = LOG_ACTORS.find((a) => a.id === id);
  return other ? { kind: other.kind, label: other.label } : { kind: 'system', label: id };
}

function pathOf(to: SeedLogLine['to']): string {
  switch (to.kind) {
    case 'record': return P.record(to.id);
    case 'flowTest': return P.flowTest(to.id);
    case 'flow': return P.flow(to.id);
    case 'testAll': return P.testAll();
    case 'remote': return P.remoteControl();
    case 'knowledge': return P.knowledge();
    case 'settings': return P.settings(to.id);
  }
}

/** The month's seed, oldest first. */
function seedLines(): Omit<LogLine, 'hash'>[] {
  return SEED_LOG
    .map((l, i) => ({ l, i, at: romeIso(addDays(DEMO_TODAY, -l.day), l.time) }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || b.i - a.i)
    .map(({ l, i, at }) => ({
      id: `seed-${i}`,
      at,
      who: l.who,
      actorId: l.who,
      actor: actorOf(l.who),
      what: bindUnits(l.what),
      subject: bindUnits(l.subject ?? ''),
      detail: bindUnits(l.detail ?? ''),
      kind: l.kind,
      path: pathOf(l.to),
      live: false,
    }));
}

const SEED = seedLines();

/** Every line, oldest first, each with its fingerprint. */
export function allLines(audit: AuditEntry[]): LogLine[] {
  const live: Omit<LogLine, 'hash'>[] = [...audit].reverse().map((a) => ({
    id: a.id,
    at: a.at,
    who: a.who,
    actorId: a.who,
    actor: actorOf(a.who),
    what: bindUnits(a.what),
    subject: '',
    detail: '',
    kind: a.kind,
    path: a.path ?? P.settings('registro'),
    live: true,
  }));
  const lines = [...SEED, ...live];
  const hashes = chainOf(lines);
  return lines.map((l, i) => ({ ...l, hash: hashes[i] }));
}
