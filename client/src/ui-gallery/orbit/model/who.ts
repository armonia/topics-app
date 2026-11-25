/**
 * Who and when, as the ORBIT screens print them: a person, an agent or a
 * program as the chip of `ui/orbit/WorkParts`, and a moment of the demo said
 * the short way (`oggi 09:41`, `ieri 15:00`, `02/11 15:00`). One place, so «Da fare» (allow-italian: quotes the Italian interface)
 * and «Flussi» name the same actor and the same moment with the same words. (allow-italian: quotes the Italian interface)
 */
import type { UiCopy } from '../../../ui/copy/types';
import type { WorkActorModel } from '../../../ui/orbit/work-model';
import type { OpsFlowStep, Worker } from '../../../ui/fixtures/orbit-org/types';
import { agentById, personaById } from '../world';
import { addDays } from '../../../ui/fixtures/org/clock';

export function personActor(id: string): WorkActorModel {
  const p = personaById(id);
  return p ? { kind: 'person', name: p.short, monogram: p.monogram, color: p.color } : { kind: 'person', name: id, monogram: id.slice(0, 2).toUpperCase(), color: '#64748b' };
}

export function agentActor(id: string): WorkActorModel {
  return { kind: 'agent', name: agentById(id)?.name ?? id };
}

/** Who a history entry names: `agent:<id>` or a persona id. */
export function byActor(by: string): WorkActorModel {
  return by.startsWith('agent:') ? agentActor(by.slice(6)) : personActor(by);
}

export function workerActor(worker: Worker): WorkActorModel {
  return worker.kind === 'agent' ? agentActor(worker.id) : personActor(worker.id);
}

export function stepActor(actor: OpsFlowStep['actor'], copy: UiCopy): WorkActorModel {
  switch (actor.kind) {
    case 'rule': return { kind: 'rule', label: copy.orbitWork.flows.rule };
    case 'agent': return agentActor(actor.id);
    case 'program': return { kind: 'program', name: actor.name };
    case 'person': return personActor(actor.id);
  }
}

/** The name of an actor in a sentence. */
export function actorName(actor: WorkActorModel): string {
  return actor.kind === 'rule' ? actor.label : actor.name;
}

/** `09:41` of an ISO date-time, read as written (the demo writes Rome time). */
const timeOf = (iso: string) => iso.slice(11, 16);

/** `oggi 09:41`, `ieri 15:00`, `02/11 15:00`. (allow-italian: quotes the Italian interface) */
export function momentLabel(iso: string, now: string, copy: UiCopy): string {
  const day = iso.slice(0, 10);
  const today = now.slice(0, 10);
  if (day === today) return copy.orbitWork.todayAt(timeOf(iso));
  if (day === addDays(today, -1)) return copy.orbitWork.yesterdayAt(timeOf(iso));
  return `${day.slice(8, 10)}/${day.slice(5, 7)} ${timeOf(iso)}`;
}

/** Thousands with a dot, as Italian writes them: `1.412`. */
export function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
