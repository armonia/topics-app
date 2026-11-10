/**
 * The places of the `views-more` area: the saved views and the catalogue of
 * blocks (a01), the parcel on the map (a02), the CAD sheet (a03), the
 * presentation (a04), where a view opens (a05) and the channels (ch01).
 * Each place is drawn by a file in `views-more/`; this one declares where they
 * are, who may open them and what search can find.
 */
import { Eye, Presentation } from 'lucide-react';
import type { AreaModule, ScreenCtx, ScreenDef, SearchEntry } from '../kit';
import { P } from '../paths';
import { BLOCK_IDS } from '../../../ui/fixtures/views';
import { CHANNELS } from '../../../ui/fixtures/channels';
import { CHANNEL_ICON } from '../../../ui/channels/channelIcons';
import { renderViewsList } from './views-more/list';
import { renderParcel } from './views-more/parcel';
import { renderCad } from './views-more/cad';
import { renderDeck } from './views-more/deck';
import { deckCaseId } from './views-more/slides';
import { renderWhere } from './views-more/where';
import { renderChannels } from './views-more/channels';
import {
  cadCases, deckIdFor, entryOf, openPath, parcelCases, sampleCadId, viewEntries, VIEWS_INITIAL, viewName, type ViewsState,
} from './views-more/shared';

const channelName = (id: string) => CHANNELS.find((c) => c.id === id)?.name ?? id;

const parcelSamples = () => {
  const ids = [...new Set(['2418', ...parcelCases().map((c) => c.id)])];
  return ids.slice(0, 4).map((id) => P.parcel(id));
};

const screens: ScreenDef[] = [
  {
    id: 'a01', path: '/viste', org: 'nocera', nav: 'views', needs: 'view:views', samples: [P.views()],
    title: (_p, ctx) => ctx.copy.views.root,
    render: (_p, ctx) => renderViewsList(ctx),
  },
  {
    id: 'a02', path: '/viste/particella/:record', org: 'nocera', nav: 'views', needs: 'view:views', samples: parcelSamples(),
    title: (p) => `${viewName('particella')} · ${p.record}`,
    render: (p, ctx) => renderParcel({ record: p.record }, ctx),
  },
  {
    id: 'a03', path: '/viste/tavola/:record', org: 'nocera', nav: 'views', needs: 'view:views', samples: [P.cad(sampleCadId()), ...cadCases().slice(1, 2).map((c) => P.cad(c.id))],
    title: (p) => `${viewName('tavola')} · ${p.record}`,
    render: (p, ctx) => renderCad({ record: p.record }, ctx),
  },
  {
    id: 'a04', path: '/viste/presentazione/:id', org: 'nocera', nav: 'views', needs: 'view:views', samples: [P.presentation(deckIdFor('2418'))],
    title: (p, ctx) => `${ctx.copy.viewsMore.deck.crumb('')} · ${deckCaseId(p.id)}`,
    render: (p, ctx) => renderDeck({ id: p.id }, ctx),
  },
  {
    id: 'a05', path: '/viste/dove/:view', org: 'nocera', nav: 'views', needs: 'view:views',
    samples: ['particella', 'tavola', 'presentazione', 'fattura-ordine', 'conferma-originali'].map((v) => P.viewWhere(v)),
    title: (p, ctx) => `${entryOf(readViews(ctx), p.view)?.name ?? p.view} · ${ctx.copy.viewsMore.where.crumb}`,
    render: (p, ctx) => renderWhere({ view: p.view }, ctx),
  },
  {
    id: 'ch01', path: '/canali', org: 'nocera', nav: 'channels', needs: 'view:channels', samples: [P.channels(), P.channels('pec'), P.channels('whatsapp'), P.channels('send')],
    title: (_p, ctx) => ctx.copy.shell.nav.channels,
    render: (_p, ctx) => renderChannels({}, ctx),
  },
  {
    id: 'ch01', path: '/canali/:channel', org: 'nocera', nav: 'channels', needs: 'view:channels', samples: [P.channels('pec'), P.channels('telefono')],
    title: (p, ctx) => `${ctx.copy.shell.nav.channels} · ${channelName(p.channel)}`,
    render: (p, ctx) => renderChannels({ channel: p.channel }, ctx),
  },
];

/** The views as the reader has them now, for titles and search. */
function readViews(ctx: ScreenCtx): ViewsState {
  return (ctx.state.slices.views as ViewsState | undefined) ?? VIEWS_INITIAL;
}

function search(ctx: ScreenCtx): SearchEntry[] {
  const v = ctx.copy.viewsMore;
  const views = viewEntries(readViews(ctx)).filter((e) => e.adopted).map((e): SearchEntry => ({
    id: `view-${e.id}`,
    group: v.search.views,
    title: e.name,
    detail: e.description,
    keywords: e.blocks.map((b) => v.blocks[b].name).join(' '),
    path: openPath(e),
    icon: e.blocks.includes('slides') ? Presentation : Eye,
    needs: 'view:views',
  }));
  const blocks = BLOCK_IDS.map((b): SearchEntry => ({
    id: `block-${b}`,
    group: v.search.blocks,
    title: v.blocks[b].name,
    detail: v.blocks[b].shows,
    path: P.views(),
    icon: Eye,
    needs: 'view:views',
  }));
  const channels = CHANNELS.map((c): SearchEntry => ({
    id: `channel-${c.id}`,
    group: v.search.channels,
    title: c.name,
    detail: `${c.provider} · ${c.address}`,
    keywords: c.policy,
    path: P.channels(c.id),
    icon: CHANNEL_ICON[c.id],
    needs: 'view:channels',
  }));
  return [...views, ...blocks, ...channels];
}

export const VIEWS_AREA: AreaModule = { screens, search };
