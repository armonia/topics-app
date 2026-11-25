/**
 * The pages of the chat with the AI: every chat, a new chat, and one
 * conversation. A conversation is the same component as the chat inside a
 * card (`ui/chat/ChatPanel`); here it fills the page, with the field pinned
 * under it.
 */
import { Plus } from 'lucide-react';
import { ChatList } from '../../../../ui/chat/ChatList';
import { ChatPanel, ChatStart } from '../../../../ui/chat/ChatPanel';
import { Button } from '../../../../ui/primitives/Button';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import type { ScreenCtx } from '../../../app/kit';
import { orgCrumbs } from '../../crumbs';
import { startQuestions } from '../../model/assistant';
import { allChats, chatById, lastLine } from '../../model/chats';
import { flowIcon } from '../../model/flows';
import { momentLabel } from '../../model/who';
import { SP } from '../../paths';
import { world } from '../../world';
import { chatJob, draftKey, envOf, openFromChat, sendInChat, writing } from './conversation';

export function ChatListPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.chat;
  const chats = allChats(ctx.state, envOf(ctx));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader crumbs={orgCrumbs(ctx, [{ label: c.title, detail: c.list.count(chats.length) }])}>
        <Button variant="primary" size="sm" icon={Plus} onClick={() => ctx.go(SP.chatNew())}>{c.newChat}</Button>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ChatList
          chats={chats.map((x) => ({ id: x.id, title: x.title, last: lastLine(x), when: momentLabel(x.at, ctx.now, ctx.copy) }))}
          label={c.title}
          openLabel={c.list.open}
          onOpen={(id) => ctx.go(SP.chat(id))}
        />
      </div>
    </div>
  );
}

/** A conversation, or (no `id`, or one that is gone) the empty page of a new chat. */
export function ChatPage({ ctx, id }: { ctx: ScreenCtx; id?: string }) {
  const c = ctx.copy.chat;
  const env = envOf(ctx);
  const chat = id ? chatById(ctx.state, env, id) : undefined;
  const [draft, setDraft] = ctx.ui<string>(draftKey(chat ? chat.id : 'new'), '');
  const pending = chat ? writing(ctx, chatJob(chat.id)) : false;
  const send = (text: string) => sendInChat(ctx, chat?.id, text);
  const trail = chat
    ? [{ label: c.title, to: SP.chats() }, { label: chat.title }]
    : [{ label: c.title, to: SP.chats() }, { label: c.newChat }];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader crumbs={orgCrumbs(ctx, trail)}>
        {chat && <Button size="sm" icon={Plus} onClick={() => ctx.go(SP.chatNew())}>{c.newChat}</Button>}
      </PaneHeader>
      <ChatPanel
        copy={ctx.copy}
        layout="page"
        messages={chat?.messages ?? []}
        pending={pending}
        value={draft}
        onChange={setDraft}
        onSend={() => send(draft)}
        onOpen={(path) => openFromChat(ctx, path)}
        flowIcon={flowIcon}
        onPick={send}
        placeholder={c.composer.placeholder}
        empty={<ChatStart title={c.start.title(world().name)} body={c.start.body} suggestionsLabel={c.start.suggestions} questions={startQuestions(env)} onPick={send} />}
      />
    </div>
  );
}
