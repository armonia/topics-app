/**
 * The chat with the AI inside a card: one conversation per card, kept with
 * the rest of the saved state. Above it the context, what the AI reads to
 * answer (the card, its originals, the flow and the step it is at); in the
 * empty chat, questions about THIS card to press in place of typing. Every
 * answer that names the card, an original or the flow carries a token that
 * opens it.
 */
import { FileText, ListChecks } from 'lucide-react';
import { ChatContext, ChatPanel, SuggestionChips } from '../../../../ui/chat/ChatPanel';
import type { OrbitCard } from '../../../../ui/fixtures/orbit-org/types';
import type { ScreenCtx } from '../../../app/kit';
import { cardQuestions } from '../../model/assistant';
import { chatsSlice } from '../../model/chats';
import { flowIcon, liveStep, opsFlowById } from '../../model/flows';
import { cardJob, draftKey, envOf, openFromChat, sendInCard, writing } from '../chat/conversation';

export function CardChat({ card, ctx }: { card: OrbitCard; ctx: ScreenCtx }) {
  const c = ctx.copy.chat;
  const env = envOf(ctx);
  const [draft, setDraft] = ctx.ui<string>(draftKey(`card.${card.id}`), '');
  const flow = opsFlowById(card.flow);
  const step = flow ? liveStep(card, flow) : undefined;
  const context = [
    { id: 'card', icon: flowIcon(card.flow), text: `${card.id} · ${card.title}` },
    ...(card.originals.length ? [{ id: 'original', icon: FileText, text: c.card.original(card.originals.length, card.originals[0].name) }] : []),
    ...(flow ? [{ id: 'flow', icon: flowIcon(flow.id), text: flow.name }] : []),
    ...(flow && step ? [{ id: 'step', icon: ListChecks, text: c.card.step(flow.steps.indexOf(step) + 1, flow.steps.length, step.title) }] : []),
  ];
  const send = (text: string) => sendInCard(ctx, card, text);
  return (
    <ChatPanel
      copy={ctx.copy}
      layout="inline"
      messages={chatsSlice(ctx.state).card[card.id] ?? []}
      pending={writing(ctx, cardJob(card.id))}
      value={draft}
      onChange={setDraft}
      onSend={() => send(draft)}
      onOpen={(path) => openFromChat(ctx, path)}
      flowIcon={flowIcon}
      onPick={send}
      placeholder={c.composer.cardPlaceholder}
      head={<ChatContext label={c.card.context} hint={c.card.contextHint} items={context} />}
      empty={<div className="px-5 pt-3"><SuggestionChips questions={cardQuestions(card, env)} onPick={send} /></div>}
    />
  );
}
