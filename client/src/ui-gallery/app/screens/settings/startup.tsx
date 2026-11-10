/** Settings · Start-up (`o01`): the seven steps of starting an organization, with real state: tasks to tick, interviews to mark, steps to close. */
import { ArrowUpRight, CalendarClock, MessageSquare, Plus } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import type { StartupStepId } from '../../../../ui/settings/model';
import { P } from '../../paths';
import { settingsFrame } from '../settings-frame';
import { Block, ListRow } from '../../../../ui/settings/Block';
import { Fact, StartupSteps, TaskList, Ticks, type StartupState } from '../../../../ui/settings/Startup';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { addDays, daysFromToday, DEMO_TODAY } from '../../../../ui/fixtures/org/clock';
import { INTERVIEW_POOL, INTERVIEWS_SCHEDULED_AT_START, ORG_IDENTITY, STARTUP, STARTUP_STEPS, STARTUP_TEXT } from '../../../../ui/fixtures/settings';
import { adminGate, dayText, shortDay } from './helpers';

interface StartupStateSlice {
  /** Tasks ticked, `step.task`. */
  tasks: Record<string, boolean>;
  /** The day each closed step was done. */
  stepsDone: Partial<Record<StartupStepId, string>>;
  doneInterviews: string[];
  scheduled: string[];
}

const initial = (): StartupStateSlice => ({
  tasks: Object.fromEntries(STARTUP_STEPS.flatMap((s) => s.tasks.map((t) => [`${s.id}.${t.id}`, t.done]))),
  stepsDone: Object.fromEntries(STARTUP_STEPS.filter((s) => s.doneOn).map((s) => [s.id, s.doneOn])) as Partial<Record<StartupStepId, string>>,
  doneInterviews: [],
  scheduled: INTERVIEW_POOL.slice(0, INTERVIEWS_SCHEDULED_AT_START).map((i) => i.id),
});

/** Where each step leads in the app. */
const STEP_PATH: Record<StartupStepId, string> = {
  connect: P.programs(),
  documents: P.knowledge(),
  mapping: P.knowledgeMap(),
  procedures: P.knowledge(),
  trial: P.flow('pec'),
  launch: P.testAll(),
  upkeep: P.knowledgeMap(),
};

export function StartupPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.settings;
  const s = c.startup;
  const gate = adminGate(ctx);
  const [st, setSt] = ctx.slice<StartupStateSlice>('startup', initial());

  const week = Math.floor(-daysFromToday(STARTUP.startDay) / 7) + 1;
  const weekStart = (n: number) => addDays(STARTUP.startDay, 7 * (n - 1));

  const taskKey = (step: StartupStepId, task: string) => `${step}.${task}`;
  const tasksDone = (step: StartupStepId) => STARTUP_STEPS.find((x) => x.id === step)!.tasks.filter((t) => st.tasks[taskKey(step, t.id)]).length;

  /* The state of each step comes from what is done: the first one open is the current one. */
  const doneOf = (id: StartupStepId) => st.stepsDone[id];
  const planned = STARTUP_STEPS.filter((x) => x.id !== 'upkeep');
  const currentId = planned.find((x) => !doneOf(x.id))?.id;
  const stateOf = (id: StartupStepId): StartupState => {
    const seed = STARTUP_STEPS.find((x) => x.id === id)!;
    if (id === 'upkeep') return 'always';
    if (doneOf(id)) return 'done';
    // Steps overlap: one already started (the PEC trial) is under way even while the first open one is still current.
    if (id === currentId || tasksDone(id) > 0) return 'current';
    return seed.weeks && seed.weeks[0] <= week + 1 ? 'next' : 'later';
  };

  const [pickedStep, setPickedStep] = ctx.ui<StartupStepId | null>('avvio.step', null); // allow-italian: address and state key of a settings section
  const selectedId: StartupStepId = pickedStep ?? currentId ?? 'upkeep';
  const selectedSeed = STARTUP_STEPS.find((x) => x.id === selectedId)!;
  const selectedState = stateOf(selectedId);
  const selectedNumber = STARTUP_STEPS.findIndex((x) => x.id === selectedId) + 1;

  const interviewed = Math.min(STARTUP.people, STARTUP.interviewed + st.doneInterviews.length);
  const activities = STARTUP.activities + STARTUP.perInterview * st.doneInterviews.length;
  const documentedPct = Math.round((STARTUP.documented / activities) * 100);
  const mappingShare = interviewed / STARTUP.people;

  const toggleTask = (step: StartupStepId, task: string, on: boolean) => {
    setSt((prev) => ({ ...prev, tasks: { ...prev.tasks, [taskKey(step, task)]: on } }));
    ctx.log(s.log.task(STARTUP_TEXT[step].tasks[task], on), 'setting', ctx.path);
  };

  const completeStep = (id: StartupStepId) =>
    ctx.confirm({
      title: s.confirm.title(STARTUP_TEXT[id].title),
      body: s.confirm.body,
      confirmLabel: s.confirm.label,
      onConfirm: () => {
        const seed = STARTUP_STEPS.find((x) => x.id === id)!;
        setSt((prev) => ({
          ...prev,
          stepsDone: { ...prev.stepsDone, [id]: ctx.now.slice(0, 10) },
          tasks: { ...prev.tasks, ...Object.fromEntries(seed.tasks.map((t) => [taskKey(id, t.id), true])) },
        }));
        setPickedStep(null);
        ctx.log(s.log.stepDone(STARTUP_TEXT[id].title), 'setting', ctx.path);
        ctx.notify({ title: s.notify.stepDone(STARTUP_TEXT[id].title), body: s.notify.body, path: P.settings('avvio'), tone: 'ok' }); // allow-italian: address and state key of a settings section
        ctx.toast({ tone: 'ok', title: s.toasts.stepDone(STARTUP_TEXT[id].title) });
      },
    });

  const markInterview = (id: string) => {
    const item = INTERVIEW_POOL.find((i) => i.id === id)!;
    setSt((prev) => ({ ...prev, doneInterviews: [...prev.doneInterviews, id], scheduled: prev.scheduled.filter((x) => x !== id) }));
    ctx.log(s.log.interviewDone(OFFICE_LABEL[item.office]), 'setting', ctx.path);
    ctx.toast({ tone: 'ok', title: s.toasts.interviewDone(OFFICE_LABEL[item.office]) });
  };

  const nextToPlan = INTERVIEW_POOL.find((i) => !st.scheduled.includes(i.id) && !st.doneInterviews.includes(i.id));
  const planInterview = () => {
    if (!nextToPlan) return;
    setSt((prev) => ({ ...prev, scheduled: [...prev.scheduled, nextToPlan.id] }));
    ctx.log(s.log.planned(OFFICE_LABEL[nextToPlan.office]), 'setting', ctx.path);
    ctx.toast({ tone: 'ok', title: s.toasts.planned(OFFICE_LABEL[nextToPlan.office]) });
  };

  const scheduled = INTERVIEW_POOL.filter((i) => st.scheduled.includes(i.id));
  const when = (day: string, time: string) => (day === DEMO_TODAY ? `${s.panel.today} ${time}` : `${shortDay(day)} ${time}`);

  const stepModels = STARTUP_STEPS.map((seed, i) => {
    const state = stateOf(seed.id);
    const text = STARTUP_TEXT[seed.id];
    const doneDay = doneOf(seed.id);
    const weeks = seed.weeks ? s.weeks(seed.weeks[0], seed.weeks[1]) : '';
    const whenText =
      state === 'done' && doneDay ? s.panel.doneOn(dayText(doneDay))
        : state === 'current' && seed.id === currentId ? `${weeks} · ${s.panel.of(interviewed, STARTUP.people)}`
          : seed.weeks ? `${s.from(shortDay(weekStart(seed.weeks[0])))}, ${weeks}` : '';
    return {
      id: seed.id,
      number: i + 1,
      state,
      stateLabel: s.states[state],
      title: text.title,
      text: text.text,
      when: whenText,
      progress: s.panel.tasksDone(tasksDone(seed.id), seed.tasks.length),
      selected: seed.id === selectedId,
      onSelect: () => setPickedStep(seed.id),
    };
  });

  const text = STARTUP_TEXT[selectedId];

  return settingsFrame(ctx, 'avvio', { // allow-italian: address and state key of a settings section
    children: (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h2 className="text-body-lg font-semibold text-app-text">{s.title(ORG_IDENTITY.shortName)}</h2>
          <Chip>{s.internal}</Chip>
          <Chip tone="amber">{c.common.exampleData}</Chip>
          <span className="text-compact text-app-text-tertiary">
            {s.progress(dayText(STARTUP.startDay), dayText(DEMO_TODAY), week, STARTUP.totalWeeks)}
          </span>
        </div>

        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
          <StartupSteps steps={stepModels} ariaLabel={s.title(ORG_IDENTITY.shortName)} />

          <div className="flex min-w-0 flex-col gap-4">
            <Block
              title={text.title}
              description={text.text}
              actions={<Chip tone={selectedState === 'done' ? 'green' : selectedState === 'current' ? 'blue' : 'neutral'}>{s.panel.stepTag(selectedNumber)}</Chip>}
              bodyClassName="flex flex-col gap-3"
            >
              <div>
                <div className="mb-1 flex items-baseline justify-between text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">
                  <span>{s.panel.tasks}</span>
                  <span className="tabular-nums normal-case tracking-normal">{s.panel.tasksDone(tasksDone(selectedId), selectedSeed.tasks.length)}</span>
                </div>
                <TaskList
                  tasks={selectedSeed.tasks.map((t) => ({
                    id: t.id,
                    label: text.tasks[t.id],
                    done: !!st.tasks[taskKey(selectedId, t.id)],
                    onToggle: (on) => toggleTask(selectedId, t.id, on),
                    disabled: gate.disabled,
                    title: gate.title,
                  }))}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" icon={ArrowUpRight} onClick={() => ctx.go(STEP_PATH[selectedId])}>{s.links[selectedId]}</Button>
                {selectedState === 'current' && (
                  <Button variant="primary" onClick={ctx.allow('admin', () => completeStep(selectedId))} title={gate.title}>{s.panel.completeStep}</Button>
                )}
              </div>
            </Block>

            {selectedId === 'mapping' && (
              <Block title={s.panel.progress} bodyClassName="flex flex-col gap-3">
                <div>
                  <div className="mb-1 flex justify-end text-compact font-semibold tabular-nums text-sky-700 dark:text-sky-300">{Math.round(mappingShare * 100)}%</div>
                  <Ticks value={mappingShare} label={s.panel.interviewed} />
                </div>
                <div>
                  <Fact label={s.panel.interviewed} value={s.panel.of(interviewed, STARTUP.people)} />
                  <Fact label={s.panel.activities} value={activities} />
                  <Fact label={s.panel.documented} value={s.panel.documentedValue(STARTUP.documented, documentedPct)} />
                </div>
              </Block>
            )}

            {selectedId === 'mapping' && (
              <Block title={s.panel.next} bodyClassName="flex flex-col gap-1">
                {scheduled.length === 0 ? (
                  <EmptyState icon={CalendarClock} title={s.panel.noneScheduled} className="min-h-0 py-5" />
                ) : (
                  scheduled.map((i) => (
                    <ListRow
                      key={i.id}
                      icon={CalendarClock}
                      title={s.panel.interviewWith(OFFICE_LABEL[i.office])}
                      detail={when(i.day, i.time)}
                      trailing={
                        <>
                          {i.id === 'catasto' && (
                            <Button size="sm" variant="ghost" icon={MessageSquare} onClick={() => ctx.go(P.chat('intervista-catasto'))}>{s.panel.openInterview}</Button>
                          )}
                          <Button size="sm" variant="secondary" onClick={ctx.allow('admin', () => markInterview(i.id))} title={gate.title}>{s.panel.markDone}</Button>
                        </>
                      }
                    />
                  ))
                )}
                {nextToPlan ? (
                  <div className="pt-2">
                    <Button size="sm" icon={Plus} onClick={ctx.allow('admin', planInterview)} title={gate.title}>{s.panel.plan}</Button>
                  </div>
                ) : (
                  <p className="pt-2 text-compact text-app-text-tertiary">{s.panel.allScheduled}</p>
                )}
                <div className="pt-3">
                  <Button variant="primary" icon={ArrowUpRight} onClick={() => ctx.go(P.knowledgeMap())}>{s.openMap}</Button>
                </div>
              </Block>
            )}
          </div>
        </div>
      </div>
    ),
  });
}
