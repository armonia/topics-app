/**
 * ORBIT edition, area `inbox`: «Da fare» (allow-italian: quotes the Italian interface), the landing page of
 * the app, as one list of cards grouped by flow (first), the same cards on a
 * kanban and per stage, a card, and one of its originals large (addresses in
 * `../paths.ts`). Which flow or stage is on show is a filter, not an address.
 * What the old day page showed (what waits for the person, what is due, what
 * is stopped, what the agents hold) is four saved filters of the list. The
 * wiring is in `inbox/`; the components are in `client/src/ui/kanban/`.
 */
import type { AreaModule, Params, ScreenCtx, ScreenDef } from '../../app/kit';
import { waitingFor } from '../model/live';
import { SP } from '../paths';
import { cardTitle, originalTitle, renderCard, renderOriginal } from './inbox/card';
import { visibleCards } from './inbox/model';
import { KanbanScreen, ListScreen, StagesScreen } from './inbox/views';
import { world } from '../world';

/** The tab of the lists of «Da fare» counts what waits for the person, like the sidebar; a tab of a card does not carry that count, it is not about the card. (allow-italian: quotes the Italian interface) */
const tab = (_p: Params, ctx: ScreenCtx) => {
  const n = waitingFor(visibleCards(ctx.state, ctx.persona), ctx.persona.id).length;
  return { count: n || undefined };
};

const title = (_p: Params, ctx: ScreenCtx) => ctx.copy.kanban.title;

const SCREENS: ScreenDef[] = [
  {
    id: 'orbit-list', path: '/da-fare', org: world().key, nav: 'inbox', needs: 'view:inbox', tab,
    samples: [SP.inbox()],
    title,
    render: (_p, ctx) => <ListScreen ctx={ctx} />,
  },
  {
    id: 'orbit-kanban', path: '/da-fare/kanban', org: world().key, nav: 'inbox', needs: 'view:inbox', tab,
    samples: [SP.inboxKanban()],
    title,
    render: (_p, ctx) => <KanbanScreen ctx={ctx} />,
  },
  {
    id: 'orbit-stages', path: '/da-fare/per-stato', org: world().key, nav: 'inbox', needs: 'view:inbox', tab,
    samples: [SP.inboxStages()],
    title,
    render: (_p, ctx) => <StagesScreen ctx={ctx} />,
  },
  {
    id: 'orbit-card', path: '/da-fare/card/:card', org: world().key, nav: 'inbox', needs: 'view:inbox',
    samples: world().samples.cards.map((id) => SP.card(id)),
    paneKey: (p) => `card:${p.card}`,
    title: cardTitle,
    render: (p, ctx) => renderCard(p, ctx),
  },
  {
    id: 'orbit-card-flow', path: '/da-fare/card/:card/flusso', org: world().key, nav: 'inbox', needs: 'view:inbox',
    samples: world().samples.cards.map((id) => SP.cardFlow(id)),
    paneKey: (p) => `card:${p.card}`,
    title: cardTitle,
    render: (p, ctx) => renderCard(p, ctx, { flow: true }),
  },
  {
    id: 'orbit-card-original', path: '/da-fare/card/:card/originale/:doc', org: world().key, nav: 'inbox', needs: 'view:inbox',
    samples: world().samples.cardOriginals.map(([card, doc]) => SP.cardOriginal(card, doc)),
    title: originalTitle,
    render: (p, ctx) => renderOriginal(p, ctx),
  },
];

/* What search finds among the cards is in `../search.ts`, with everything else the edition can find. */
export const ORBIT_INBOX_AREA: AreaModule = { screens: SCREENS };
