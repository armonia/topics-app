/**
 * The places of the `orgs` area: the Board of every organization (n17), the
 * direction overview (n18), ORBIT's flows, call center and overview (w07, s03,
 * s04), and the page of Armonia and of Alfa Impianti. See `../kit.ts` for the
 * contract; the wiring of each place is in `orgs/`.
 */
import { Building2, Headset, Kanban, Workflow } from 'lucide-react';
import { BOARD_TASKS } from '../../../ui/fixtures/board';
import { FLOWS } from '../../../ui/fixtures/org/flows';
import { ORGS } from '../../../ui/fixtures/org/people';
import { ORBIT_FLOWS } from '../../../ui/fixtures/orbit';
import type { AreaModule, ScreenCtx, ScreenDef, SearchEntry } from '../kit';
import { P } from '../paths';
import { BOARD_INITIAL, targetPath, type BoardSlice } from './orgs/board-model';
import { renderBoard } from './orgs/board';
import { renderOrgPage } from './orgs/org-page';
import { renderOverview } from './orgs/overview';
import { renderCallCenter } from './orgs/orbit-call-center';
import { renderOrbitFlow, renderOrbitFlows, orbitFlowTitle } from './orgs/orbit-flows';
import { renderOrbitOverview } from './orgs/orbit-overview';
import { ORBIT_INITIAL, findCall, findItem, type OrbitState } from './orgs/orbit-state';

const boardTitle = (_p: unknown, ctx: ScreenCtx) => ctx.copy.orgs.board.title;
const boardSamples = [P.board(), P.board('orbit'), P.board('armonia'), P.board('euro')];

const callTitle = (p: Record<string, string>, ctx: ScreenCtx) => {
  const c = ctx.copy.orgs.callCenter;
  if (!p.call) return ctx.copy.shell.nav.callcenter;
  const [st] = ctx.slice<OrbitState>('orbit', ORBIT_INITIAL);
  return findItem(st, p.call)?.title ?? findCall(p.call)?.caller ?? c.notFound;
};

const SCREENS: ScreenDef[] = [
  {
    id: 'n17', path: '/board', org: 'nocera', nav: 'board', needs: 'view:board', samples: boardSamples,
    title: boardTitle,
    render: (p, ctx) => renderBoard(p, ctx),
  },
  {
    id: 'n17', path: '/board/:org', org: 'nocera', nav: 'board', needs: 'view:board', samples: boardSamples,
    title: boardTitle,
    render: (p, ctx) => renderBoard(p, ctx),
  },
  {
    id: 'n18', path: '/panoramica', org: 'nocera', nav: 'overview', needs: 'view:overview', samples: [P.overview()],
    title: (_p, ctx) => ctx.copy.overview.title,
    render: (_p, ctx) => renderOverview(ctx),
  },
  {
    id: 'n01', path: '/orbit/flussi', org: 'orbit', nav: 'flows', needs: 'view:flows', samples: [P.orbitFlows()],
    title: (_p, ctx) => ctx.copy.flows.root,
    render: (_p, ctx) => renderOrbitFlows(ctx),
  },
  {
    id: 'w07', path: '/orbit/flussi/:flow', org: 'orbit', nav: 'flows', needs: 'view:flows',
    samples: [P.orbitFlow('orbit-segnalazioni'), P.orbitFlow('orbit-fatture'), P.orbitFlow('orbit-fir'), P.orbitFlow('orbit-gara')],
    title: (p, ctx) => orbitFlowTitle(p.flow, ctx),
    render: (p, ctx) => renderOrbitFlow(p.flow, ctx),
  },
  {
    id: 's03', path: '/orbit/call-center', org: 'orbit', nav: 'callcenter', needs: 'view:callcenter',
    samples: [P.orbitCallCenter(), P.orbitCallCenter('c-incoming'), P.orbitCallCenter('q-sfalci'), P.orbitCallCenter('c-1')],
    title: callTitle,
    render: (_p, ctx) => renderCallCenter(undefined, ctx),
  },
  {
    id: 's03', path: '/orbit/call-center/:call', org: 'orbit', nav: 'callcenter', needs: 'view:callcenter',
    samples: [P.orbitCallCenter('q-ingombranti'), P.orbitCallCenter('c-incoming')],
    title: callTitle,
    render: (p, ctx) => renderCallCenter(p.call, ctx),
  },
  {
    id: 's04', path: '/orbit/panoramica', org: 'orbit', nav: 'overview', needs: 'view:overview', samples: [P.orbitOverview()],
    title: (_p, ctx) => ctx.copy.orgs.orbit.overviewTitle,
    render: (_p, ctx) => renderOrbitOverview(ctx),
  },
  {
    id: 'org-armonia', path: '/org/armonia', org: 'armonia', nav: 'org', samples: [P.org('armonia')],
    title: () => ORGS.find((o) => o.id === 'armonia')!.name,
    render: (_p, ctx) => renderOrgPage('armonia', ctx),
  },
  {
    id: 'org-euro', path: '/org/euro', org: 'euro', nav: 'org', samples: [P.org('euro')],
    title: () => ORGS.find((o) => o.id === 'euro')!.name,
    render: (_p, ctx) => renderOrgPage('euro', ctx),
  },
];

function search(ctx: ScreenCtx): SearchEntry[] {
  const s = ctx.copy.orgs.search;
  const [board] = ctx.slice<BoardSlice>('board', BOARD_INITIAL);
  const orgPath = { nocera: P.overview(), orbit: P.orbitOverview(), armonia: P.org('armonia'), euro: P.org('euro') } as const;
  const entries: SearchEntry[] = ORGS.filter((o) => ctx.persona.orgs.includes(o.id)).map((o) => ({
    id: `org:${o.id}`,
    group: s.organizations,
    title: o.name,
    detail: s.organizationDetail,
    keywords: `${o.monogram} ${s.organizationWords}`,
    path: orgPath[o.id],
    icon: Building2,
  }));
  const tasks = [...BOARD_TASKS, ...board.added].filter((t) => ctx.persona.orgs.includes(t.org));
  for (const t of tasks) {
    entries.push({
      id: `board:${t.id}`,
      group: s.board,
      title: t.title,
      detail: `${ORGS.find((o) => o.id === t.org)?.name ?? t.org} · ${t.area}`,
      keywords: s.boardWords,
      path: board.added.some((a) => a.id === t.id) ? P.board(t.org) : targetPath(t.target),
      icon: Kanban,
      needs: 'view:board',
    });
  }
  if (ctx.persona.orgs.includes('orbit')) {
    for (const f of ORBIT_FLOWS.filter((x) => !FLOWS.some((l) => l.id === x.id))) {
      entries.push({ id: `orbit-flow:${f.id}`, group: ctx.copy.flows.root, title: f.name, detail: f.area, keywords: f.trigger, path: P.orbitFlow(f.id), icon: Workflow, needs: 'view:flows' });
    }
    entries.push({ id: 'orbit-callcenter', group: s.organizations, title: ctx.copy.shell.nav.callcenter, detail: ORGS.find((o) => o.id === 'orbit')!.name, path: P.orbitCallCenter(), icon: Headset, needs: 'view:callcenter' });
  }
  return entries;
}

export const ORGS_AREA: AreaModule = { screens: SCREENS, search };
