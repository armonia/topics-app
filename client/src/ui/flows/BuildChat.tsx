import { useState, type ReactNode } from 'react';
import { Mic, SendHorizontal } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { revealOnMount } from '../primitives/overlay';
import { FOCUS_RING } from '../shell/pressable';
import type { FlowStepModel } from './model';
import { FlowCanvas } from './FlowCanvas';
import { canvasStepOf } from './canvasOf';

/** One thing in a conversation: a message, a question with answers, a quiet note. */
export type ChatItemModel =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; /** `Assistente:` before the text, as an interview prints it. */ speaker?: string }
  | { kind: 'questions'; id: string; questions: Array<{ id: string; title: string; options: Array<{ id: string; label: string; recommended?: boolean }>; answer?: string }> }
  | { kind: 'note'; id: string; text: string }
  /** Anything drawn in the place of words: a reply with tokens, a line that says the assistant is writing. */
  | { kind: 'rich'; id: string; node: ReactNode };

/**
 * A conversation: the person's words in a grey bubble on the right, the
 * assistant's as plain text, the questions it needs answered as cards whose
 * options are pressed in place of typing. `scrollToEnd` keeps the last item
 * in view once the reader has added to it.
 */
export function ChatThread({ items, onAnswer, scrollToEnd, recommendedLabel, className }: {
  items: ChatItemModel[];
  /** Said in words next to the suggested option, so it does not rest on colour alone. */
  recommendedLabel?: string;
  onAnswer?: (questionId: string, optionId: string) => void;
  scrollToEnd?: boolean;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col gap-4 px-5 py-5 text-prose leading-6', className)}>
      {items.map((it) => {
        if (it.kind === 'message') {
          return it.role === 'user' ? (
            <div key={it.id} className="ml-auto max-w-[92%] rounded-2xl bg-black/[0.06] px-4 py-2.5 text-app-text dark:bg-white/[0.1]">{it.text}</div>
          ) : (
            <p key={it.id} className="max-w-[92%] text-app-text">
              {it.speaker && <strong className="font-semibold">{it.speaker} </strong>}
              {it.text}
            </p>
          );
        }
        if (it.kind === 'note') return <p key={it.id} className="max-w-[92%] text-app-text-tertiary">{it.text}</p>;
        if (it.kind === 'rich') return <div key={it.id}>{it.node}</div>;
        return (
          <div key={it.id} className="flex flex-col gap-3">
            {it.questions.map((q) => (
              <div key={q.id} className="rounded-lg border border-app-border bg-surface px-4 py-3">
                <h4 className="text-prose font-semibold text-app-text">{q.title}</h4>
                <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={q.title}>
                  {q.options.map((o) => {
                    const on = q.answer === o.id;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onAnswer?.(q.id, o.id)}
                        className={clsx(
                          'inline-flex min-h-7 items-center rounded-lg px-2.5 py-1 text-left text-compact font-medium transition-colors', FOCUS_RING,
                          on
                            ? 'bg-primary text-white'
                            : o.recommended
                              ? 'bg-sky-500/15 text-sky-800 hover:bg-sky-500/25 dark:text-sky-300'
                              : 'bg-black/[0.05] text-app-text hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]',
                        )}
                      >
                        {o.label}{o.recommended && recommendedLabel ? ` (${recommendedLabel})` : ''}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        );
      })}
      {scrollToEnd && <div key={items.length} ref={revealOnMount} aria-hidden="true" />}
    </div>
  );
}

/**
 * The line where the reader answers: a field and a send button. Sending an
 * empty line does not do nothing: the field says it needs a few words.
 * `lead` sits before the field (a microphone), `trailing` after the send
 * button (pause).
 */
export function ChatComposer({ copy, value, onChange, onSend, placeholder, lead, trailing, fieldAttrs }: {
  copy: UiCopy;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
  lead?: ReactNode;
  trailing?: ReactNode;
  /** Attributes a test or a walk finds the field by (`data-*`). */
  fieldAttrs?: Record<`data-${string}`, string>;
}) {
  const [empty, setEmpty] = useState(false);
  const send = () => {
    if (!value.trim()) {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    onSend();
  };
  const c = copy.flowBuild.chat;
  return (
    <form
      className="shrink-0 px-4 pb-4 pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className={clsx('flex items-center gap-2 rounded-xl bg-black/[0.04] px-3 py-2 dark:bg-white/[0.06]', empty && 'ring-1 ring-rose-500/60')}>
        {lead}
        <input
          {...fieldAttrs}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            if (empty) setEmpty(false);
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-invalid={empty || undefined}
          className="h-7 min-w-0 flex-1 bg-transparent text-prose text-app-text outline-none placeholder:text-app-placeholder"
        />
        <button
          type="submit"
          aria-label={c.send}
          data-tip={c.send}
          className={clsx('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-app-text-secondary transition-colors hover:bg-black/[0.06] hover:text-app-text dark:hover:bg-white/[0.1]', FOCUS_RING)}
        >
          <SendHorizontal size={16} aria-hidden="true" />
        </button>
        {trailing}
      </div>
      {empty && <p role="alert" className="mt-1 px-1 text-mini text-rose-600 dark:text-rose-400">{c.emptyMessage}</p>}
    </form>
  );
}

/** The microphone glyph that opens the interview's composer. */
export function MicMark({ live, label }: { live: boolean; label: string }) {
  return (
    <span data-tip={label} className={clsx('inline-flex h-7 w-7 shrink-0 items-center justify-center', live ? 'text-rose-600 dark:text-rose-400' : 'text-app-text-tertiary')}>
      <Mic size={15} aria-hidden="true" />
    </span>
  );
}

/**
 * The flow the conversation is building, drawn by the same canvas as the flow
 * page (read mode, no state): the trigger, then each step as the same card.
 */
export function DraftStepList({ trigger, steps, copy }: { trigger: FlowStepModel; steps: FlowStepModel[]; copy: UiCopy }) {
  return (
    <div role="group" aria-label={copy.flowBuild.chat.draftLabel}>
      <FlowCanvas
        mode="read"
        copy={copy}
        model={{
          trigger: { title: trigger.title, note: trigger.note, produces: trigger.produces },
          nodes: steps.map((s) => ({ kind: 'step', step: canvasStepOf(s, copy) })),
        }}
      />
    </div>
  );
}

/**
 * A conversation on the left and what it produces on the right (n03, o02).
 * Wide: two columns that scroll on their own, the field pinned under the
 * conversation. On a phone one page: conversation, field, then the result.
 */
export function ChatSplit({ thread, composer, side, phone }: { thread: ReactNode; composer: ReactNode; side: ReactNode; phone?: boolean }) {
  if (phone) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {thread}
        {composer}
        <div className="border-t border-app-border bg-app-inset p-4">{side}</div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">{thread}</div>
        {composer}
      </section>
      <section className="min-w-0 flex-1 overflow-y-auto border-l border-app-border bg-app-inset p-4">{side}</section>
    </div>
  );
}
