/**
 * s04 «Panoramica» of ORBIT: four headline numbers and each flow's month,
 * computed from the flows (`orbit-model.ts`) and the call center's open queue,
 * so the numbers agree with the list of flows and with the queue.
 */
import { DUPLICATE_PATH_ID, ORBIT_OVERVIEW_WORDS } from '../../../../ui/fixtures/orbit';
import { OrbitOverview } from '../../../../ui/orbit/OrbitOverview';
import type { StatTileModel } from '../../../../ui/overview/model';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { downloadCsv } from './csv';
import { fmt, pathVolume, orbitFlows, orbitStuck } from './orbit-model';
import { ORBIT_INITIAL, type OrbitState } from './orbit-state';

export function renderOrbitOverview(ctx: ScreenCtx) {
  const o = ctx.copy.orgs.orbit;
  const [st] = ctx.slice<OrbitState>('orbit', ORBIT_INITIAL);
  const flows = orbitFlows();
  const stuck = orbitStuck(st, ctx.copy);
  const report = flows.find((f) => f.seed.id === 'orbit-segnalazioni');
  const invoices = flows.find((f) => f.seed.id === 'orbit-fatture');
  const hours = Math.round(flows.reduce((a, f) => a + f.perMonth * f.seed.manualMinutes, 0) / 60);
  const w = ORBIT_OVERVIEW_WORDS;
  const tiles: StatTileModel[] = [
    { id: 'k-reports', value: fmt(report?.perMonth ?? 0), label: w.reports.label, detail: w.reports.detail, icon: 'folder' },
    { id: 'k-duplicates', value: fmt(pathVolume(DUPLICATE_PATH_ID)), label: w.duplicates.label, detail: w.duplicates.detail, icon: 'gauge' },
    { id: 'k-invoices', value: fmt(invoices?.perMonth ?? 0), label: w.invoices.label, detail: w.invoices.detail(invoices?.seed.toPerson ?? 0), icon: 'folder' },
    { id: 'k-hours', value: fmt(hours), label: w.hours.label, detail: w.hours.detail, icon: 'clock' },
  ];
  const rows = flows.map((f) => ({
    id: f.seed.id,
    name: f.name,
    area: f.seed.area,
    perMonth: fmt(f.perMonth),
    toPerson: f.seed.toPerson,
    errors: String(f.seed.errors),
    stuck: stuck[f.seed.id] ? `${stuck[f.seed.id]!.place} · ${stuck[f.seed.id]!.count}` : undefined,
  }));
  const exportCsv = () => {
    const c = ctx.copy.overview.columns;
    const name = `${o.exportFile}.csv`;
    downloadCsv(name, [[c.flow, o.columns.area, c.perMonth, c.toPerson, c.errors, c.stuck], ...rows.map((r) => [r.name, r.area, r.perMonth, `${r.toPerson}%`, r.errors, r.stuck ?? ''])]);
    ctx.log(ctx.copy.orgs.overview.logExport(name), 'access', P.orbitOverview());
    ctx.toast({ tone: 'ok', title: ctx.copy.orgs.overview.exportDone, body: ctx.copy.orgs.overview.exportBody(name, rows.length) });
  };
  return (
    <OrbitOverview
      tiles={tiles}
      flows={rows}
      tileLinks={{
        'k-reports': () => ctx.go(P.orbitFlow('orbit-segnalazioni')),
        'k-duplicates': () => ctx.go(P.orbitFlow('orbit-segnalazioni')),
        'k-invoices': () => ctx.go(P.orbitFlow('orbit-fatture')),
        'k-hours': () => ctx.go(P.orbitFlows()),
      }}
      onOpenFlow={(id) => ctx.go(P.orbitFlow(id))}
      onOpenStuck={(id) => ctx.go(stuck[id]?.callCenter ? P.orbitCallCenter() : P.orbitFlow(id))}
      onExport={ctx.allow('export', exportCsv)}
      exportTitle={ctx.deniedTitle('export')}
      copy={ctx.copy}
      phone={ctx.phone}
    />
  );
}
