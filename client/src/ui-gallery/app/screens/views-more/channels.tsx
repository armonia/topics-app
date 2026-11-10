/**
 * ch01: the channels. The table of where work comes in and goes out, what is
 * connected, what each channel starts; on the right a person seen across
 * channels, or, with a channel picked, its facts, last messages, routing rules
 * (switch, delete, add) and the receipts of the tests. Connecting, pausing and
 * testing are real: a job with progress, a state that stays, a receipt.
 */
import type { ReactNode } from 'react';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { ChannelsScreen, type ChannelActionModel } from '../../../../ui/channels/ChannelsScreen';
import type { ChannelDetailModel, ChannelRowModel, SamePersonModel } from '../../../../ui/channels/model';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { Select } from '../../../../ui/primitives/Field';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { CHANNELS, CHANNEL_VOLUME, SAME_PERSON, type ChannelSeed, type ChannelState } from '../../../../ui/fixtures/channels';
import { FLOWS, flowSeed } from '../../../../ui/fixtures/org/flows';
import { CASES } from '../../../../ui/fixtures/org/cases';
import { formatShortDay } from '../../../../ui/fixtures/org/clock';
import { channelsSlice, hashText, rulesOf, stamp, stateOf, type ChannelsState } from './shared';
import { RuleDialog, type RuleDraft } from './channels-rule';

const EMPTY_RULE: RuleDraft = { open: false, when: '', then: '', flow: '', tried: false };

const TONE: Record<ChannelState, 'green' | 'amber' | 'neutral' | 'blue'> = { connected: 'green', testing: 'amber', pending: 'neutral', paused: 'neutral' };


/** `2026-11-05T09:12:04+01:00` as `05/11 09:12`. */
const shortStamp = (iso: string) => `${formatShortDay(iso.slice(0, 10))} ${iso.slice(11, 16)}`;

export function renderChannels(params: { channel?: string }, ctx: ScreenCtx): ReactNode {
  const m = ctx.copy.viewsMore;
  const c = m.channels;
  const [st, setSt] = channelsSlice(ctx);
  const [rule, setRule] = ctx.ui<RuleDraft>('channels.rule', EMPTY_RULE);
  const [connectOpen, setConnectOpen] = ctx.ui('channels.connect', false);
  const [connectPick, setConnectPick] = ctx.ui('channels.connectPick', '');
  const picked = params.channel ? CHANNELS.find((x) => x.id === params.channel) : undefined;
  const canEdit = ctx.can('edit:structure');
  const denied = ctx.deniedTitle('edit:structure');

  const inWords = (v: string) => c.inOut[v as keyof typeof c.inOut] ?? v;
  const flowName = (seed: ChannelSeed) => (seed.flow ? flowSeed(seed.flow)?.name ?? seed.flow : seed.startsNote ?? c.noFlow);
  const volumeNote = (seed: ChannelSeed) => (CHANNEL_VOLUME[seed.id] !== undefined ? undefined : seed.startsNote ? c.volumeByPerson : c.volumeNoFlow);
  const stateLabel = (seed: ChannelSeed) => c.states[stateOf(seed, st)];

  const rows: ChannelRowModel[] = CHANNELS.map((seed) => ({
    id: seed.id,
    icon: seed.id,
    name: seed.name,
    entra: inWords(`in-${seed.entra}`),
    esce: inWords(`out-${seed.esce}`),
    volume: CHANNEL_VOLUME[seed.id],
    volumeNote: volumeNote(seed),
    flow: flowName(seed),
    beforeExit: seed.beforeExit ?? ctx.copy.viewsMore.channels.none,
    state: { label: stateLabel(seed), tone: TONE[stateOf(seed, st)] },
    selected: picked?.id === seed.id,
    onOpen: () => ctx.go(P.channels(seed.id)),
  }));
  const stats = {
    connected: CHANNELS.filter((x) => stateOf(x, st) === 'connected').length,
    total: CHANNELS.length,
    volume: CHANNELS.reduce((n, x) => n + (CHANNEL_VOLUME[x.id] ?? 0), 0),
    starting: CHANNELS.filter((x) => x.flow).length,
  };

  const setState = (seed: ChannelSeed, next: ChannelState, what: string) => {
    setSt((p: ChannelsState) => ({ ...p, state: { ...p.state, [seed.id]: next } }));
    ctx.log(what, 'structure', P.channels(seed.id));
  };

  const connect = (seed: ChannelSeed) => ctx.allow('edit:structure', () => {
    ctx.startJob({
      id: `channel-${seed.id}`,
      title: c.jobConnect(seed.name),
      steps: [
        { label: c.jobCredentials, ms: 700 },
        { label: c.jobHandshake, ms: 800, fails: seed.id === 'send' && !(st.attempts[seed.id] ?? 0) },
        { label: c.jobFirstRead, ms: 600 },
      ],
      onDone: (ok) => {
        setSt((p: ChannelsState) => ({ ...p, attempts: { ...p.attempts, [seed.id]: (p.attempts[seed.id] ?? 0) + 1 }, errors: ok ? Object.fromEntries(Object.entries(p.errors).filter(([k]) => k !== seed.id)) : { ...p.errors, [seed.id]: c.errorRefused } }));
        if (!ok) {
          ctx.toast({ tone: 'error', title: c.toastConnectFailed(seed.name), body: c.errorRefused });
          return;
        }
        setState(seed, 'connected', c.logConnected(seed.name));
        ctx.toast({ tone: 'ok', title: c.toastConnected(seed.name), action: { label: c.openChannel, path: P.channels(seed.id) } });
      },
    });
  });
  const pause = (seed: ChannelSeed) => ctx.allow('edit:structure', () => ctx.confirm({
    title: c.confirmPauseTitle(seed.name),
    body: c.confirmPauseBody,
    confirmLabel: c.pause,
    tone: 'danger',
    onConfirm: () => {
      setState(seed, 'paused', c.logPaused(seed.name));
      ctx.notify({ title: c.notifyPaused(seed.name), body: c.notifyPausedBody, path: P.channels(seed.id), tone: 'warn' });
      ctx.toast({ tone: 'info', title: c.toastPaused(seed.name) });
    },
  }));
  const resume = (seed: ChannelSeed) => ctx.allow('edit:structure', () => {
    setState(seed, 'connected', c.logResumed(seed.name));
    ctx.toast({ tone: 'ok', title: c.toastResumed(seed.name) });
  });
  const test = (seed: ChannelSeed) => ctx.allow('edit:structure', () => {
    const outbound = seed.esce !== 'no';
    ctx.startJob({
      id: `channel-test-${seed.id}`,
      title: outbound ? c.jobTestOut(seed.name) : c.jobTestIn(seed.name),
      steps: outbound
        ? [{ label: c.jobTestPrepare, ms: 600 }, { label: c.jobTestSend, ms: 900 }, { label: c.jobTestReceipt, ms: 600 }]
        : [{ label: c.jobTestWait, ms: 900 }, { label: c.jobTestRead, ms: 700 }],
      onDone: (ok) => {
        if (!ok) {
          ctx.toast({ tone: 'error', title: c.toastTestFailed(seed.name) });
          return;
        }
        const at = stamp(ctx.now);
        const code = hashText(`${seed.id}${at}${(st.receipts[seed.id] ?? []).length}`).toString(36).slice(0, 6).toUpperCase();
        const lines = outbound
          ? [c.receiptAccepted(at), c.receiptDelivered(at), c.receiptId(code)]
          : [c.receiptReceived(at), c.receiptRead(at), c.receiptId(code)];
        setSt((p: ChannelsState) => ({ ...p, receipts: { ...p.receipts, [seed.id]: [{ id: `rc-${code}`, title: outbound ? c.receiptOutTitle : c.receiptInTitle, at: shortStamp(ctx.now), lines }, ...(p.receipts[seed.id] ?? [])] } }));
        ctx.log(c.logTested(seed.name), 'structure', P.channels(seed.id));
        ctx.toast({ tone: 'ok', title: c.toastTested(seed.name), body: c.toastTestedBody });
      },
    });
  });

  const messagesOf = (seed: ChannelSeed): ChannelDetailModel['messages'] => (seed.id === 'send' ? [] : CASES
    .filter((x) => x.org === 'nocera' && x.channel === seed.caseChannel)
    .sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt))
    .slice(0, 5)
    .map((x) => ({ id: x.id, title: x.title, from: x.counterpart, at: shortStamp(x.arrivedAt), onOpen: () => ctx.go(P.record(x.id)) })));

  const detail: ChannelDetailModel | undefined = picked && {
    id: picked.id,
    icon: picked.id,
    name: picked.name,
    state: { label: stateLabel(picked), tone: TONE[stateOf(picked, st)] },
    provider: picked.provider,
    address: picked.address,
    entra: inWords(`in-${picked.entra}`),
    esce: inWords(`out-${picked.esce}`),
    volume: CHANNEL_VOLUME[picked.id],
    volumeNote: volumeNote(picked),
    flow: flowName(picked),
    onOpenFlow: picked.flow ? () => ctx.go(P.flow(picked.flow!)) : undefined,
    beforeExit: picked.beforeExit ?? ctx.copy.viewsMore.channels.none,
    policy: picked.policy,
    messages: messagesOf(picked),
    rules: rulesOf(picked, st).map((r) => ({
      id: r.id, when: r.when, then: r.then, on: r.on,
      onToggle: ctx.allow('edit:structure', () => {
        setSt((p: ChannelsState) => ({ ...p, rules: { ...p.rules, [picked.id]: rulesOf(picked, p).map((x) => (x.id === r.id ? { ...x, on: !x.on } : x)) } }));
        ctx.log(r.on ? c.logRuleOff(picked.name, r.when) : c.logRuleOn(picked.name, r.when), 'structure', P.channels(picked.id));
      }),
      onDelete: ctx.allow('edit:structure', () => ctx.confirm({
        title: c.confirmRuleTitle,
        body: c.confirmRuleBody(r.when),
        confirmLabel: c.deleteRule,
        tone: 'danger',
        onConfirm: () => {
          setSt((p: ChannelsState) => ({ ...p, rules: { ...p.rules, [picked.id]: rulesOf(picked, p).filter((x) => x.id !== r.id) } }));
          ctx.log(c.logRuleDeleted(picked.name, r.when), 'structure', P.channels(picked.id));
          ctx.toast({ tone: 'info', title: c.toastRuleDeleted });
        },
      })),
      onOpenFlow: r.flow ? () => ctx.go(P.flow(r.flow!)) : undefined,
    })),
    receipts: st.receipts[picked.id] ?? [],
    error: st.errors[picked.id],
  };

  const actions: ChannelActionModel[] = [];
  if (picked) {
    const s = stateOf(picked, st);
    if (s === 'pending' || s === 'testing') actions.push({ id: 'connect', label: c.connectOne, variant: 'primary', onClick: connect(picked) });
    if (s === 'paused') actions.push({ id: 'resume', label: c.resume, variant: 'primary', onClick: resume(picked) });
    if (s !== 'pending') actions.push({ id: 'test', label: picked.esce !== 'no' ? c.testOut : c.testIn, onClick: test(picked) });
    if (s === 'connected') actions.push({ id: 'pause', label: c.pause, variant: 'danger', onClick: pause(picked) });
  }
  const pickedJob = picked ? [ctx.job(`channel-${picked.id}`), ctx.job(`channel-test-${picked.id}`)].find((j) => j?.status === 'running') : undefined;

  const first = CASES.find((x) => x.id === '2418');
  const personName = first?.counterpart ?? SAME_PERSON.fallbackName;
  const samePerson: SamePersonModel = {
    name: personName,
    note: SAME_PERSON.note,
    items: SAME_PERSON.items.map((it, i) => ({
      id: `${it.channel}-${i}`,
      icon: it.channel,
      text: it.text,
      at: formatShortDay(it.day),
      onOpen: it.caseId && CASES.some((x) => x.id === it.caseId) ? () => ctx.go(P.record(it.caseId!)) : undefined,
    })),
  };

  const toConnect = CHANNELS.filter((x) => stateOf(x, st) !== 'connected');
  const connectId = toConnect.some((x) => x.id === connectPick) ? connectPick : toConnect[0]?.id ?? '';

  return (
    <>
      <ChannelsScreen
        copy={ctx.copy}
        rows={rows}
        stats={stats}
        detail={detail}
        actions={actions}
        job={pickedJob ? { title: pickedJob.title, progress: pickedJob.progress, detail: pickedJob.current ?? '' } : undefined}
        samePerson={samePerson}
        onConnect={ctx.allow('edit:structure', () => setConnectOpen(true))}
        onBack={() => ctx.go(P.channels())}
        backLabel={ctx.copy.shell.nav.channels}
        onAddRule={ctx.allow('edit:structure', () => setRule({ ...EMPTY_RULE, open: true, flow: '' }))}
        canEditRules={canEdit}
        deniedTitle={denied}
        phone={ctx.phone}
      />
      {connectOpen && (
        <Dialog
          title={c.connectTitle}
          size="sm"
          closeLabel={ctx.copy.common.close}
          onClose={() => setConnectOpen(false)}
          footer={toConnect.length ? (
            <>
              <Button onClick={() => setConnectOpen(false)}>{c.cancel}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const seed = toConnect.find((x) => x.id === connectId);
                  if (!seed) return;
                  setConnectOpen(false);
                  ctx.go(P.channels(seed.id));
                  const run = connect(seed);
                  if (run) run();
                }}
              >
                {c.connectOne}
              </Button>
            </>
          ) : <Button onClick={() => setConnectOpen(false)}>{c.cancel}</Button>}
        >
          {toConnect.length ? (
            <div className="flex flex-col gap-3">
              <p>{c.connectBody}</p>
              <Select label={c.connectPick} value={connectId} onChange={setConnectPick} options={toConnect.map((x) => ({ value: x.id, label: `${x.name} · ${c.states[stateOf(x, st)]}` }))} />
            </div>
          ) : (
            <EmptyState title={c.connectNone}>{c.connectNoneBody}</EmptyState>
          )}
        </Dialog>
      )}
      {rule.open && picked && (
        <RuleDialog
          copy={ctx.copy}
          draft={rule}
          onDraft={(patch) => setRule({ ...rule, ...patch })}
          flows={FLOWS.filter((f) => f.org === 'nocera' && f.status !== 'spento')} // allow-italian: a status id of the flows fixture
          onClose={() => setRule(EMPTY_RULE)}
          onSubmit={() => {
            if (!rule.when.trim() || !rule.then.trim()) {
              setRule({ ...rule, tried: true });
              return;
            }
            const id = `r${hashText(`${rule.when}${(st.rules[picked.id] ?? picked.rules).length}`).toString(36).slice(0, 4)}`;
            setSt((p: ChannelsState) => ({ ...p, rules: { ...p.rules, [picked.id]: [...rulesOf(picked, p), { id, when: rule.when.trim(), then: rule.then.trim(), flow: rule.flow || undefined, on: true }] } }));
            ctx.log(c.logRuleAdded(picked.name, rule.when.trim()), 'structure', P.channels(picked.id));
            ctx.toast({ tone: 'ok', title: c.toastRuleAdded });
            setRule(EMPTY_RULE);
          }}
        />
      )}
    </>
  );
}
