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
import type { ToolUserResponse } from '../../types';
import { readAnsweredQuestions, type AnswerPart, type AskedQuestion } from './questionAnswers';

type Translate = ReturnType<typeof useT>;

/** The value as it reads: picks separated by commas, free text in quotes. */
function answerText(parts: readonly AnswerPart[], tr: Translate): string {
  return parts.map((p) => (p.free ? tr('chat.question.answer.freeText', { text: p.text }) : p.text)).join(', ');
}

/** The line of an answer with no questions (raw text or an elicitation form). */
function bareAnswer(response: ToolUserResponse, tr: Translate): string | null {
  if (response.kind === 'raw') return response.text.trim() ? tr('chat.question.answer.freeText', { text: response.text.trim() }) : null;
  if (response.kind === 'elicitation') return response.value === undefined ? null : JSON.stringify(response.value);
  return null;
}

function RecapLine({ question, answer, testId }: { question?: string; answer: string; testId: string }) {
  const tr = useT();
  // A question can span lines (context under its title): the closed row needs
  // only the first.
  const firstLine = question?.split('\n')[0];
  return (
    <div data-testid={testId} className="flex items-center gap-1.5 min-w-0 leading-snug">
      <CornerDownRight size={11} className="flex-shrink-0 text-app-text-muted" aria-hidden="true" />
      {firstLine && (
        <>
          {/* The question gives way first: cut with an ellipsis, whole in the title. */}
          <span className="min-w-0 truncate text-app-text-muted" title={question}>{firstLine}</span>
          <ArrowRight size={11} className="flex-shrink-0 text-app-text-muted" aria-hidden="true" />
        </>
      )}
      <span className="sr-only">{tr('chat.question.answer.srLabel')}</span>
      <span
        data-testid="question-answer-value"
        className={`min-w-0 truncate font-medium text-app-text ${firstLine ? 'flex-shrink-0 max-w-[65%]' : ''}`}
        title={answer}
      >
        {answer}
      </span>
    </div>
  );
}

/** Closed: one line per question, "question -> choice". */
export function QuestionAnswerRecap({ toolCallId, asked, response }: {
  toolCallId: string;
  asked: readonly AskedQuestion[];
  response: ToolUserResponse;
}) {
  const tr = useT();
  const bare = bareAnswer(response, tr);
  const lines = response.kind === 'questions'
    ? readAnsweredQuestions(asked, response.answers).filter((q) => q.parts.length > 0)
    : [];
  if (lines.length === 0 && !bare) return null;
  return (
    <div data-testid={`question-answer-${toolCallId}`} className="ml-5 mb-1 space-y-0.5 text-mini">
      {lines.map((q, i) => (
        <RecapLine key={`${toolCallId}-a-${i}`} testId="question-answer-line" question={q.question} answer={answerText(q.parts, tr)} />
      ))}
      {bare && <RecapLine testId="question-answer-line" answer={bare} />}
    </div>
  );
}

/** Open: each question with the options offered, the pick ticked. */
export function QuestionAnswerCard({ toolCallId, asked, response }: {
  toolCallId: string;
  asked: readonly AskedQuestion[];
  response: ToolUserResponse;
}) {
  const tr = useT();
  const bare = bareAnswer(response, tr);
  const questions = response.kind === 'questions' ? readAnsweredQuestions(asked, response.answers) : [];
  if (questions.length === 0 && !bare) return null;
  return (
    <div data-testid={`question-answer-card-${toolCallId}`} className="mt-1.5 space-y-2">
      {questions.map((q, i) => {
        const free = q.parts.filter((p) => p.free);
        return (
          <div key={`${toolCallId}-q-${i}`} className="space-y-1">
            {q.header && <div className="text-micro uppercase tracking-wide text-app-text-muted">{q.header}</div>}
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
      {bare && (
        <div className="flex items-start gap-1.5 text-mini font-medium text-app-text">
          <Check size={12} className="mt-[2px] flex-shrink-0 text-primary" aria-label={tr('chat.question.answer.chosen')} />
          <span className="min-w-0 break-words">{bare}</span>
        </div>
      )}
    </div>
  );
}
