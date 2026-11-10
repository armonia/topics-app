import type { ScreenCtx } from '../../kit';
import { PERSONAS } from '../../../../ui/fixtures/org/people';
import type { MenuItemModel } from '../../../../ui/primitives/Menu';
import { rolePermissions } from '../../store/permissions';

/** The people a case can be handed to: the example people who work on data in its organization. */
export function assigneeItems(ctx: ScreenCtx, org: string, current: string): MenuItemModel[] {
  return PERSONAS
    .filter((p) => p.orgs.includes(org as never) && rolePermissions(ctx.state, p.role).has('edit:data'))
    .map((p) => ({ id: p.id, label: p.name, disabled: p.id === current, title: p.id === current ? ctx.copy.work.record.alreadyAssigned : undefined }));
}
