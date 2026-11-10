/**
 * The page of an organization with no surfaces of its own in the preview:
 * Armonia (who configures and assists the others) and Euro Impianti (starting,
 * no flows yet). Who it is, its cards on the Board, its people, and for
 * Armonia the flows it configures or for Euro Impianti the way to the first one.
 */
import { Workflow } from 'lucide-react';
import { Button } from '../../../../ui/primitives/Button';
import { Card } from '../../../../ui/primitives/Card';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { OrgPage } from '../../../../ui/board/OrgPage';
import { ORG_SUMMARY } from '../../../../ui/fixtures/board';
import { liveFlowCount } from '../../sidebar';
import { ORGS, PERSONAS, ROLES } from '../../../../ui/fixtures/org/people';
import type { OrgKey } from '../../../../ui/fixtures/org/types';
import { FOCUS_RING, pressable } from '../../../../ui/shell/pressable';
import type { Tone } from '../../../../ui/types';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { BOARD_INITIAL, boardItems, type BoardSlice } from './board-model';
import type { BoardColumnId } from '../../../../ui/board/model';

const COLUMN_TONE: Record<BoardColumnId, Tone> = { backlog: 'neutral', todo: 'neutral', progress: 'blue', review: 'red', done: 'green' };

export const orgName = (org: OrgKey) => ORGS.find((o) => o.id === org)?.name ?? org;

export function renderOrgPage(org: 'armonia' | 'euro', ctx: ScreenCtx) {
  const p = ctx.copy.orgs.page;
  const def = ORGS.find((o) => o.id === org)!;
  const [slice] = ctx.slice<BoardSlice>('board', BOARD_INITIAL);
  const items = boardItems(ctx.state, ctx.persona, slice, ctx.copy).filter((i) => i.org === org);
  const cards = items.filter((i) => i.column !== 'done').slice(0, 5).map((i) => ({
    id: i.id,
    title: i.title,
    column: ctx.copy.orgs.board.columns[i.column],
    tone: COLUMN_TONE[i.column],
    onOpen: () => ctx.go(i.path ?? P.board(org)),
  }));
  const members = PERSONAS.filter((x) => x.orgs.includes(org)).map((x) => ({
    id: x.id,
    name: x.name,
    monogram: x.monogram,
    color: x.color,
    role: ROLES.find((r) => r.id === x.role)?.label ?? x.role,
    onOpen: () => ctx.go(P.settings('squadra')),
  }));
  const summary = ORG_SUMMARY[org] ?? p.startingSummary;

  let extra;
  if (org === 'euro') {
    extra = (
      <Card icon={Workflow} title={p.flowsTitle}>
        <EmptyState className="!min-h-0 py-6" title={p.startingTitle} action={<Button variant="primary" onClick={ctx.allow('edit:structure', () => ctx.go(P.flowNew()))} title={ctx.deniedTitle('edit:structure')}>{p.startFromTemplate}</Button>}>
          {p.startingBody}
        </EmptyState>
      </Card>
    );
  } else {
    const clients: Array<{ id: OrgKey; to: string }> = [{ id: 'nocera', to: P.flows() }, { id: 'sarim', to: P.sarimFlows() }];
    extra = (
      <Card icon={Workflow} title={p.configuresTitle}>
        <ul className="-mx-1.5 flex flex-col">
          {clients.filter((c) => ctx.persona.orgs.includes(c.id)).map((c) => {
            // The sidebar's own counter, so the numbers add up to its total.
            const count = liveFlowCount(c.id);
            return (
              <li key={c.id}>
                <div {...pressable(() => ctx.go(c.to))} role="button" className={`flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-app-hover ${FOCUS_RING}`}>
                  <span className="min-w-0 flex-1 truncate text-prose text-app-text">{orgName(c.id)}</span>
                  <span className="shrink-0 text-compact text-app-text-tertiary">{p.activeFlows(count)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    );
  }
  return (
    <OrgPage
      name={def.name}
      monogram={def.monogram}
      color={def.color}
      summary={summary}
      cards={cards}
      cardCount={items.length}
      onOpenBoard={() => ctx.go(P.board(org))}
      members={members}
      copy={ctx.copy}
    >
      {extra}
    </OrgPage>
  );
}
