import { createElement, useState, type ReactNode } from 'react';
import { ArrowRight, ClipboardList, FileSignature, FileText, MessageSquare, Workflow, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { ChatComposer, ChatThread, type ChatItemModel } from '../flows/BuildChat';
import { FOCUS_RING } from '../shell/pressable';
import { isChatRef, type ChatMessageModel, type ChatRef, type ChatRefKind, type ChatReply, type ChatSeg } from './model';

const REF_ICON: Record<ChatRefKind, LucideIcon> = {
  card: ClipboardList,
  contract: FileSignature,
  flow: Workflow,
  document: FileText,
  list: ArrowRight,
};

/** Draws the icon a flow has everywhere (card and flow tokens carry its id). */
export type FlowIconOf = (flowId: string) => LucideIcon;

/** A thing the reply names, as a small link: its icon, its label and what follows it. */
export function ChatRefChip({ r, onOpen, flowIcon }: { r: ChatRef; onOpen: (path: string) => void; flowIcon?: FlowIconOf }) {
  const icon = r.flow && flowIcon && (r.kind === 'card' || r.kind === 'flow') ? flowIcon(r.flow) : REF_ICON[r.kind];
  return (
    <button
      type="button"
      data-chat-ref={r.kind}
      data-chat-ref-id={r.id}
      data-tip={r.detail ? `${r.label} · ${r.detail}` : r.label}
      onClick={() => onOpen(r.path)}
      className={clsx(
        'mx-0.5 inline-flex min-h-6 max-w-full items-start gap-1.5 rounded-md border bg-surface px-2 py-[3px] text-left align-middle text-mini leading-4 transition-colors',
        r.tone === 'red' ? 'border-rose-500/40' : r.tone === 'amber' ? 'border-amber-500/40' : 'border-app-border',
        'hover:border-primary/50 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]',
        FOCUS_RING,
      )}
    >
      {createElement(icon, { size: 12, className: 'mt-0.5 shrink-0 text-app-text-tertiary', 'aria-hidden': true })}
      <span className="min-w-0 [overflow-wrap:break-word]">
        <span className="font-semibold text-app-text">{r.label}</span>
        {r.detail && <span className="text-app-text-secondary">{' '}{r.detail}</span>}
      </span>
    </button>
  );
}

function Segs({ segs, onOpen, flowIcon }: { segs: ChatSeg[]; onOpen: (path: string) => void; flowIcon?: FlowIconOf }) {
  return (
    <>
      {segs.map((s, i) => {
        if (typeof s === 'string') return <span key={i}>{s}</span>;
        if (isChatRef(s)) return <ChatRefChip key={`${s.kind}:${s.id}:${i}`} r={s} onOpen={onOpen} flowIcon={flowIcon} />;
        return <strong key={i} className="font-semibold">{s.strong}</strong>;
      })}
    </>
  );
}

/** Questions to press in place of typing. */
export function SuggestionChips({ questions, onPick, label }: { questions: string[]; onPick: (q: string) => void; label?: string }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {questions.map((q) => (
        <button
          key={q}
          type="button"
          data-chat-suggestion=""
          onClick={() => onPick(q)}
          className={clsx(
            'inline-flex min-h-7 items-center rounded-lg bg-black/[0.05] px-2.5 py-1 text-left text-compact font-medium text-app-text transition-colors hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]',
            FOCUS_RING,
          )}
        >
          {q}
        </button>
      ))}
    </div>
  );
}

/** One answer: its paragraphs, lists and quotes, and the questions it suggests next. */
export function ReplyView({ reply, onOpen, onPick, showExamples, flowIcon }: {
  reply: ChatReply;
  onOpen: (path: string) => void;
  onPick: (q: string) => void;
  showExamples: boolean;
  flowIcon?: FlowIconOf;
}) {
  return (
    <div data-chat-reply="" className="flex max-w-[92%] flex-col gap-2.5 text-app-text">
      {reply.blocks.map((b, i) => {
        if (b.kind === 'text') return <p key={i} className="leading-7"><Segs segs={b.segs} onOpen={onOpen} flowIcon={flowIcon} /></p>;
        if (b.kind === 'list') {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5 marker:text-app-text-faint">
              {b.items.map((it, j) => <li key={j} className="leading-7"><Segs segs={it} onOpen={onOpen} flowIcon={flowIcon} /></li>)}
            </ul>
          );
        }
        return (
          <figure key={i} className="border-l-2 border-app-border pl-3">
            <blockquote className="text-app-text-secondary">«{b.text}»</blockquote>
            <figcaption className="mt-0.5 text-mini text-app-text-tertiary"><Segs segs={b.from} onOpen={onOpen} flowIcon={flowIcon} /></figcaption>
          </figure>
        );
      })}
      {showExamples && reply.examples && reply.examples.length > 0 && <SuggestionChips questions={reply.examples} onPick={onPick} />}
    </div>
  );
}

/** The line that says an answer is on its way. It moves by CSS alone, so nothing is left running when the page goes. */
function WritingLine({ label }: { label: string }) {
  return (
    <p role="status" data-chat-typing="" className="flex items-center gap-1.5 text-app-text-tertiary">
      <span className="inline-flex gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((i) => <span key={i} style={{ animationDelay: `${i * 160}ms` }} className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" />)}
      </span>
      {label}
    </p>
  );
}

/**
 * A conversation with its field: the person's words in a bubble, the answers
 * as text with tokens that open the things they name, the field pinned under
 * them. `page` fills its pane and scrolls the thread; `inline` sits in the flow
 * of a page (the chat of a card) and grows with the thread.
 */
export function ChatPanel({ copy, messages, pending, value, onChange, onSend, onOpen, onPick, placeholder, layout, head, empty, flowIcon }: {
  copy: UiCopy;
  messages: ChatMessageModel[];
  /** An answer is on its way. */
  pending: boolean;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onOpen: (path: string) => void;
  onPick: (question: string) => void;
  placeholder: string;
  layout: 'page' | 'inline';
  /** Above the thread (the context of a card). */
  head?: ReactNode;
  /** In place of the thread while there is nothing in it (what to ask first). */
  empty?: ReactNode;
  /** The icon of a flow, for the tokens of cards and flows. */
  flowIcon?: FlowIconOf;
}) {
  const page = layout === 'page';
  /* What was there when the thread opened is not scrolled to: only what the person adds after. */
  const [opened] = useState(messages.length);
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')?.id;
  const items: ChatItemModel[] = messages.flatMap((m): ChatItemModel[] => {
    if (m.role === 'user') return [{ kind: 'message', id: m.id, role: 'user', text: m.text ?? '' }];
    if (!m.reply) return [];
    return [{ kind: 'rich', id: m.id, node: <ReplyView reply={m.reply} onOpen={onOpen} onPick={onPick} showExamples={!pending && m.id === lastAssistant} flowIcon={flowIcon} /> }];
  });
  if (pending) items.push({ kind: 'rich', id: 'typing', node: <WritingLine label={copy.chat.typing} /> });

  const thread = (
    <div data-chat-thread="" className={clsx(page && 'mx-auto w-full max-w-[760px]')}>
      {head}
      {messages.length === 0 && empty}
      <ChatThread items={items} scrollToEnd={page || messages.length > opened} />
    </div>
  );
  const composer = (
    <ChatComposer
      copy={copy}
      value={value}
      onChange={onChange}
      onSend={onSend}
      placeholder={placeholder}
      fieldAttrs={{ 'data-chat-composer': '' }}
    />
  );
  if (!page) {
    return (
      <div className="flex flex-col">
        {thread}
        {composer}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">{thread}</div>
      <div className="mx-auto w-full max-w-[760px]">{composer}</div>
    </div>
  );
}

/** What a new chat opens with: a line on what it knows and four questions to start from. */
export function ChatStart({ title, body, suggestionsLabel, questions, onPick }: {
  title: string;
  body: string;
  suggestionsLabel: string;
  questions: string[];
  onPick: (q: string) => void;
}) {
  return (
    <div data-chat-start="" className="flex flex-col items-center gap-2 px-5 pb-4 pt-12 text-center">
      <span className="mb-1 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-black/[0.05] text-app-text-tertiary dark:bg-white/[0.08]">
        <MessageSquare size={18} aria-hidden="true" />
      </span>
      <h2 className="text-body-lg font-semibold text-app-text">{title}</h2>
      <p className="max-w-[440px] text-prose leading-6 text-app-text-secondary">{body}</p>
      <div className="mt-4 w-full text-left">
        <p className="mb-2 text-mini font-semibold text-app-text-tertiary">{suggestionsLabel}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {questions.map((q) => (
            <button
              key={q}
              type="button"
              data-chat-suggestion=""
              onClick={() => onPick(q)}
              className={clsx('rounded-lg border border-app-border bg-surface px-3.5 py-3 text-left text-prose text-app-text transition-colors hover:bg-app-hover', FOCUS_RING)}
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** What the AI reads in a card, in a row above its chat. */
export function ChatContext({ label, hint, items }: {
  label: string;
  hint: string;
  items: Array<{ id: string; icon: LucideIcon; text: string }>;
}) {
  return (
    <div data-chat-context="" className="flex flex-wrap items-center gap-1.5 px-5 pt-4">
      <span data-tip={hint} className="text-mini font-semibold text-app-text-secondary">{label}</span>
      {items.map((it) => (
        <span key={it.id} className="inline-flex h-5 max-w-full items-center gap-1 rounded bg-black/[0.05] px-1.5 text-mini leading-4 text-app-text-secondary dark:bg-white/10">
          <it.icon size={12} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{it.text}</span>
        </span>
      ))}
    </div>
  );
}
