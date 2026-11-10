/** Settings · Where it runs (`s06`): where Topics runs for the organization, what changes by choosing another place, the protections and the level they give. */
import { CircleAlert, ShieldCheck } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import type { DeployId, ProtectionId, ProtectionState } from '../../../../ui/settings/model';
import { settingsFrame } from '../settings-frame';
import { Block, Callout, Notes } from '../../../../ui/settings/Block';
import { DeploymentCards, FactTable, ProtectionList } from '../../../../ui/settings/Hosting';
import { Button } from '../../../../ui/primitives/Button';
import { ProgressBar } from '../../../../ui/primitives/Progress';
import { DEPLOYMENTS, ORG_IDENTITY, PROTECTIONS } from '../../../../ui/fixtures/settings';
import { adminGate, dayText, isRunning } from './helpers';
import { JobStatus } from './shared';

interface HostingState {
  current: DeployId;
  requested: { to: DeployId; at: string; ref: string } | null;
  protections: Record<ProtectionId, ProtectionState>;
}

const initial = (): HostingState => ({
  current: 'cloud',
  requested: null,
  protections: Object.fromEntries(PROTECTIONS.map((p) => [p.id, p.state])) as Record<ProtectionId, ProtectionState>,
});

export function HostingPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.settings;
  const h = c.hosting;
  const gate = adminGate(ctx);
  const [st, setSt] = ctx.slice<HostingState>('hosting', initial());
  const [selected, setSelected] = ctx.ui<DeployId>('dove.sel', st.current);

  const on = PROTECTIONS.filter((p) => st.protections[p.id] === 'on').length;
  const total = PROTECTIONS.length;
  const level = on >= 7 ? 'high' : on >= 4 ? 'raised' : 'base';

  const statusOf = (id: DeployId): { label: string; tone: 'green' | 'blue' | 'neutral' } => {
    if (id === st.current) return { label: h.states.current, tone: 'green' };
    if (st.requested?.to === id) return { label: h.states.requested(dayText(st.requested.at)), tone: 'blue' };
    return { label: id === 'isolated' ? h.states.onRequest : h.states.possible, tone: 'neutral' };
  };

  const requestMove = () => {
    const name = h.deployments[selected].name;
    ctx.confirm({
      title: h.request.confirm.title(name),
      body: h.request.confirm.body(name),
      confirmLabel: h.request.confirm.label,
      onConfirm: () =>
        ctx.startJob({
          id: 'hosting-request',
          title: h.request.job.title(name),
          steps: h.request.job.steps.map((label) => ({ label, ms: 750 })),
          onDone: (ok) => {
            if (!ok) return;
            const ref = `RC-${String(ctx.state.seq).padStart(4, '0')}`;
            setSt((prev) => ({ ...prev, requested: { to: selected, at: ctx.now.slice(0, 10), ref } }));
            ctx.log(h.request.job.title(name), 'setting', ctx.path);
            ctx.notify({ title: h.request.toast(name), body: h.request.receiptLine(name, ref, dayText(ctx.now.slice(0, 10))), path: ctx.path, tone: 'info' });
            ctx.toast({ tone: 'ok', title: h.request.toast(name), body: ref });
          },
        }),
    });
  };

  const cancelRequest = () => {
    setSt((prev) => ({ ...prev, requested: null }));
    ctx.log(h.request.cancelled, 'setting', ctx.path);
    ctx.toast({ tone: 'info', title: h.request.cancelled });
  };

  const runProtection = (id: ProtectionId) => {
    const name = h.protections.items[id].name;
    const state = st.protections[id];
    ctx.startJob({
      id: `protection-${id}`,
      title: h.protectionJob.title(name),
      steps: h.protectionJob.steps.map((label) => ({ label, ms: 700 })),
      onDone: (ok) => {
        if (!ok) return;
        const next: ProtectionState = state === 'to-evaluate' ? 'evaluating' : 'on';
        setSt((prev) => ({ ...prev, protections: { ...prev.protections, [id]: next } }));
        ctx.log(next === 'on' ? h.protectionJob.done(name) : h.protectionJob.evaluating(name), 'setting', ctx.path);
        ctx.toast({ tone: 'ok', title: next === 'on' ? h.protectionJob.done(name) : h.protectionJob.evaluating(name) });
      },
    });
  };

  const actionLabel = (state: ProtectionState) =>
    state === 'to-enable' ? h.actions.enable : state === 'to-evaluate' ? h.actions.evaluate : state === 'partial' ? h.actions.complete : undefined;

  const facts = h.facts.values[selected];
  const pending = st.requested;

  return settingsFrame(ctx, 'dove-gira', {
    children: (
      <div className="flex flex-col gap-4">
        <p className="text-prose leading-5 text-app-text-secondary">{h.intro}</p>

        <Block title={h.level.title} bodyClassName="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ShieldCheck size={18} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <span className="text-body-lg font-semibold text-app-text">{h.level.names[level]}</span>
            <span className="text-prose text-app-text-secondary">{h.level.summary(on, total)}</span>
          </div>
          <ProgressBar value={on / total} tone={level === 'high' ? 'green' : level === 'raised' ? 'blue' : 'amber'} label={h.level.title} />
          <p className="text-compact text-app-text-tertiary">{h.level.note}</p>
        </Block>

        <DeploymentCards
          ariaLabel={h.intro}
          items={DEPLOYMENTS.map((id) => {
            const st2 = statusOf(id);
            return { id, name: h.deployments[id].name, text: h.deployments[id].text, statusLabel: st2.label, statusTone: st2.tone, selected: id === selected, onSelect: () => setSelected(id) };
          })}
        />

        <Block title={h.whatChanges(h.deployments[selected].name)} bodyClassName="flex flex-col gap-3">
          <FactTable
            ariaLabel={h.deployments[selected].name}
            rows={[
              { label: h.facts.labels.data, value: facts.data },
              { label: h.facts.labels.ai, value: facts.ai },
              { label: h.facts.labels.upkeep, value: facts.upkeep },
              { label: h.facts.labels.pcs, value: facts.pcs },
            ]}
          />
          <JobStatus job={ctx.job('hosting-request')} />
          {pending && (
            <Callout icon={CircleAlert} tone="blue">
              <div className="font-medium">{h.request.receiptTitle}</div>
              <div>{h.request.receiptLine(h.deployments[pending.to].name, pending.ref, dayText(pending.at))}</div>
              <div className="mt-2">
                <Button size="sm" variant="secondary" onClick={ctx.allow('admin', cancelRequest)} title={gate.title}>{h.request.cancel}</Button>
              </div>
            </Callout>
          )}
          {selected !== st.current && pending?.to !== selected && (
            <div>
              <Button variant="primary" onClick={isRunning(ctx, 'hosting-request') ? false : ctx.allow('admin', requestMove)} title={isRunning(ctx, 'hosting-request') ? ctx.copy.app.jobs.running : gate.title}>
                {h.request.button(h.deployments[selected].name)}
              </Button>
            </div>
          )}
        </Block>

        <Block title={h.protections.title} bodyClassName="flex flex-col gap-3">
          {PROTECTIONS.map((p) => <JobStatus key={p.id} job={ctx.job(`protection-${p.id}`)} />)}
          <ProtectionList
            ariaLabel={h.protections.title}
            items={PROTECTIONS.map((p) => {
              const state = st.protections[p.id];
              const label = actionLabel(state);
              const running = isRunning(ctx, `protection-${p.id}`);
              return {
                id: p.id,
                name: h.protections.items[p.id].name,
                how: h.protections.items[p.id].how,
                state,
                stateLabel: h.protectionStates[state],
                action: label ? (
                  <Button size="sm" variant="secondary" onClick={running ? false : ctx.allow('admin', () => runProtection(p.id))} title={running ? ctx.copy.app.jobs.running : gate.title}>{label}</Button>
                ) : undefined,
              };
            })}
          />
        </Block>

        <Notes
          items={[
            { title: h.side.title[st.current], text: `${h.side.tag(ORG_IDENTITY.shortName)}. ${h.side.text}` },
            { title: h.side.noVm.title, text: h.side.noVm.text },
            { title: h.side.notPromised.title, text: h.side.notPromised.text },
          ]}
        />
      </div>
    ),
  });
}
