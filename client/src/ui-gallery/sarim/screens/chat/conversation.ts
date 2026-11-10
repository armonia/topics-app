/**
 * Sending a question: the person's words are kept at once, the answer comes
 * after a short «writing» (a simulated job of the container, so nothing is
 * left running when the page goes) and is kept in the same saved state, also
 * when the person has gone to another page meanwhile.
 */
import type { SarimCard } from '../../../../ui/fixtures/sarim-org/types';
import type { ScreenCtx } from '../../../app/kit';
import { EMPTY_FILTERS, type ListFilterState } from '../../../app/filters';
import { LIST_STUCK_PATH, answer, type AssistantEnv } from '../../model/assistant';
import { INBOX_FILTERS_KEY } from '../../model/dafare';
import { STUCK_FIELD, YES } from '../inbox/filters';
import {
  CHATS_INITIAL, CHATS_SLICE, allChats, chatById, chatTitle, chatsSlice, demoNow, withAnswer, withCardAnswer, withCardQuestion, withQuestion,
  type ChatsSlice,
} from '../../model/chats';
import { SP } from '../../paths';

/** How long the «writing» lasts before the answer shows. */
const WRITING_MS = 650;

/** Opens what a token of an answer points to; the link under a cut list of stopped cards opens «Da fare» with the filter «Ferme» on. (allow-italian: quotes the Italian interface) */
export function openFromChat(ctx: ScreenCtx, path: string): void {
  if (path === LIST_STUCK_PATH) {
    ctx.ui<ListFilterState>(INBOX_FILTERS_KEY, EMPTY_FILTERS)[1]({ ...EMPTY_FILTERS, tokens: [{ id: `${STUCK_FIELD}:${YES}`, field: STUCK_FIELD, op: 'is', value: YES }] });
    ctx.go(SP.inbox());
    return;
  }
  ctx.go(path);
}

/** The same question written two ways is the same question. */
const foldQuestion = (q: string): string => q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export const envOf = (ctx: ScreenCtx): AssistantEnv => ({ copy: ctx.copy.chat, state: ctx.state, persona: ctx.persona, now: ctx.now });

/** The title of a place of the chat, as the tab and the crumb say it. */
export function chatPlaceTitle(ctx: ScreenCtx, id?: string): string {
  const c = ctx.copy.chat;
  if (id === undefined) return c.title;
  return chatById(ctx.state, envOf(ctx), id)?.title ?? c.newChat;
}

/** Where a draft is kept while the person has not sent it. */
export const draftKey = (key: string): string => `sarim.chat.draft.${key}`;

export const chatJob = (chatId: string): string => `chat:${chatId}`;
export const cardJob = (cardId: string): string => `chat:card:${cardId}`;

/** Whether an answer is on its way for this job. */
export const writing = (ctx: ScreenCtx, job: string): boolean => ctx.job(job)?.status === 'running';

function runJob(ctx: ScreenCtx, job: string, onDone: () => void): void {
  ctx.startJob({ id: job, title: ctx.copy.chat.typing, steps: [{ label: ctx.copy.chat.typing, ms: WRITING_MS }], onDone: (ok) => ok && onDone() });
}

/**
 * Sends a question in a general chat. `chatId` is the chat it goes to; with
 * none (the page of a new chat, or a chat that is gone) a chat is made from
 * it and the person is taken there.
 */
export function sendInChat(ctx: ScreenCtx, chatId: string | undefined, raw: string): void {
  const question = raw.trim();
  if (!question) return;
  const env = envOf(ctx);
  if (chatId && writing(ctx, chatJob(chatId))) return;
  const existing = chatId ? chatById(ctx.state, env, chatId) : undefined;
  /* A question already asked in another chat reopens that chat: the same title never appears twice. */
  const asked = chatId ? undefined : allChats(ctx.state, env).find((c) => c.messages[0]?.role === 'user' && foldQuestion(c.messages[0].text ?? '') === foldQuestion(question));
  if (asked) {
    ctx.ui<string>(draftKey('new'), '')[1]('');
    ctx.go(SP.chat(asked.id));
    return;
  }
  const id = existing?.id ?? `c${chatsSlice(ctx.state).seq + 1}`;
  const at = demoNow();
  const base = existing ?? { id, title: chatTitle(question, env.copy.untitled, env.copy.titleStop), messages: [], at };
  const [, setSlice] = ctx.slice<ChatsSlice>(CHATS_SLICE, CHATS_INITIAL);
  setSlice((prev) => withQuestion(prev, base, question, at));
  const reply = answer(question, env);
  runJob(ctx, chatJob(id), () => setSlice((prev) => withAnswer(prev, id, reply, demoNow())));
  ctx.ui<string>(draftKey(chatId ?? 'new'), '')[1]('');
  if (!existing) ctx.go(SP.chat(id));
}

/** Sends a question in the chat of a card. */
export function sendInCard(ctx: ScreenCtx, card: SarimCard, raw: string): void {
  const question = raw.trim();
  if (!question || writing(ctx, cardJob(card.id))) return;
  const [, setSlice] = ctx.slice<ChatsSlice>(CHATS_SLICE, CHATS_INITIAL);
  setSlice((prev) => withCardQuestion(prev, card.id, question, demoNow()));
  const reply = answer(question, envOf(ctx), card);
  runJob(ctx, cardJob(card.id), () => setSlice((prev) => withCardAnswer(prev, card.id, reply, demoNow())));
  ctx.ui<string>(draftKey(`card.${card.id}`), '')[1]('');
}
