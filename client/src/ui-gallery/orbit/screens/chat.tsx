/**
 * ORBIT edition, area «Chat»: the chat with the AI as in Topics, the list of
 * every chat, a new chat that opens on four questions taken from the data of
 * the organization, and one conversation. The chat that belongs to a card is
 * drawn in the page of the card (`inbox/card-chat.tsx`) and keeps its
 * conversation in the same saved state (`model/chats.ts`). The answers are
 * built by `model/assistant.ts` from the live cards, contracts and flows.
 */
import type { AreaModule, ScreenDef } from '../../app/kit';
import { SP } from '../paths';
import { world } from '../world';
import { chatPlaceTitle } from './chat/conversation';
import { ChatListPage, ChatPage } from './chat/pages';

/* The three places share one tab: a new chat becomes the conversation it starts in the same tab. */
const base = { org: world().key, tabKey: () => 'orbit-chat' } as const;

const SCREENS: ScreenDef[] = [
  {
    ...base,
    id: 'orbit-chats',
    path: '/chat',
    nav: 'chat:all',
    samples: [SP.chats()],
    title: (_p, ctx) => chatPlaceTitle(ctx),
    render: (_p, ctx) => <ChatListPage ctx={ctx} />,
  },
  {
    ...base,
    id: 'orbit-chat-new',
    path: '/chat/nuova',
    nav: 'chat:new',
    samples: [SP.chatNew()],
    title: (_p, ctx) => ctx.copy.chat.newChat,
    render: (_p, ctx) => <ChatPage ctx={ctx} />,
  },
  {
    ...base,
    id: 'orbit-chat-one',
    path: '/chat/:chat',
    nav: 'chat:all',
    samples: ['demo-1', 'demo-2'].map((id) => SP.chat(id)),
    title: (p, ctx) => chatPlaceTitle(ctx, p.chat),
    render: (p, ctx) => <ChatPage ctx={ctx} id={p.chat} />,
  },
];

export const ORBIT_CHAT_AREA: AreaModule = { screens: SCREENS };
