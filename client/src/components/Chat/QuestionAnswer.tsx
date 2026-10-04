/**
 * The answer given to an agent's question, as it stays in the thread.
 *
 * Two forms, for two readings. Closed (`QuestionAnswerRecap`) is one line per
 * question, "question -> choice", under the tool header and OUTSIDE the
 * collapsible body: whoever scrolls the chat sees what was picked without
 * opening anything, as the CLI prints it under the call. Open
 * (`QuestionAnswerCard`) is the whole question with every option offered, the
 * pick ticked and the rest dimmed: the trace you reread to see what the choice
 * was made from.
 */
import { ArrowRight, Check, CornerDownRight } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { ToolUserResponse, UserInputSchema } from '../../types';
import {
  readAnsweredQuestions,
  readElicitationAnswer,
  type AnswerPart,
  type AskedQuestion,
  type ElicitationAnswer,
  type ElicitationValue,
} from './questionAnswers';

type Translate = ReturnType<typeof useT>;

/** The value as it reads: picks separated by commas, free text in quotes. */
function answerText(parts: readonly AnswerPart[], tr: Translate): string {
  return parts.map((p) => (p.free ? tr('chat.question.answer.freeText', { text: p.text }) : p.text)).join(', ');
}

/** A field of an elicitation form as it reads: yes/no in the reader's language, a list with commas. */
function fieldText(value: ElicitationValue, tr: Translate): string {
  const one = (v: string | number | boolean) => (typeof v === 'boolean' ? tr(v ? 'chat.question.answer.yes' : 'chat.question.answer.no') : String(v));
  return Array.isArray(value) ? value.map(one).join(', ') : one(value);
}

/** The elicitation answer, field by field; null for any other kind. */
function elicitationOf(response: ToolUserResponse, schema: UserInputSchema | undefined): ElicitationAnswer | null {
  if (response.kind !== 'elicitation') return null;
  const form = schema?.kind === 'elicitation' ? schema : undefined;
  return readElicitationAnswer(form?.requestedSchema, form?.message, response.value);
}

/** The free text of a raw answer, in quotes; null when there is none. */
function rawAnswer(response: ToolUserResponse, tr: Translate): string | null {
  if (response.kind !== 'raw' || !response.text.trim()) return null;
  return tr('chat.question.answer.freeText', { text: response.text.trim() });
}

/**
 * One line of the closed row. The ANSWER IS NEVER CUT: it is what the person
 * picked or wrote, and on a 320 px pane `truncate` left «the copy ch…» with no
 * way to read the rest on touch, where `title` does not exist. The value wraps
 * instead. The question gives way: one line with an ellipsis, and when the
 * value does not fit beside it, the value goes under it at full width.
 */
function RecapLine({ question, answer, testId }: { question?: string; answer: string; testId: string }) {
  const tr = useT();
  // A question can span lines (context under its title): the closed row needs
  // only the first.
  const firstLine = question?.split('\n')[0];
  return (
    <div data-testid={testId} className="flex items-start gap-1.5 min-w-0 leading-snug">
      <CornerDownRight size={11} className="mt-[3px] flex-shrink-0 text-app-text-muted" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
        {firstLine && (
          <span className="flex min-w-0 max-w-full items-center gap-1.5 text-app-text-muted">
            <span data-testid="question-answer-question" className="min-w-0 truncate" title={question}>{firstLine}</span>
            <ArrowRight size={11} className="flex-shrink-0" aria-hidden="true" />
          </span>
        )}
        <span className="sr-only">{tr('chat.question.answer.srLabel')}</span>
        <span data-testid="question-answer-value" className="min-w-0 max-w-full whitespace-pre-wrap break-words font-medium text-app-text">
          {answer}
        </span>
      </div>
    </div>
  );
}

/**
 * Closed: one line per question, "question -> choice".
 *
 * A single question that the tool header already prints (`AskUserQuestion`
 * shows its first question there) is not written again: on a narrow pane the
 * same text twice took the room the answer needed. The line then says the
 * choice alone, under the question it answers.
 */
export function QuestionAnswerRecap({ toolCallId, asked, response, schema, headerQuestion }: {
  toolCallId: string;
  asked: readonly AskedQuestion[];
  response: ToolUserResponse;
  schema?: UserInputSchema;
  /** The question the row header already shows, if it shows one. */
  headerQuestion?: string;
}) {
  const tr = useT();
  const raw = rawAnswer(response, tr);
  const form = elicitationOf(response, schema);
  const answered = response.kind === 'questions'
    ? readAnsweredQuestions(asked, response.answers).filter((q) => q.parts.length > 0)
    : [];
  const saidInHeader = answered.length === 1 && !!headerQuestion && answered[0]!.question === headerQuestion;
  const lines = [
    ...answered.map((q) => ({ question: saidInHeader ? undefined : q.question, answer: answerText(q.parts, tr) })),
    ...(form?.fields ?? []).map((f) => ({ question: f.label, answer: fieldText(f.value, tr) })),
    ...(raw ? [{ question: undefined, answer: raw }] : []),
  ];
  if (lines.length === 0) return null;
  return (
    <div data-testid={`question-answer-${toolCallId}`} className="ml-5 mb-1 space-y-0.5 text-mini">
      {lines.map((l, i) => (
        <RecapLine key={`${toolCallId}-a-${i}`} testId="question-answer-line" question={l.question} answer={l.answer} />
      ))}
    </div>
  );
}

/** Open: each question with the options offered, the pick ticked. */
export function QuestionAnswerCard({ toolCallId, asked, response, schema }: {
  toolCallId: string;
  asked: readonly AskedQuestion[];
  response: ToolUserResponse;
  schema?: UserInputSchema;
}) {
  const tr = useT();
  const raw = rawAnswer(response, tr);
  const form = elicitationOf(response, schema);
  const questions = response.kind === 'questions' ? readAnsweredQuestions(asked, response.answers) : [];
  if (questions.length === 0 && !raw && !form?.fields.length) return null;
  return (
    <div data-testid={`question-answer-card-${toolCallId}`} className="mt-1.5 space-y-2">
      {questions.map((q, i) => {
        const free = q.parts.filter((p) => p.free);
        return (
          <div key={`${toolCallId}-q-${i}`} className="space-y-1">
            {q.header && <div className="text-mini uppercase tracking-wide text-app-text-muted">{q.header}</div>}
            <div className="text-mini text-app-text whitespace-pre-wrap break-words">{q.question}</div>
            <ul className="space-y-0.5">
              {q.options.map((o, j) => (
                <li
                  key={`${toolCallId}-q-${i}-o-${j}`}
                  data-testid="question-answer-option"
                  data-chosen={o.chosen ? 'true' : undefined}
                  className={`flex items-start gap-1.5 text-mini ${o.chosen ? 'font-medium text-app-text' : 'text-app-text-muted'}`}
                >
                  {/* The tick's slot is always there, or the options not picked
                      would start from a different column than the picked one. */}
                  {o.chosen
                    ? <Check size={12} className="mt-[2px] flex-shrink-0 text-primary" aria-label={tr('chat.question.answer.chosen')} />
                    : <span className="w-3 flex-shrink-0" aria-hidden="true" />}
                  <span className="min-w-0 break-words">{o.label}</span>
                </li>
              ))}
              {free.map((p, j) => (
                <li
                  key={`${toolCallId}-q-${i}-f-${j}`}
                  data-testid="question-answer-option"
                  data-chosen="true"
                  className="flex items-start gap-1.5 text-mini font-medium text-app-text"
                >
                  <Check size={12} className="mt-[2px] flex-shrink-0 text-primary" aria-label={tr('chat.question.answer.chosen')} />
                  <span className="min-w-0 break-words">
                    <span className="font-normal text-app-text-muted">{tr('ask.other')}: </span>
                    {tr('chat.question.answer.freeText', { text: p.text })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {/* An MCP form: what it asked, then each field as the person filled it,
          named as the form named it. Never the JSON on the wire. */}
      {form && form.fields.length > 0 && (
        <div className="space-y-1">
          {form.message && <div className="text-mini text-app-text whitespace-pre-wrap break-words">{form.message}</div>}
          <ul className="space-y-0.5">
            {form.fields.map((f, j) => (
              <li
                key={`${toolCallId}-f-${j}`}
                data-testid="question-answer-field"
                className="flex items-start gap-1.5 text-mini font-medium text-app-text"
              >
                <Check size={12} className="mt-[2px] flex-shrink-0 text-primary" aria-hidden="true" />
                <span className="min-w-0 whitespace-pre-wrap break-words">
                  {f.label && <span className="font-normal text-app-text-muted">{f.label}: </span>}
                  {fieldText(f.value, tr)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {raw && (
        <div className="flex items-start gap-1.5 text-mini font-medium text-app-text">
          <Check size={12} className="mt-[2px] flex-shrink-0 text-primary" aria-label={tr('chat.question.answer.chosen')} />
          <span className="min-w-0 whitespace-pre-wrap break-words">{raw}</span>
        </div>
      )}
    </div>
  );
}
