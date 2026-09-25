/**
 * THE RETRY UNDER A SERVICE LINE RESENDS THE PERSON'S MESSAGE (third review of
 * 25/09, ported from the reviewer's probe).
 *
 * The no-reply banner looks past a background notice to decide that the chat
 * ends on an unanswered message, but its Retry resent the chat's literal last
 * row: live, the notice's own sentence (the frame's `content`), so the model
 * answered the notice and the person's message was lost; after a reload, "",
 * and the button did nothing. The handler is read from ChatInput.tsx itself,
 * not re-typed, and runs on the frame the server really broadcasts.
 *
 * Auto-TTS read the same literal last row, and said the notice aloud.
 *
 * @covers CHAT-REL-01
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { lastConversationMessage, lastPersonText, messageToSpeak } from './machineRow';
import { turnLooksUnanswered } from './turnError';
import { postBackgroundNotice } from '../../../../server/lib/background-notice';
import type { ContentBlock } from '../../types';

const src = readFileSync(join(import.meta.dir, 'ChatInput.tsx'), 'utf8');
const banner = src.indexOf('data-testid="no-reply-banner"');
const handlerSrc = /onClick=\{\(\) => \{([^}]*\}?[^}]*)\}\}/.exec(src.slice(banner))![1];
const memoSrc = /const lastUserText = useMemo\(\(\) => ([^,]+), \[currentMessages\]\)/.exec(src)![1];
const lastUserTextOf = new Function('lastPersonText', 'currentMessages', `return ${memoSrc};`) as (f: typeof lastPersonText, m: unknown[]) => string | null;
const retry = (messages: unknown[]) => {
  const sent: string[] = [];
  new Function('currentMessages', 'sendMessageDirect', 'lastUserText', handlerSrc)(messages, (t: string) => sent.push(t), lastUserTextOf(lastPersonText, messages));
  return sent;
};

/** The frame the server broadcasts for a stall recycle's notice. */
type Frame = { messageId: string; role: string; content: string; blocks: ContentBlock[] };
function noticeFrame(): Frame {
  const frames: Frame[] = [];
  postBackgroundNotice({ activeStreams: new Map(), broadcastToAll: (f: Frame) => frames.push(f),
    appendLocalMessage: () => ({ id: 'n1' }) } as never, { sessionKey: 'topic:x', topicId: 't' },
    { kind: 'background-notice', event: 'closed', tasks: ['slow counter', 'tick counter loop'], why: 'stuck-turn' });
  return frames[0];
}

const user = { id: 'u1', role: 'user', content: 'continua il task', timestamp: '2026-09-25T10:00:00Z' };
const shown = (messages: Array<{ role: string; blocks?: ContentBlock[] | null }>) => turnLooksUnanswered({
  lastMessageIsUser: lastConversationMessage(messages)?.role === 'user', locallyStreaming: false, serverSaysOpen: false, serverAsked: true,
});

describe('the no-reply Retry under a background notice', () => {
  test('live: the notice came as a frame whose content is its sentence', () => {
    const f = noticeFrame();
    const messages = [user, { id: f.messageId, role: f.role, content: f.content, timestamp: '2026-09-25T10:00:05Z', blocks: f.blocks }];
    expect(shown(messages)).toBe(true);
    expect(retry(messages)).toEqual(['continua il task']);
  });

  test('after a reload: the row from the database has content ""', () => {
    const f = noticeFrame();
    const messages = [user, { id: f.messageId, role: 'assistant', content: '', timestamp: '2026-09-25T10:00:05Z', blocks: f.blocks }];
    expect(shown(messages)).toBe(true);
    expect(retry(messages)).toEqual(['continua il task']);
  });

  test("main's shape, no notice: it resends the person's message", () => {
    expect(retry([user])).toEqual(['continua il task']);
  });
});

describe('auto-TTS', () => {
  test('never reads a service line aloud, and reads the answer before it only once it is the last word', () => {
    const f = noticeFrame();
    const notice = { id: f.messageId, role: 'assistant', content: f.content, blocks: f.blocks };
    const answer = { id: 'a1', role: 'assistant', content: 'Fatto.' };
    expect(messageToSpeak([user, notice])).toBeUndefined();
    expect(messageToSpeak([user, answer, notice])).toBe(answer);
    expect(messageToSpeak([user, answer])).toBe(answer);
  });
});
