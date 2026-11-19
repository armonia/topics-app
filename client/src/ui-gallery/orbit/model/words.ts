/**
 * How the SARIM admin places (programs, team, settings) say a column, a
 * moment and a name: the tone and label of a stage, `oggi 10:25` for a time, (allow-italian: quotes the Italian interface)
 * the full name of a persona or agent id.
 */
import type { StageId } from '../../../ui/fixtures/sarim-org/types';
import { agentById, personaById, world } from '../world';
import type { Tone } from '../../../ui/types';
import type { ScreenCtx } from '../../app/kit';
import { whenLabel } from '../../app/screens/team/format';

export const STAGE_TONE: Record<StageId, Tone> = { arrivo: 'neutral', lavorazione: 'blue', verifica: 'amber', approvazione: 'violet', fatto: 'green' }; // allow-italian: stage ids of the data

export const stageLabel = (id: StageId) => world().stages.find((s) => s.id === id)?.label ?? id;

/** `oggi 10:25`, `ieri 17:20`, `02/11 08:30`. (allow-italian: quotes the Italian interface) */
export const when = (ctx: ScreenCtx, iso: string) => whenLabel(ctx.copy.team, iso, ctx.now);

/** The short name of the same ids (`Direttore gen.`), for a list where the full name would be cut. */
export function shortNameOf(id: string): string {
  const raw = id.startsWith('agent:') ? id.slice(6) : id;
  return personaById(raw)?.short ?? agentById(raw)?.name ?? raw;
}

/** The name of a persona id, `agent:<id>` or agent id, for a line of text. */
export function nameOf(id: string): string {
  const raw = id.startsWith('agent:') ? id.slice(6) : id;
  return personaById(raw)?.name ?? agentById(raw)?.name ?? raw;
}
