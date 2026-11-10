/**
 * n18 «Panoramica per la direzione», live: the numbers come from the flows
 * and the cases (`overview-model.ts`), the period and the choice of blocks are
 * kept, «Esporta» hands over a CSV of what is on show.
 */
import { ChartColumn } from 'lucide-react';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { Button } from '../../../../ui/primitives/Button';
import { OverviewScreen } from '../../../../ui/overview/OverviewScreen';
import { CustomizeBlocks } from '../../../../ui/overview/CustomizeBlocks';
import { OVERVIEW_BLOCKS, type OverviewBlockId, type OverviewPeriod } from '../../../../ui/overview/model';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { downloadCsv } from './csv';
import { buildOverview } from './overview-model';

interface BlockLayout {
  order: OverviewBlockId[];
  hidden: OverviewBlockId[];
}

const DEFAULT_LAYOUT: BlockLayout = { order: OVERVIEW_BLOCKS, hidden: [] };

export function renderOverview(ctx: ScreenCtx) {
  const o = ctx.copy.orgs.overview;
  const [period, setPeriod] = ctx.ui<OverviewPeriod>('overview.period', 'month');
  const [prefs, setPrefs] = ctx.ui<BlockLayout>('overview.blocks', DEFAULT_LAYOUT);
  const [customizing, setCustomizing] = ctx.ui<boolean>('overview.customizing', false);
  const data = buildOverview(ctx.state, period, ctx.copy);
  const visible = prefs.order.filter((b) => !prefs.hidden.includes(b));
  const c = ctx.copy.overview.columns;

  const exportCsv = () => {
    const name = `${o.exportFile}-${period}.csv`;
    downloadCsv(name, data.csv([c.flow, data.volumeLabel, c.avgTime, c.toPerson, c.corrected, c.errors, c.stuck]));
    ctx.log(o.logExport(name), 'access', P.overview());
    ctx.toast({ tone: 'ok', title: o.exportDone, body: o.exportBody(name, data.model.flows.length) });
  };

  const choices = prefs.order.map((id) => ({ id, label: o.blocks[id].label, detail: o.blocks[id].detail, visible: !prefs.hidden.includes(id) }));
  const move = (id: OverviewBlockId, dir: -1 | 1) => {
    const order = [...prefs.order];
    const at = order.indexOf(id);
    const to = at + dir;
    if (to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    setPrefs({ ...prefs, order });
  };
  const toggle = (id: OverviewBlockId, on: boolean) => {
    const hidden = on ? prefs.hidden.filter((b) => b !== id) : [...prefs.hidden, id];
    setPrefs({ ...prefs, hidden });
  };
  const allHidden = visible.length === 0;

  return (
    <>
      <OverviewScreen
        overview={data.model}
        copy={ctx.copy}
        period={period}
        onPeriodChange={setPeriod}
        volumeLabel={data.volumeLabel}
        blocks={visible}
        phone={ctx.phone}
        onOpenFlow={(id) => ctx.go(P.flow(id))}
        onOpenStuck={() => ctx.go(P.inbox())}
        tileLinks={{
          'k-volume': () => ctx.go(P.data()),
          'k-person': () => ctx.go(P.inbox()),
          'k-hours': () => ctx.go(P.flows()),
          'k-stuck': () => ctx.go(P.inbox()),
        }}
        onCustomize={() => setCustomizing(true)}
        onExport={ctx.allow('export', exportCsv)}
        exportTitle={ctx.deniedTitle('export')}
      >
        {allHidden ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <ChartColumn size={20} className="text-app-text-tertiary" aria-hidden="true" />
            <p className="text-body-lg font-semibold text-app-text">{o.noBlocks}</p>
            <p className="max-w-[420px] text-prose text-app-text-secondary">{o.noBlocksBody}</p>
            <Button variant="primary" onClick={() => setPrefs(DEFAULT_LAYOUT)}>{o.showAll}</Button>
          </div>
        ) : undefined}
      </OverviewScreen>
      {customizing && (
        <Dialog
          title={ctx.copy.overview.customize}
          closeLabel={o.close}
          onClose={() => setCustomizing(false)}
          footer={(
            <>
              <Button onClick={() => { setPrefs(DEFAULT_LAYOUT); ctx.toast({ tone: 'info', title: o.resetDone }); }}>{o.reset}</Button>
              <Button variant="primary" onClick={() => { setCustomizing(false); ctx.log(o.logCustomize, 'setting', P.overview()); ctx.toast({ tone: 'ok', title: o.saved }); }}>{o.done}</Button>
            </>
          )}
        >
          <p className="mb-3">{o.customizeIntro}</p>
          <CustomizeBlocks blocks={choices} onToggle={toggle} onMove={move} upLabel={o.moveUp} downLabel={o.moveDown} listLabel={o.blocksLabel} />
        </Dialog>
      )}
    </>
  );
}
