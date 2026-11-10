/**
 * The chats with the AI as the reader left them, kept in the saved state of
 * the preview (they start again with «Ripristina demo»): the general chats, allow-italian: quotes the words on screen
 * each with its title and its messages, and one conversation per card. Two
 * example chats are always there until the reader writes in them; writing in
 * one keeps it from then on, like any other.
 */
import type { ChatMessageModel, ChatReply } from '../../../ui/chat/model';
import { replyText } from '../../../ui/chat/model';
import { DEMO_NOW, DEMO_TODAY, addDays } from '../../../ui/fixtures/org/clock';
import type { DemoState } from '../../app/store/state';
import type { ChatCopy } from '../../../ui/copy/chat';
import { answer, exampleFlowName, exampleQuestions, type AssistantEnv } from './assistant';
import { hoursBetween } from './stages';

export const CHATS_SLICE = 'orbit.chats';

export interface ChatRecord {
  id: string;
  /** The first words of the first question. */
  title: string;
  messages: ChatMessageModel[];
  /** When it last moved (ISO date-time). */
  at: string;
}

export interface ChatsSlice {
  /** The chats the reader wrote in, with the examples they continued. */
  chats: ChatRecord[];
  /** The conversation of each card, by card id. */
  card: Record<string, ChatMessageModel[]>;
  /** Counts what was made, so an id is never used twice. */
  seq: number;
}

export const CHATS_INITIAL: ChatsSlice = { chats: [], card: {}, seq: 0 };

export function chatsSlice(state: DemoState): ChatsSlice {
  return { ...CHATS_INITIAL, ...((state.slices[CHATS_SLICE] as Partial<ChatsSlice> | undefined) ?? {}) };
}

/* ---------- time ---------- */

/** Real time the page opened: chats written now are dated from the demo's now by the time passed since. */
const OPENED_AT = Date.now();

/** The demo's now plus the real time since the page opened, as an ISO date-time at +01:00. */
export function demoNow(): string {
  const d = new Date(Date.parse(DEMO_NOW) + (Date.now() - OPENED_AT) + 60 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${DEMO_TODAY}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+01:00`;
}

/** How long ago a chat moved, in words: `adesso`, `5 min fa`, `17 h fa`, `ieri`, then the weekday. allow-italian: quotes the words on screen */
export function chatAge(at: string, copy: ChatCopy): string {
  const hours = hoursBetween(at, demoNow());
  if (hours < 1 / 60) return copy.justNow;
  if (hours < 1) return copy.age.minutes(Math.round(hours * 60));
  if (hours < 24) return copy.age.hours(Math.round(hours));
  const days = Math.round((Date.parse(`${demoNow().slice(0, 10)}T00:00:00Z`) - Date.parse(`${at.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  return days <= 1 ? copy.age.yesterday : copy.age.weekdays[new Date(`${at.slice(0, 10)}T12:00:00Z`).getUTCDay()];
}

/* ---------- titles ---------- */

/** The most words a title keeps: it names the chat, it does not repeat the question. */
const TITLE_WORDS = 5;

/** The first words of a question, without its question mark, never ending on an article or a preposition. */
export function chatTitle(question: string, fallback: string, stop: readonly string[] = []): string {
  const words = question.trim().replace(/\s+/g, ' ').replace(/[?!.]+$/, '').split(' ').filter(Boolean);
  if (!words.length) return fallback;
  const kept = words.slice(0, TITLE_WORDS);
  while (kept.length > 1 && stop.includes(kept[kept.length - 1].toLowerCase())) kept.pop();
  const line = kept.join(' ').replace(/[,;:]+$/, '');
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

/* ---------- the examples ---------- */

const EXAMPLE_AT = [`${addDays(DEMO_TODAY, -1)}T17:20:00+01:00`, `${addDays(DEMO_TODAY, -2)}T09:05:00+01:00`];

/** The two chats a new demo starts with; with `full` they carry their messages (the answers are built when asked for). */
export function exampleChats(env: AssistantEnv, full: boolean): ChatRecord[] {
  const flowName = exampleFlowName(env);
  return exampleQuestions(env).map((question, i): ChatRecord => {
    const id = `demo-${i + 1}`;
    const at = EXAMPLE_AT[i];
    const messages: ChatMessageModel[] = full
      ? [
          { id: `${id}.1`, role: 'user', text: question, at },
          { id: `${id}.2`, role: 'assistant', reply: answer(question, env), at },
        ]
      : [];
    const title = i === 0 ? env.copy.exampleTitle.due : flowName ? env.copy.exampleTitle.flow(flowName) : chatTitle(question, env.copy.untitled, env.copy.titleStop);
    return { id, title, messages, at };
  });
}

/** Every chat, newest first: the ones the reader wrote in, then the examples they did not continue. */
export function allChats(state: DemoState, env: AssistantEnv, full = true): ChatRecord[] {
  const own = chatsSlice(state).chats;
  const examples = exampleChats(env, full).filter((e) => !own.some((c) => c.id === e.id));
  return [...own, ...examples].sort((a, b) => b.at.localeCompare(a.at));
}

export function chatById(state: DemoState, env: AssistantEnv, id: string): ChatRecord | undefined {
  const own = chatsSlice(state).chats.find((c) => c.id === id);
  return own ?? exampleChats(env, true).find((c) => c.id === id);
}

/** The last line of a chat, for the list. */
export function lastLine(chat: ChatRecord): string {
  const last = chat.messages[chat.messages.length - 1];
  if (!last) return '';
  return last.role === 'user' ? last.text ?? '' : last.reply ? replyText(last.reply) : '';
}

/* ---------- writing ---------- */

/** The slice with a chat added or replaced, and its message counter moved on. */
function upsert(slice: ChatsSlice, chat: ChatRecord): ChatsSlice {
  return { ...slice, seq: slice.seq + 1, chats: [chat, ...slice.chats.filter((c) => c.id !== chat.id)] };
}

/** The slice after the reader writes in a chat (`base`: the chat as it stands, which may be an example not kept yet). */
export function withQuestion(slice: ChatsSlice, base: ChatRecord, question: string, at: string): ChatsSlice {
  const message: ChatMessageModel = { id: `${base.id}.${base.messages.length + 1}`, role: 'user', text: question, at };
  return upsert(slice, { ...base, messages: [...base.messages, message], at });
}

/** The slice after the answer comes in; a chat that is gone (the demo was reset) takes nothing. */
export function withAnswer(slice: ChatsSlice, chatId: string, reply: ChatReply, at: string): ChatsSlice {
  const chat = slice.chats.find((c) => c.id === chatId);
  if (!chat) return slice;
  const message: ChatMessageModel = { id: `${chat.id}.${chat.messages.length + 1}`, role: 'assistant', reply, at };
  return upsert(slice, { ...chat, messages: [...chat.messages, message], at });
}

/** The slice after the reader writes in the chat of a card. */
export function withCardQuestion(slice: ChatsSlice, cardId: string, question: string, at: string): ChatsSlice {
  const messages = slice.card[cardId] ?? [];
  const message: ChatMessageModel = { id: `${cardId}.${messages.length + 1}`, role: 'user', text: question, at };
  return { ...slice, seq: slice.seq + 1, card: { ...slice.card, [cardId]: [...messages, message] } };
}

/** The slice after the answer to a card's chat comes in; with no question before it (the demo was reset) it takes nothing. */
export function withCardAnswer(slice: ChatsSlice, cardId: string, reply: ChatReply, at: string): ChatsSlice {
  const messages = slice.card[cardId];
  if (!messages?.length) return slice;
  const message: ChatMessageModel = { id: `${cardId}.${messages.length + 1}`, role: 'assistant', reply, at };
  return { ...slice, seq: slice.seq + 1, card: { ...slice.card, [cardId]: [...messages, message] } };
}
