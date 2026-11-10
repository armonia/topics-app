/** The words of Squadra that several pages share: a team's name, a row and a cell of the permission matrix. */
import { teamById, world } from '../../world';
import type { ScreenCtx } from '../../../app/kit';
import type { AccessRow, AccessValue } from '../../model/access';
import { flowLabel } from '../../model/flows';

/** The name of a team by its id: a team of people or the agents. */
export function teamLabel(ctx: ScreenCtx, id: string): string {
  return id === world().people.agentsTeam.id ? ctx.copy.sarimTeam.agentsTeam : teamById(id)?.label ?? id;
}

/** The words of a row of the matrix: a section, a flow or an action. */
export function accessRowLabel(ctx: ScreenCtx, row: AccessRow): string {
  const p = ctx.copy.sarimTeam.permissions;
  return row.kind === 'section' ? p.sections[row.id] : row.kind === 'flow' ? flowLabel(row.id) : p.actions[row.id].label;
}

/** The words of what a cell holds: a level, or yes or no for an action. */
export function accessValueLabel(ctx: ScreenCtx, value: AccessValue): string {
  const c = ctx.copy.sarimTeam;
  return typeof value === 'boolean' ? (value ? c.permissions.yes : c.permissions.no) : c.levels[value].label;
}
