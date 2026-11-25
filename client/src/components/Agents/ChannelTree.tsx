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
import { Select } from '../Shared/Select';
import { ChatEditor, FIELD, Switch } from './AgentConfigPieces';
import { channelBrand } from './channelBrand';
import { ChannelMark } from './ChannelMark';
import type { Registry } from '../../state/agentRegistry';
import type { ChannelPlace } from '../../state/agentGroups';

type Agent = Registry['agents'][number];
type Chat = Agent['chats'][number];
type Post = (kind: string, body: object) => Promise<boolean>;

/** One column template for the header and every row, so each switch sits under its heading. */
const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_4.75rem_4.75rem_1.75rem] items-start gap-x-2';

const isWhatsAppGroup = (chat: string) => chat.endsWith('@g.us');

/** A Discord channel name often starts with a status emoji: it is a state, so it is split off the name. */
const LEADING_SIGN = /^(?:\p{Extended_Pictographic}|️|‍|\s)+/u;
function splitStatusSign(label: string): { name: string; status: string | null } {
  const m = LEADING_SIGN.exec(label);
  return m ? { name: label.slice(m[0].length) || label, status: m[0].trim() || null } : { name: label, status: null };
}

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

function matchesQuery(n: ChatNode, q: string): boolean {
  if (!q) return true;
  const hay = [n.label, n.chat.chat, ...n.threads.map((t) => t.label), ...n.chat.senders, ...n.chat.denied].join(' ').toLowerCase();
  return hay.includes(q);
}

const allNodes = (ch: ChannelNode): ChatNode[] => [...ch.groups.values()].flatMap((g) => [...g.categories.values()].flat());

/** The tree with only what matches the search; a level with nothing left disappears. */
function filterTree(tree: ChannelNode[], q: string): ChannelNode[] {
  if (!q) return tree;
  return tree.flatMap((ch) => {
    const groups = new Map<string, GroupNode>();
    for (const g of ch.groups.values()) {
      const categories = new Map<string, ChatNode[]>();
      for (const [key, nodes] of g.categories) {
        const kept = nodes.filter((n) => matchesQuery(n, q));
        if (kept.length) categories.set(key, kept);
      }
      if (categories.size) groups.set(g.key, { ...g, categories });
    }
    return groups.size ? [{ ...ch, groups }] : [];
  });
}
const countThreads = (nodes: ChatNode[]) => nodes.reduce((sum, n) => sum + n.threads.length, 0);

/** A switch with the «like the parent» / «its own» tag under it, in the column's own width. */
function InheritedSwitch({ on, label, testId, baseline, parentLabel, onChange }: {
  on: boolean; label: string; testId: string; baseline: boolean | null; parentLabel: string; onChange: (v: boolean) => void;
}) {
  const tr = useT();
  const inherited = baseline !== null && on === baseline;
  return (
    <span className="flex flex-col items-start gap-0.5">
      <Switch on={on} label={label} testId={testId} onChange={onChange} />
      <span data-testid="channel-tree-inherit-tag" className="max-w-full break-words text-mini leading-tight text-app-text-muted">
        {inherited ? tr('agentConfig.tree.inherits', { parent: parentLabel }) : tr('agentConfig.tree.own')}
      </span>
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
  const { name, status } = splitStatusSign(node.label);
  return (
    <li data-testid="channel-tree-chat">
      <div className={`${ROW_GRID} rounded px-1 py-1 ${selected ? 'bg-app-hover' : 'hover:bg-app-hover'}`}>
        <button type="button" data-testid="channel-tree-chat-open" onClick={onSelect} className="min-w-0 break-words text-left text-prose text-app-text">
          {status && <span data-testid="channel-tree-status" title={status} className="mr-1.5 inline-block h-2 w-2 rounded-full bg-primary align-middle" aria-hidden="true" />}
          {name}
        </button>
        <InheritedSwitch on={c.active} label={tr('agentConfig.active')} testId="agent-chat-active" baseline={baseline ? baseline.active : null} parentLabel={parentLabel} onChange={(v) => void post('chat', { channel, chat: c.chat, account: c.account, active: v })} />
        <InheritedSwitch on={c.mention} label={tr('agentConfig.mention')} testId="agent-chat-mention" baseline={baseline ? baseline.mention : null} parentLabel={parentLabel} onChange={(v) => void post('chat', { channel, chat: c.chat, account: c.account, mention: v })} />
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
                  <ChannelMark channel={channel} className="h-3 w-3 flex-shrink-0" /> {id} <span className="text-app-text-muted">· {tr('agentConfig.tree.canWrite')}</span>
                </li>
              ))}
              {c.denied.map((id) => (
                <li key={`d:${id}`} className="flex items-center gap-1.5 text-mini text-app-text-secondary">
                  <ChannelMark channel={channel} className="h-3 w-3 flex-shrink-0" /> {id} <span className="text-app-text-muted">· {tr('agentConfig.tree.excluded')}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {node.threads.length > 0 && (
        <ul className="ml-5 space-y-0.5">
          {node.threads.map((t) => <li key={t.id} data-testid="channel-tree-thread" className="truncate px-1 text-mini text-app-text-secondary">{t.label}</li>)}
        </ul>
      )}
      {editing && <div className="ml-4 mt-1"><ChatEditor c={c} post={post} close={() => setEditing(false)} /></div>}
    </li>
  );
}

export function ChannelTree({ agent, post, allAgents, titles, places }: {
  agent: Agent; post: Post; allAgents: { id: string; name: string }[];
  titles: Record<string, string>; places: Record<string, ChannelPlace>;
}) {
  const tr = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const fullTree = useMemo(() => buildTree(agent.chats, titles, places), [agent.chats, titles, places]);
  const tree = useMemo(() => filterTree(fullTree, q), [fullTree, q]);

  if (fullTree.length === 0) return <p className="text-mini text-app-text-muted">{tr('agentConfig.tree.empty')}</p>;

  return (
    <div>
    <input data-testid="channel-tree-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('agentConfig.tree.search')} aria-label={tr('agentConfig.tree.search')} className={`mb-2 ${FIELD}`} />
    <div data-testid="channel-tree-header" className={`${ROW_GRID} mb-1 px-1 text-mini font-semibold text-app-text-muted`}>
      <span />
      <span data-testid="channel-tree-header-active">{tr('agentConfig.active')}</span>
      <span data-testid="channel-tree-header-mention">{tr('agentConfig.tree.mentionShort')}</span>
      <span data-testid="channel-tree-header-rules" className="sr-only sm:not-sr-only">{tr('agentConfig.tree.rules')}</span>
    </div>
    {tree.length === 0 && <p data-testid="channel-tree-no-match" className="text-mini text-app-text-muted">{tr('agentConfig.tree.noMatch')}</p>}
    <ul data-testid="channel-tree" className="space-y-2">
      {tree.map((ch) => (
        <li key={ch.channel} data-testid="channel-tree-channel">
          <div className="flex items-center gap-1.5 text-body font-semibold text-app-text">
            <ChannelMark channel={ch.channel} />
            <span>{channelBrand(ch.channel)}</span>
            <span data-testid="channel-tree-count" className="text-mini font-normal text-app-text-muted">{tr('agentConfig.summary.chats', { n: allNodes(ch).length, t: countThreads(allNodes(ch)) })}</span>
          </div>
          <ul className="ml-3 mt-1 space-y-1">
            {[...ch.groups.values()].map((g) => (
              <li key={g.key} data-testid="channel-tree-server">
                <div className="flex items-center gap-1 text-mini font-semibold text-app-text-secondary">
                  <ChevronRight size={11} aria-hidden="true" />
                  {g.key === 'group' ? tr('agentConfig.tree.group') : g.key === 'private' ? tr('agentConfig.tree.private') : g.label}
                  <span data-testid="channel-tree-count" className="ml-1 font-normal text-app-text-muted">{tr('agents.chatsCount', { n: [...g.categories.values()].flat().length })}</span>
                </div>
                <ul className="ml-3 mt-0.5 space-y-0.5">
                  {[...g.categories.entries()].map(([catKey, nodes]) => (
                    <li key={catKey || '—'}> {/* allow-emdash: placeholder key for chats with no category */}
                      {catKey && <div data-testid="channel-tree-category" className="pl-2 text-mini text-app-text-muted">{catKey} <span data-testid="channel-tree-count">· {tr('agents.chatsCount', { n: nodes.length })}</span></div>}
                      <ul className={catKey ? 'ml-2' : ''}>
                        {nodes.map((n) => (
                          <ChatLeaf
                            key={n.chat.chat}
                            node={n}
                            channel={ch.channel}
                            parentLabel={channelBrand(ch.channel)}
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
    </div>
  );
}
