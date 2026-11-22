/**
 * CONFIGURE › CANALI E CHAT, AS A TREE (AGENTS-04).
 *
 * channel -> Discord server (or groups/privates for WhatsApp) -> category
 * (when present) -> chat -> thread. A chat that changes nothing from the
 * channel default (the `chat: "*"` row) says "like the channel"; changing a
 * value makes it its own, never a copy of the value repeated elsewhere.
 *
 * Server/category/thread names come from the channel engine
 * (`/api/agent-channels/places`, read from `channels.sqlite`); without that
 * data the level simply is not there, never an invented placeholder.
 */
import { useMemo, useState } from 'react';
import { ChevronRight, Pencil } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { CHANNEL_MARKS } from '../../lib/brandIcons';
import { Select } from '../Shared/Select';
import { ChatEditor, Switch } from './AgentConfigPieces';
import type { Registry } from '../../state/agentRegistry';
import type { ChannelPlace } from '../../state/agentGroups';

type Agent = Registry['agents'][number];
type Chat = Agent['chats'][number];
type Post = (kind: string, body: object) => Promise<boolean>;

const CHANNEL_BRAND: Record<string, string> = { discord: 'Discord', whatsapp: 'WhatsApp', telegram: 'Telegram' };
const isWhatsAppGroup = (chat: string) => chat.endsWith('@g.us');

interface ChatNode { chat: Chat; label: string; threads: { id: string; label: string }[] }
interface GroupNode { key: string; label: string; categories: Map<string, ChatNode[]> }
interface ChannelNode { channel: string; wildcard: Chat | null; groups: Map<string, GroupNode> }

function buildTree(chats: Chat[], titles: Record<string, string>, places: Record<string, ChannelPlace>): ChannelNode[] {
  const byChannel = new Map<string, ChannelNode>();
  for (const c of chats) {
    const node = byChannel.get(c.channel) ?? { channel: c.channel, wildcard: null, groups: new Map<string, GroupNode>() };
    byChannel.set(c.channel, node);
    if (c.chat === '*') { node.wildcard = c; continue; }
    const place = places[c.chat];
    const groupKey = c.channel === 'discord' ? place?.server ?? '—' : isWhatsAppGroup(c.chat) ? 'group' : 'private'; // allow-emdash: placeholder for an unresolved Discord server
    const groupLabel = c.channel === 'discord' ? (place?.server ?? '—') : isWhatsAppGroup(c.chat) ? 'group' : 'private'; // allow-emdash: placeholder for an unresolved Discord server
    const group = node.groups.get(groupKey) ?? { key: groupKey, label: groupLabel, categories: new Map<string, ChatNode[]>() };
    node.groups.set(groupKey, group);
    const categoryKey = c.category ?? '';
    const list = group.categories.get(categoryKey) ?? [];
    const threads = Object.keys(places)
      .filter((k) => k.startsWith(`${c.chat}:`))
      .map((k) => ({ id: k.slice(c.chat.length + 1), label: titles[k] ?? places[k]?.thread ?? k.slice(c.chat.length + 1) }));
    list.push({ chat: c, label: titles[c.chat] ?? c.chat, threads });
    group.categories.set(categoryKey, list);
  }
  return [...byChannel.values()];
}

function InheritedValue({ own, label, baseline, parentLabel }: { own: boolean; label: string; baseline: boolean | null; parentLabel: string }) {
  const tr = useT();
  const inherited = baseline !== null && own === baseline;
  return (
    <span className="flex items-center gap-1 text-mini text-app-text-muted">
      {label}
      <span data-testid="channel-tree-inherit-tag">{inherited ? tr('agentConfig.tree.inherits', { parent: parentLabel }) : tr('agentConfig.tree.own')}</span>
    </span>
  );
}

function ChatLeaf({
  node, channel, parentLabel, baseline, selected, onSelect, post, allAgents,
}: {
  node: ChatNode; channel: string; parentLabel: string; baseline: Chat | null; selected: boolean; onSelect: () => void; post: Post;
  allAgents: { id: string; name: string }[];
}) {
  const tr = useT();
  const [editing, setEditing] = useState(false);
  const c = node.chat;
  return (
    <li data-testid="channel-tree-chat">
      <div className={`flex items-center gap-2 rounded px-1 py-1 ${selected ? 'bg-app-hover' : 'hover:bg-app-hover'}`}>
        <button type="button" data-testid="channel-tree-chat-open" onClick={onSelect} className="min-w-0 flex-1 truncate text-left text-prose text-app-text">
          {node.label}
        </button>
        <InheritedValue own={c.active} label={tr('agentConfig.active')} baseline={baseline ? baseline.active : null} parentLabel={parentLabel} />
        <Switch on={c.active} label={tr('agentConfig.active')} testId="agent-chat-active" onChange={(v) => void post('chat', { channel, chat: c.chat, account: c.account, active: v })} />
        <InheritedValue own={c.mention} label={tr('agentConfig.mention')} baseline={baseline ? baseline.mention : null} parentLabel={parentLabel} />
        <Switch on={c.mention} label={tr('agentConfig.mention')} testId="agent-chat-mention" onChange={(v) => void post('chat', { channel, chat: c.chat, account: c.account, mention: v })} />
        <button type="button" data-testid="agent-chat-edit" aria-label={tr('agentConfig.edit')} title={tr('agentConfig.edit')} onClick={() => setEditing((e) => !e)} className="rounded p-1 text-app-text-muted hover:bg-app-hover hover:text-app-text">
          <Pencil size={12} aria-hidden="true" />
        </button>
      </div>
      {selected && (
        <div data-testid="channel-tree-detail" className="ml-4 mt-1 space-y-2 rounded border border-app-border-light p-2">
          <p className="text-mini text-app-text-secondary">
            {tr('agentConfig.tree.followedBy', { names: c.followedBy.map((id) => allAgents.find((a) => a.id === id)?.name ?? id).join(', ') })}
          </p>
          {allAgents.length > 1 && (
            <Select
              value=""
              ariaLabel={tr('agentConfig.tree.changeRoute')}
              onChange={(v) => { if (v) void post('route', { channel, chat: c.chat, agent: v }); }}
              options={[{ value: '', label: tr('agentConfig.tree.changeRoute') }, ...allAgents.map((a) => ({ value: a.id, label: a.name }))]}
            />
          )}
          <div data-testid="channel-tree-people">
            <p className="text-mini font-semibold text-app-text">{tr('agentConfig.tree.people')}</p>
            {c.senders.length === 0 && c.denied.length === 0 && <p className="text-mini text-app-text-muted">{tr('agentConfig.tree.noPeople')}</p>}
            <ul className="space-y-0.5">
              {c.senders.map((id) => (
                <li key={`w:${id}`} className="flex items-center gap-1.5 text-mini text-app-text-secondary">
                  <ChannelMark channel={channel} /> {id} <span className="text-app-text-muted">· {tr('agentConfig.tree.canWrite')}</span>
                </li>
              ))}
              {c.denied.map((id) => (
                <li key={`d:${id}`} className="flex items-center gap-1.5 text-mini text-app-text-secondary">
                  <ChannelMark channel={channel} /> {id} <span className="text-app-text-muted">· {tr('agentConfig.tree.excluded')}</span>
                </li>
              ))}
            </ul>
          </div>
          {node.threads.length > 0 && (
            <ul data-testid="channel-tree-thread" className="space-y-0.5 border-t border-app-border-light pt-1">
              {node.threads.map((t) => <li key={t.id} className="pl-3 text-mini text-app-text-secondary">{t.label}</li>)}
            </ul>
          )}
        </div>
      )}
      {editing && <div className="ml-4 mt-1"><ChatEditor c={c} post={post} close={() => setEditing(false)} /></div>}
    </li>
  );
}

function ChannelMark({ channel }: { channel: string }) {
  const Mark = CHANNEL_MARKS[CHANNEL_BRAND[channel] ?? ''];
  return Mark ? <Mark className="h-3 w-3 flex-shrink-0" aria-hidden /> : null;
}

export function ChannelTree({ agent, post, allAgents, titles, places }: {
  agent: Agent; post: Post; allAgents: { id: string; name: string }[];
  titles: Record<string, string>; places: Record<string, ChannelPlace>;
}) {
  const tr = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const tree = useMemo(() => buildTree(agent.chats, titles, places), [agent.chats, titles, places]);

  if (tree.length === 0) return <p className="text-mini text-app-text-muted">{tr('agentConfig.tree.empty')}</p>;

  return (
    <ul data-testid="channel-tree" className="space-y-2">
      {tree.map((ch) => (
        <li key={ch.channel} data-testid="channel-tree-channel">
          <div className="flex items-center gap-1.5 text-body font-semibold text-app-text">
            <ChannelMark channel={ch.channel} />
            <span>{CHANNEL_BRAND[ch.channel] ?? ch.channel}</span>
          </div>
          <ul className="ml-3 mt-1 space-y-1">
            {[...ch.groups.values()].map((g) => (
              <li key={g.key} data-testid="channel-tree-server">
                <div className="flex items-center gap-1 text-mini font-semibold text-app-text-secondary">
                  <ChevronRight size={11} aria-hidden="true" />
                  {g.key === 'group' ? tr('agentConfig.tree.group') : g.key === 'private' ? tr('agentConfig.tree.private') : g.label}
                </div>
                <ul className="ml-3 mt-0.5 space-y-0.5">
                  {[...g.categories.entries()].map(([catKey, nodes]) => (
                    <li key={catKey || '—'}> {/* allow-emdash: placeholder key for chats with no category */}
                      {catKey && <div data-testid="channel-tree-category" className="pl-2 text-mini text-app-text-muted">{catKey}</div>}
                      <ul className={catKey ? 'ml-2' : ''}>
                        {nodes.map((n) => (
                          <ChatLeaf
                            key={n.chat.chat}
                            node={n}
                            channel={ch.channel}
                            parentLabel={CHANNEL_BRAND[ch.channel] ?? ch.channel}
                            baseline={ch.wildcard}
                            selected={selected === `${ch.channel}:${n.chat.chat}`}
                            onSelect={() => setSelected((s) => (s === `${ch.channel}:${n.chat.chat}` ? null : `${ch.channel}:${n.chat.chat}`))}
                            post={post}
                            allAgents={allAgents}
                          />
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
