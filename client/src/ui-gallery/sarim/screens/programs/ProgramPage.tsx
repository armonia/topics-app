/**
 * sarim-program: one program of SARIM. What Topics reads there (on its own)
 * and what it writes (only after the named person confirms, said once in that section), the flows that
 * use it and the steps done inside it, the open cards that go through it, and
 * on the side how it is connected, the controls to test, connect and
 * disconnect it (simulated jobs, every one in the log) and its history.
 */
import { ArrowLeft, CheckCircle2, CircleAlert, Eye, FlaskConical, Landmark, PenLine, Plug, PlugZap, Unplug } from 'lucide-react';
import clsx from 'clsx';
import { personaById, programById, world } from '../../world';
import type { SarimProgram } from '../../../../ui/fixtures/sarim-org/programs';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { KeyValue, PanelSection, SidePanel } from '../../../../ui/primitives/Panel';
import { Timeline } from '../../../../ui/primitives/Timeline';
import { ConnectionChip, JobProgress, ProgramTile, StatePill } from '../../../../ui/programs/Shared';
import { Block, Callout } from '../../../../ui/settings/Block';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { Avatar } from '../../../../ui/shell/SidebarRows';
import { FOCUS_RING } from '../../../../ui/shell/pressable';
import type { ScreenCtx } from '../../../app/kit';
import { flowIcon, flowLabel, isPaused } from '../../model/flows';
import { openDaFare } from '../../model/dafare';
import { liveCards } from '../../model/live';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { CardLine, Lines, SourceLink } from '../../admin-parts';
import { nameOf, when } from '../../model/words';
import { StateGlyph } from './ListPage';
import { LINK_KIND, STATE_TONE, connect, connectJobId, disconnect, flowsUsing, historyOf, isConnected, openCards, programState, programsSlice, runTest, stepsIn, testJobId } from './state';

/** The colour of a flow's status chip. */
const statusTone = (status: string) => (status === 'attivo' ? 'green' : status === 'collaudo' ? 'amber' : 'neutral'); // allow-italian: status ids, compared by value

const CARDS_SHOWN = 8;

export function ProgramPage({ ctx, id }: { ctx: ScreenCtx; id: string }) {
  const c = ctx.copy.sarimAdmin.programs;
  const p = programById(id);
  if (!p) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PaneHeader crumbs={orgCrumbs(ctx, [{ label: c.title }])} />
        <EmptyState icon={Plug} title={c.page.notFound} action={<Button icon={ArrowLeft} onClick={() => ctx.go(SP.programs())}>{c.page.back}</Button>}>{c.page.notFoundBody}</EmptyState>
      </div>
    );
  }
  return <Program ctx={ctx} p={p} />;
}

function Program({ ctx, p }: { ctx: ScreenCtx; p: SarimProgram }) {
  const c = ctx.copy.sarimAdmin.programs;
  const g = c.page;
  const common = ctx.copy.sarimAdmin.common;
  const [slice] = programsSlice(ctx);
  const state = programState(ctx, slice, p);
  const connected = isConnected(slice, p);
  const flows = flowsUsing(p);
  const cards = openCards(liveCards(ctx.state), p);
  const test = slice.tests[p.id];
  const testJob = ctx.job(testJobId(p.id));
  const connectJob = ctx.job(connectJobId(p.id));
  const busy = testJob?.status === 'running' || connectJob?.status === 'running';
  const history = historyOf(ctx, slice, [p]);

  const testButton = connected && (
    <Button
      variant="primary"
      icon={FlaskConical}
      onClick={busy ? false : ctx.allow('run:tests', () => runTest(ctx, p))}
      title={ctx.deniedTitle('run:tests')}
    >
      {test && !test.ok ? g.retest : g.test}
    </Button>
  );
  const linkButton = connected ? (
    <Button variant="danger" icon={Unplug} onClick={busy ? false : ctx.allow('edit:structure', () => disconnect(ctx, p))} title={ctx.deniedTitle('edit:structure')}>{g.disconnect}</Button>
  ) : (
    <Button variant="primary" icon={PlugZap} onClick={busy ? false : ctx.allow('edit:structure', () => connect(ctx, p))} title={ctx.deniedTitle('edit:structure')}>{g.connect}</Button>
  );

  const main = (
    <div className="flex w-full max-w-[860px] flex-col gap-4 px-4 py-5">
      <div className="flex min-w-0 items-start gap-3">
        <ProgramTile initial={p.monogram} color={p.color} size={44} />
        <div className="min-w-0 flex-1">
          <h1 className="text-headline font-semibold leading-7 text-app-text">{p.name}</h1>
          <p className="text-prose leading-5 text-app-text-secondary">{p.sub}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <ConnectionChip kind={LINK_KIND[p.link]} label={c.links[p.link]} />
            <StatePill tone={STATE_TONE[state]} icon={<StateGlyph state={state} />}>{c.states[state]}</StatePill>
          </div>
        </div>
      </div>

      {p.external && <Callout icon={Landmark} tone="blue">{g.external(p.external)}</Callout>}
      {!connected && <Callout icon={Unplug} tone="amber">{g.disconnectedNote(flows.length ? flows.map((f) => `«${f.name}»`).join(', ') : common.blank)}</Callout>}

      <Block title={g.readsTitle}>
        <ul className="flex flex-col">
          {p.reads.map((r) => (
            <li key={r} className="flex items-start gap-2 border-t border-app-border py-2 text-prose leading-5 text-app-text first:border-t-0 first:pt-0 last:pb-0">
              <Eye size={14} className="mt-0.5 shrink-0 text-app-text-tertiary" aria-hidden="true" />
              {r}
            </li>
          ))}
        </ul>
      </Block>

      <Block title={g.writesTitle}>
        {p.writes.length === 0 ? <p className="text-prose text-app-text-tertiary">{g.writesNone}</p> : (
          <ul className="flex flex-col">
            {p.writes.map((w) => {
              const who = personaById(w.confirmedBy);
              return (
                <li key={w.what} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-app-border py-2 first:border-t-0 first:pt-0 last:pb-0">
                  <PenLine size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                  <span className="min-w-[180px] flex-1 text-prose leading-5 text-app-text">{w.what}</span>
                  {who && (
                    <button
                      type="button"
                      onClick={() => ctx.go(SP.person(who.id))}
                      className={clsx('inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-black/[0.05] dark:hover:bg-white/[0.08]', FOCUS_RING)}
                    >
                      <Avatar text={who.monogram} color={who.color} size={18} />
                      <span>{g.confirmedBy}</span>
                      <span className="font-medium text-app-text">{who.short}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Block>

      <Block title={g.flowsTitle}>
        <Lines empty={g.flowsEmpty}>
          {flows.map((f) => {
            const here = stepsIn(f, p);
            const FlowIcon = flowIcon(f.id);
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => ctx.go(SP.flow(f.id))}
                className={clsx('flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-app-border px-1 py-2 text-left first:border-t-0 hover:bg-app-hover', FOCUS_RING)}
              >
                <FlowIcon size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                <span className="min-w-[160px] flex-1 text-prose leading-5 text-app-text">
                  {f.name}
                  <span className="block text-mini text-app-text-tertiary">{common.perMonth(f.perMonth)}</span>
                </span>
                {isPaused(ctx.state, f.id)
                  ? <Chip tone="neutral">{g.flowPaused}</Chip>
                  : <Chip tone={statusTone(f.status)}>{g.flowStatus[f.status]}</Chip>}
                <span className="text-mini tabular-nums text-app-text-secondary">{g.flowSteps(here.length)}</span>
              </button>
            );
          })}
        </Lines>
      </Block>

      <Block
        title={g.cardsTitle}
        actions={<span className="text-mini tabular-nums text-app-text-tertiary">{common.cards(cards.length)}</span>}
      >
        {cards.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-mini text-app-text-tertiary">{g.cardsByFlow}</span>
            {world().opsFlows.filter((f) => cards.some((x) => x.flow === f.id)).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => openDaFare(ctx, { view: 'list', flow: f.id })}
                className={clsx('inline-flex h-6 items-center gap-1.5 rounded-full bg-black/[0.05] px-2.5 text-mini font-medium text-app-text hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]', FOCUS_RING)}
              >
                {flowLabel(f.id)}
                <span className="tabular-nums text-app-text-tertiary">{cards.filter((x) => x.flow === f.id).length}</span>
              </button>
            ))}
          </div>
        )}
        <Lines empty={g.cardsEmpty}>
          {cards.slice(0, CARDS_SHOWN).map((card) => <CardLine key={card.id} card={card} ctx={ctx} note={card.worker.doing} />)}
        </Lines>
      </Block>
    </div>
  );

  const linkSection = (
      <PanelSection label={g.linkTitle}>
        <p className="text-prose leading-5 text-app-text">{p.how}</p>
        <div className="mt-2 border-t border-app-border pt-1">
          <KeyValue label={g.account} value={<span className="text-app-text-secondary">{p.account}</span>} />
          <KeyValue label={g.every} value={<span className="text-app-text-secondary">{p.every}</span>} />
          <KeyValue label={g.lastRead} value={when(ctx, p.lastRead)} />
          {p.source && <KeyValue label={g.source} value={<SourceLink ctx={ctx} label={p.source.label} url={p.source.url} />} />}
        </div>
      </PanelSection>
  );
  const actionsSection = (
      <PanelSection>
        <div className="flex flex-wrap items-center gap-2">
          {testButton}
          {linkButton}
        </div>
        {testJob && testJob.status === 'running' && <JobProgress job={testJob} copy={ctx.copy} className="mt-3" />}
        {connectJob && connectJob.status === 'running' && <JobProgress job={connectJob} copy={ctx.copy} className="mt-3" />}
        {!busy && connected && test && (
          <p className={clsx('mt-3 flex items-start gap-1.5 text-prose leading-5', test.ok ? 'text-app-text-secondary' : 'text-rose-600 dark:text-rose-400')}>
            {test.ok
              ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              : <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />}
            <span>
              {test.ok ? g.testOk(when(ctx, test.at)) : g.testFailed}
              {test.why && <span className="block text-mini text-app-text-secondary">{test.why}</span>}
            </span>
          </p>
        )}
      </PanelSection>
  );
  const historySection = (
      <PanelSection label={g.historyTitle}>
        {history.length === 0 ? <p className="text-prose text-app-text-tertiary">{g.historyEmpty}</p> : (
          <Timeline
            ariaLabel={g.historyTitle}
            items={history.map((h) => ({
              id: h.id,
              at: when(ctx, h.at),
              title: h.what,
              who: h.who.startsWith('program:') ? p.name : nameOf(h.who),
              tone: h.tone,
            }))}
          />
        )}
      </PanelSection>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader crumbs={orgCrumbs(ctx, [{ label: c.title, to: SP.programs() }, { label: p.name }])} />
      {ctx.phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-app-border bg-surface">{actionsSection}</div>
          {main}
          <div className="border-t border-app-border bg-surface">{linkSection}{historySection}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{main}</div>
          <SidePanel width={360}>{actionsSection}{linkSection}{historySection}</SidePanel>
        </div>
      )}
    </div>
  );
}
