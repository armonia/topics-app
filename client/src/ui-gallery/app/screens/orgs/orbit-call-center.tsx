/**
 * s03 «Call center» of ORBIT: the call that rings, the form the AI fills from
 * what is said, the items that wait for a person, and the calls already
 * handled. A call and an item each have an address (`/orbit/call-center/<id>`).
 */
import { Headset } from 'lucide-react';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { CallCenterScreen } from '../../../../ui/orbit/CallCenterScreen';
import { CallDetail } from '../../../../ui/orbit/CallDetail';
import { TicketDetail } from '../../../../ui/orbit/TicketDetail';
import type { CallRowModel, TicketModel } from '../../../../ui/orbit/model';
import { INCOMING_CALL, RECENT_CALLS, TURN_CHOICES, type CallField, type QueueItemSeed } from '../../../../ui/fixtures/orbit';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import {
  ORBIT_INITIAL, callModel, callValues, findCall, findItem, itemState, liveService, openItems, ticketFromCall,
  type OrbitState,
} from './orbit-state';

const STEP_MS = 1100;

/** The minute stamp of the demo clock: the preview's «now» is fixed. */
const clockTime = (iso: string) => iso.slice(11, 16);

export function renderCallCenter(selected: string | undefined, ctx: ScreenCtx) {
  const c = ctx.copy.orgs.callCenter;
  const [st, setSt] = ctx.slice<OrbitState>('orbit', ORBIT_INITIAL);
  const [showErrors, setShowErrors] = ctx.ui<Record<string, boolean>>('callcenter.errors', {});
  const open = openItems(st);
  const time = clockTime(ctx.now);
  const denied = ctx.deniedTitle('edit:data');

  // Which place is open: an item, a call, or (by default) the first item that waits.
  const itemId = selected && findItem(st, selected) ? selected : undefined;
  const call = selected ? findCall(selected) : undefined;
  const current = selected ? itemId : open[0]?.id;

  const ageLabel = (item: QueueItemSeed) => (item.overdue ? c.overdue : c.minutes(item.ageMin));
  const queueRows: CallRowModel[] = open.map((i) => ({
    id: i.id, title: i.title, summary: i.summary, chip: i.chip, when: ageLabel(i), overdue: i.overdue, selected: current === i.id,
  }));
  const recentRows: CallRowModel[] = RECENT_CALLS.map((r) => ({
    id: r.id,
    title: r.caller,
    summary: callValues(st, r, r.transcript.length).kind,
    chip: (r.ticket || st.callTicket[r.id]) ? { text: c.reportOpened, tone: 'green' } : undefined,
    when: r.at,
    selected: call?.id === r.id,
  }));

  // The incoming call: ringing until answered, live while the job runs.
  const liveJob = ctx.job(`call:${INCOMING_CALL.id}`);
  const incomingStatus = st.answered.includes(INCOMING_CALL.id) || liveJob?.status === 'done' ? 'ended' : liveJob?.status === 'running' ? 'live' : 'ringing';

  const log = (what: string, path?: string) => ctx.log(what, 'case', path);
  const addEvent = (id: string, what: string) =>
    setSt((prev) => {
      const item = prev.items[id] ?? { status: 'open' as const, events: [] };
      return { ...prev, items: { ...prev.items, [id]: { ...item, events: [...item.events, { id: `e${item.events.length + 1}`, at: time, what }] } } };
    });

  /* ---- an item of the queue ---- */
  const renderItem = (id: string) => {
    const item = findItem(st, id);
    if (!item) return undefined;
    const is = itemState(st, id);
    const running = ['confirm', 'callback'].map((k) => ({ k, job: ctx.job(`${k}:${id}`) })).find((x) => x.job?.status === 'running');
    const ticket: TicketModel = {
      id,
      title: item.title,
      asked: item.asked,
      service: liveService(st, item),
      turnOptions: Array.from(new Set([liveService(st, item).turn, ...TURN_CHOICES])).map((t) => ({ value: t, label: t })),
      checked: item.checked,
      events: is.events,
      receipt: is.receipt,
      running: running?.job ? { label: running.job.current ?? running.job.title, progress: running.job.progress } : undefined,
    };
    const setService = (patch: Partial<QueueItemSeed['service']>) =>
      setSt((prev) => ({ ...prev, items: { ...prev.items, [id]: { ...itemState(prev, id), service: { ...itemState(prev, id).service, ...patch } } } }));
    const confirm = () => {
      const svc = liveService(st, item);
      ctx.startJob({
        id: `confirm:${id}`,
        title: c.confirmJob,
        steps: [{ label: c.confirmSteps[0], ms: 800 }, { label: c.confirmSteps[1], ms: 900 }, { label: c.confirmSteps[2], ms: 700 }],
        onDone: (ok) => {
          if (!ok) return;
          setSt((prev) => {
            const cur = itemState(prev, id);
            return {
              ...prev,
              items: {
                ...prev.items,
                [id]: {
                  ...cur,
                  status: 'confirmed',
                  receipt: { title: c.orderOpened(item.order), lines: [c.receiptTurn(svc.turn, svc.site), c.receiptNotice(svc.notice, time), c.receiptExample] },
                  events: [...cur.events, { id: `e${cur.events.length + 1}`, at: time, what: c.eventConfirmed(item.order) }],
                },
              },
            };
          });
          log(c.logConfirmed(item.title, item.order), P.orbitCallCenter(id));
          ctx.notify({ title: c.notifyOrder(item.order), body: item.title, path: P.orbitCallCenter(id), tone: 'ok' });
          ctx.toast({ tone: 'ok', title: c.toastConfirmed, body: c.orderOpened(item.order), action: { label: c.toastOpen, path: P.orbitCallCenter(id) } });
        },
      });
    };
    const changeTurn = () => {
      const svc = liveService(st, item);
      const at = TURN_CHOICES.indexOf(svc.turn);
      const next = TURN_CHOICES[(at + 1) % TURN_CHOICES.length];
      setService({ turn: next });
      addEvent(id, c.eventTurn(next));
      log(c.logTurn(item.title, next), P.orbitCallCenter(id));
      ctx.toast({ tone: 'info', title: c.toastTurn(next) });
    };
    const callBack = () => {
      const failsOnce = id === 'q-sfalci' && !(is.noAnswer);
      ctx.startJob({
        id: `callback:${id}`,
        title: c.callBackJob,
        steps: [{ label: c.callSteps[0], ms: 700 }, { label: c.callSteps[1], ms: 1200 }, ...(failsOnce ? [{ label: c.callSteps[2], ms: 600, fails: true }] : [{ label: c.callSteps[3], ms: 800 }])],
        onDone: (ok) => {
          if (ok) {
            addEvent(id, c.eventCalledBack);
            ctx.toast({ tone: 'ok', title: c.toastCalledBack });
          } else {
            setSt((prev) => {
              const cur = itemState(prev, id);
              return { ...prev, items: { ...prev.items, [id]: { ...cur, noAnswer: (cur.noAnswer ?? 0) + 1, events: [...cur.events, { id: `e${cur.events.length + 1}`, at: time, what: c.eventNoAnswer }] } } };
            });
            ctx.toast({ tone: 'error', title: c.toastNoAnswer, body: c.toastNoAnswerBody });
          }
          log(c.logCalledBack(item.title, ok), P.orbitCallCenter(id));
        },
      });
    };
    return (
      <TicketDetail
        ticket={ticket}
        copy={ctx.copy}
        onChange={setService}
        onConfirm={ctx.allow('edit:data', confirm)}
        onChangeTurn={ctx.allow('edit:data', changeTurn)}
        onCallBack={ctx.allow('edit:data', callBack)}
        actionsTitle={denied}
      />
    );
  };

  /* ---- a call ---- */
  const renderCall = (seed: NonNullable<typeof call>) => {
    const isIncoming = seed.id === INCOMING_CALL.id;
    const job = isIncoming ? liveJob : undefined;
    const status = isIncoming ? incomingStatus : 'ended';
    const heard = status === 'live' ? job?.done.length ?? 0 : undefined;
    const openingJob = ctx.job(`open:${seed.id}`);
    const opening = openingJob?.status === 'running' ? { label: openingJob.current ?? openingJob.title, progress: openingJob.progress } : undefined;
    const model = callModel(st, seed, ctx.copy, { status, heard, progress: job?.progress, showErrors: showErrors[seed.id], opening });
    const answer = () => {
      ctx.startJob({
        id: `call:${seed.id}`,
        title: c.callJob,
        steps: seed.transcript.map((l) => ({ label: l.text, ms: STEP_MS })),
        onDone: (ok) => {
          if (!ok) return;
          setSt((prev) => ({ ...prev, answered: [...prev.answered, seed.id] }));
          log(c.logAnswered(seed.caller), P.orbitCallCenter(seed.id));
          ctx.toast({ tone: 'ok', title: c.toastAnswered });
        },
      });
    };
    const openReport = () => {
      const values = callValues(st, seed, seed.transcript.length);
      if (!values.kind || !values.street) {
        setShowErrors({ ...showErrors, [seed.id]: true });
        ctx.toast({ tone: 'warn', title: c.toastMissing, body: c.toastMissingBody });
        return;
      }
      const created = ticketFromCall(st, seed, ctx.copy);
      ctx.startJob({
        id: `open:${seed.id}`,
        title: c.openJob,
        steps: [{ label: c.openSteps[0], ms: 700 }, { label: c.openSteps[1], ms: 800 }, { label: c.openSteps[2], ms: 700 }],
        onDone: (ok) => {
          if (!ok) return;
          setSt((prev) => ({ ...prev, seq: prev.seq + 1, tickets: [...prev.tickets, created], callTicket: { ...prev.callTicket, [seed.id]: created.id } }));
          log(c.logOpened(created.title), P.orbitCallCenter(created.id));
          ctx.toast({ tone: 'ok', title: c.toastOpened, body: created.title });
          ctx.go(P.orbitCallCenter(created.id));
        },
      });
    };
    return (
      <CallDetail
        call={model}
        copy={ctx.copy}
        onAnswer={ctx.allow('edit:data', answer)}
        onField={(field, value) => setSt((prev) => ({ ...prev, forms: { ...prev.forms, [seed.id]: { ...prev.forms[seed.id], [field as CallField]: value } } }))}
        onUseSuggestion={(street) => setSt((prev) => ({ ...prev, forms: { ...prev.forms, [seed.id]: { ...prev.forms[seed.id], street } } }))}
        onOpenReport={ctx.allow('edit:data', openReport)}
        onGoReport={() => { const t = model.ticketId; if (t) ctx.go(P.orbitCallCenter(t)); }}
        reportTitle={denied}
      />
    );
  };

  let detail;
  if (current) detail = renderItem(current);
  else if (call) detail = renderCall(call);
  else if (selected) {
    detail = (
      <EmptyState icon={Headset} title={c.notFound} action={<Button onClick={() => ctx.go(P.orbitCallCenter())}>{c.backToQueue}</Button>}>{c.notFoundBody}</EmptyState>
    );
  }

  const incomingSelected = call?.id === INCOMING_CALL.id;
  return (
    <CallCenterScreen
      incoming={{ id: INCOMING_CALL.id, caller: INCOMING_CALL.caller, status: incomingStatus, selected: incomingSelected }}
      onSelectIncoming={() => ctx.go(P.orbitCallCenter(INCOMING_CALL.id))}
      queue={queueRows}
      recent={recentRows}
      onSelect={(id) => ctx.go(P.orbitCallCenter(id))}
      copy={ctx.copy}
      phone={ctx.phone}
    >
      {detail}
    </CallCenterScreen>
  );
}
