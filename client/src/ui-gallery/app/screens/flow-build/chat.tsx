/** n03 and o02: a flow built from a conversation, and an interview that captures what a person knows. */
import { Sparkles, Trash2 } from 'lucide-react';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { BackButton, PaneHeader } from '../../../../ui/shell/PaneHeader';
import { ChatComposer, ChatSplit, ChatThread, DraftStepList, MicMark, type ChatItemModel } from '../../../../ui/flows/BuildChat';
import { InterviewSide, type InterviewOutputModel } from '../../../../ui/flows/Interview';
import type { FlowStepModel } from '../../../../ui/flows/model';
import { INTERVIEW, INVOICE_CHAT, type ChatDraftStep } from '../../../../ui/fixtures/flow-build';
import type { FlowStepSeed } from '../../../../ui/fixtures/org/types';
import type { StepDetail } from '../../../../ui/fixtures/flows';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { createFlow, useFlowsSlice } from './actions';
import { actorsOf } from './model';

interface Turn { role: 'user' | 'assistant'; text: string }

interface InvoiceState {
  answers: Record<string, string>;
  notes: string[];
  /** What the person said about the visto, shown on its step. */
  vistoNote?: string;
  extra: Turn[];
  created?: string;
  discarded?: boolean;
}
const INVOICE_START: InvoiceState = { answers: {}, notes: [], extra: [] };

/** The draft as the answers so far leave it: each answered question settles its step. */
function draftSteps(state: InvoiceState): ChatDraftStep[] {
  return INVOICE_CHAT.draft.map((s) => {
    const a = s.question ? state.answers[s.question] : undefined;
    if (s.question === 'visto' && a) {
      const x = INVOICE_CHAT.answerLabel.visto[a as keyof typeof INVOICE_CHAT.answerLabel.visto];
      return { ...s, label: x.label, office: x.office, question: undefined, detail: state.vistoNote ?? s.detail?.replace(': chi?', '') };
    }
    if (s.question === 'registra' && a) {
      const x = INVOICE_CHAT.answerLabel.registra[a as keyof typeof INVOICE_CHAT.answerLabel.registra];
      return { ...s, label: x.label, kind: x.kind, program: x.kind === 'robot' ? 'TeamSystem' : undefined, question: undefined };
    }
    return s;
  });
}

const seedKind = (k: ChatDraftStep['kind']): FlowStepSeed['kind'] => (k === 'action' ? 'send' : k === 'trigger' ? 'rule' : k);

export function InvoiceChatPage({ ctx }: { ctx: ScreenCtx }) {
  const t = ctx.copy.flowBuild;
  const c = t.chat;
  const [slice, setSlice] = useFlowsSlice(ctx);
  const [state, setState] = ctx.ui<InvoiceState>('chat.invoice', INVOICE_START);
  const [input, setInput] = ctx.ui('chat.invoice.input', '');
  const draft = draftSteps(state);
  const undecided = draft.filter((s) => s.question).length;
  const flowName = `${INVOICE_CHAT.flowName} ${c.draftSuffix}`;

  const stepModels: FlowStepModel[] = draft.filter((s) => s.kind !== 'trigger').map((s, i) => ({
    id: s.id, marker: String(i + 1), actors: actorsOf(seedKind(s.kind), s.program, ctx.copy), title: s.label, note: s.detail,
    due: s.question ? c.toDecide : undefined,
  }));
  const triggerStep = draft.find((s) => s.kind === 'trigger')!;
  const trigger: FlowStepModel = { id: 'trigger', actors: [{ kind: 'trigger' }], title: triggerStep.label, note: triggerStep.detail };

  const answer = (qid: string, oid: string) => {
    const q = INVOICE_CHAT.questions.find((x) => x.id === qid)!;
    const opt = q.options.find((o) => o.id === oid)!;
    const next: InvoiceState = { ...state, answers: { ...state.answers, [qid]: oid } };
    const step = draftSteps(next).find((s) => s.id === (qid === 'visto' ? 's4' : 's5'))!;
    const turns: Turn[] = [{ role: 'user', text: opt.label }, { role: 'assistant', text: INVOICE_CHAT.reply.answered(step.label) }];
    if (INVOICE_CHAT.questions.every((x) => next.answers[x.id])) turns.push({ role: 'assistant', text: INVOICE_CHAT.reply.complete });
    setState({ ...next, extra: [...state.extra, ...turns] });
  };

  const send = () => {
    const text = input.trim();
    const amount = text.match(/\d[\d.,]*/)?.[0];
    const skipsVisto = /visto/i.test(text) && /(niente|senza|non serve)/i.test(text) && amount;
    const reply = skipsVisto ? INVOICE_CHAT.reply.threshold(amount!) : INVOICE_CHAT.reply.generic(text.length > 60 ? `${text.slice(0, 57)}...` : text);
    setState({
      ...state,
      vistoNote: skipsVisto ? INVOICE_CHAT.reply.vistoNote(amount!) : state.vistoNote,
      notes: skipsVisto ? state.notes : [...state.notes, text],
      extra: [...state.extra, { role: 'user', text }, { role: 'assistant', text: reply }],
    });
    setInput('');
  };

  const create = ctx.allow('edit:structure', () => {
    const steps: FlowStepSeed[] = draft.filter((s) => s.kind !== 'trigger').map((s) => ({ id: s.id, label: s.label, kind: seedKind(s.kind), program: s.program, office: s.office }));
    const details: Record<string, StepDetail> = Object.fromEntries(draft.filter((s) => s.kind !== 'trigger').map((s) => [s.id, { note: s.detail }]));
    const id = createFlow(ctx, slice, setSlice, {
      name: flowName, trigger: INVOICE_CHAT.flowTrigger, office: INVOICE_CHAT.flowOffice, steps, origin: 'chat', details,
    });
    setState({ ...state, created: id });
    ctx.go(P.flow(id));
  });

  const discard = () => ctx.confirm({
    title: c.discardTitle,
    body: c.discardBody,
    confirmLabel: c.discard,
    tone: 'danger',
    onConfirm: () => {
      setState({ ...INVOICE_START, discarded: true });
      ctx.log(t.log.discarded(INVOICE_CHAT.flowName), 'structure', P.chat('nuovo-flusso-fatture'));
      ctx.toast({ tone: 'warn', title: c.discarded });
    },
  });

  const header = (
    <PaneHeader
      crumbs={[{ label: INVOICE_CHAT.flowName }]}
      leading={<BackButton label={ctx.copy.flows.root} onClick={() => ctx.go(P.flows())} copy={ctx.copy} />}
      status={ctx.phone ? undefined : (
        <span className="inline-flex items-center gap-1.5">
          <Chip icon={Sparkles}>{c.draftFromChat}</Chip>
          <Chip tone="green">{t.list.newBlocks(draft.length)}</Chip>
        </span>
      )}
    >
      {!state.discarded && <Button icon={Trash2} onClick={discard}>{c.discard}</Button>}
      {state.created
        ? <Button variant="primary" onClick={() => ctx.go(P.flow(state.created!))}>{c.openFlow}</Button>
        : <Button variant="primary" onClick={create} title={ctx.deniedTitle('edit:structure')}>{c.create}</Button>}
    </PaneHeader>
  );

  if (state.discarded) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <EmptyState icon={Trash2} title={c.discarded} action={<Button variant="primary" onClick={() => setState(INVOICE_START)}>{c.restart}</Button>}>
          {c.discardedBody}
        </EmptyState>
      </div>
    );
  }

  const items: ChatItemModel[] = [
    { kind: 'message', id: 'u0', role: 'user', text: INVOICE_CHAT.userText },
    { kind: 'message', id: 'a0', role: 'assistant', text: INVOICE_CHAT.intro },
    { kind: 'message', id: 'a1', role: 'assistant', text: INVOICE_CHAT.needTwo },
    {
      kind: 'questions', id: 'q',
      questions: INVOICE_CHAT.questions.map((q) => ({ ...q, answer: state.answers[q.id] })),
    },
    { kind: 'note', id: 'n0', text: INVOICE_CHAT.sources },
    ...state.extra.map((m, i) => ({ kind: 'message' as const, id: `x${i}`, role: m.role, text: m.text })),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <ChatSplit
        phone={ctx.phone}
        thread={<ChatThread items={items} onAnswer={answer} recommendedLabel={ctx.copy.flowBuild.chat.recommended} scrollToEnd={state.extra.length > 0} />}
        composer={<ChatComposer copy={ctx.copy} value={input} onChange={setInput} onSend={send} placeholder={c.placeholder} />}
        side={(
          <div className="flex flex-col gap-3">
            <p className="text-compact text-app-text-tertiary">{undecided > 0 ? c.openQuestions(undecided) : c.allDecided}</p>
            <DraftStepList trigger={trigger} steps={stepModels} copy={ctx.copy} />
            {state.notes.length > 0 && (
              <section className="rounded-lg border border-app-border bg-surface px-4 py-3">
                <h3 className="text-prose font-semibold text-app-text">{c.notesTitle}</h3>
                <ul className="mt-1 list-disc pl-5 text-prose text-app-text-secondary">
                  {state.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </section>
            )}
          </div>
        )}
      />
    </div>
  );
}

/* ---------- o02 ---------- */

interface InterviewState {
  extra: Turn[];
  paused: boolean;
  added: boolean;
  requested: boolean;
  flow?: string;
}
const INTERVIEW_START: InterviewState = { extra: [], paused: false, added: false, requested: false };

export function InterviewPage({ ctx }: { ctx: ScreenCtx }) {
  const t = ctx.copy.flowBuild;
  const c = t.interview;
  const [slice, setSlice] = useFlowsSlice(ctx);
  const [state, setState] = ctx.ui<InterviewState>('chat.interview', INTERVIEW_START);
  const [input, setInput] = ctx.ui('chat.interview.input', '');
  const answers = state.extra.filter((x) => x.role === 'user').length;

  const send = () => {
    const text = input.trim();
    const next = INTERVIEW.nextQuestions[answers] ?? INTERVIEW.closing;
    setState({ ...state, extra: [...state.extra, { role: 'user', text }, { role: 'assistant', text: next }] });
    setInput('');
  };

  const items: ChatItemModel[] = [
    ...INTERVIEW.turns.map((m, i): ChatItemModel => (m.role === 'assistant'
      ? { kind: 'message', id: `t${i}`, role: 'assistant', text: m.text, speaker: c.assistant }
      : { kind: 'message', id: `t${i}`, role: 'user', text: m.text })),
    ...state.extra.map((m, i): ChatItemModel => (m.role === 'assistant'
      ? { kind: 'message', id: `e${i}`, role: 'assistant', text: m.text, speaker: c.assistant }
      : { kind: 'message', id: `e${i}`, role: 'user', text: m.text })),
  ];

  const add = ctx.allow('edit:data', () => {
    setState({ ...state, added: true });
    ctx.log(c.addedLog(INTERVIEW.fact.title), 'knowledge', P.knowledgeMap());
    ctx.toast({ tone: 'ok', title: c.addedToast, body: INTERVIEW.fact.title, action: { label: c.openMap, path: P.knowledgeMap() } });
  });

  const requestCard = ctx.allow('edit:data', () => {
    setState({ ...state, requested: true });
    ctx.notify({ title: c.requestNotify, body: INTERVIEW.outputs[1].title, path: P.inbox(), tone: 'info' });
    ctx.log(c.requestLog, 'knowledge', P.board('nocera'));
    ctx.toast({ tone: 'ok', title: c.requestToast, action: { label: c.openBoard, path: P.board('nocera') } });
  });

  const draftFlow = ctx.allow('edit:structure', () => {
    const f = INTERVIEW.draftFlow;
    const id = createFlow(ctx, slice, setSlice, { name: f.name, trigger: f.trigger, office: f.office, steps: f.steps, origin: 'interview' });
    setState({ ...state, flow: id });
  });

  const outputs: InterviewOutputModel[] = INTERVIEW.outputs.map((o) => {
    switch (o.kind) {
      case 'procedure':
        return { id: o.id, kind: o.kind, title: o.title, state: c.states.procedure, tone: 'amber', actionLabel: c.actions.procedure, onAction: () => ctx.go(P.knowledge()), done: false };
      case 'request':
        return state.requested
          ? { id: o.id, kind: o.kind, title: o.title, state: c.states.requestDone, tone: 'neutral', actionLabel: c.actions.requestDone, onAction: () => ctx.go(P.board('nocera')), done: true }
          : { id: o.id, kind: o.kind, title: o.title, state: c.states.request, tone: 'neutral', actionLabel: c.actions.request, onAction: requestCard, done: false };
      case 'flow':
        return state.flow
          ? { id: o.id, kind: o.kind, title: o.title, state: c.states.flowDone, tone: 'pink', actionLabel: c.actions.flowDone, onAction: () => ctx.go(P.flow(state.flow!)), done: true }
          : { id: o.id, kind: o.kind, title: o.title, state: c.states.flow, tone: 'neutral', actionLabel: c.actions.flow, onAction: draftFlow, done: false };
      case 'person':
        return { id: o.id, kind: o.kind, title: o.title, state: c.states.person, tone: 'neutral', actionLabel: c.actions.person, onAction: () => ctx.go(P.settings('persone')), done: false };
    }
  });

  const fact = INTERVIEW.fact;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        crumbs={[{ label: c.crumbRoot }, { label: c.crumbMapping }, { label: c.title(INTERVIEW.personRole) }]}
        leading={<BackButton label={ctx.copy.flows.root} onClick={() => ctx.go(P.flows())} copy={ctx.copy} />}
        status={ctx.phone ? undefined : (
          <span className="inline-flex items-center gap-1.5">
            <Chip tone={state.paused ? 'neutral' : 'red'}>{state.paused ? c.paused : c.recording}</Chip>
            <Chip>{c.exampleInterview}</Chip>
          </span>
        )}
      >
        <span className="text-compact text-app-text-tertiary">{c.meta(INTERVIEW.duration)}</span>
      </PaneHeader>
      <ChatSplit
        phone={ctx.phone}
        thread={<ChatThread items={items} scrollToEnd={state.extra.length > 0} />}
        composer={(
          <ChatComposer
            copy={ctx.copy}
            value={input}
            onChange={setInput}
            onSend={send}
            placeholder={c.placeholder}
            lead={<MicMark live={!state.paused} label={state.paused ? c.paused : c.recording} />}
            trailing={<Button onClick={() => setState({ ...state, paused: !state.paused })}>{state.paused ? c.resume : c.pause}</Button>}
          />
        )}
        side={(
          <InterviewSide
            copy={ctx.copy}
            facts={[{
              id: fact.id, title: fact.title,
              rows: [{ label: c.who, value: fact.who }, { label: c.often, value: fact.often }, { label: c.programs, value: fact.programs }],
              data: fact.data.map((d) => ({ kind: d.kind, name: d.name })), exception: fact.exception, missing: fact.missing, added: state.added,
            }]}
            outputs={outputs}
            onAdd={() => add}
            onOpenMap={() => ctx.go(P.knowledgeMap())}
            onOpenMissing={() => (state.requested ? ctx.go(P.board('nocera')) : ctx.toast({ tone: 'info', title: c.missingToast }))}
          />
        )}
      />
    </div>
  );
}
