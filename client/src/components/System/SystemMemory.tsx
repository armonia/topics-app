/**
 * MEMORIE: three sentences on what a memory is (index, cards, where it holds),
 * a search over every store with the results grouped by store, the list of
 * stores with whom they reach (amber when nobody receives one), and the card
 * itself: type, date, links, text, edit and archive. All of it is Topics' own
 * routes (`/api/memory-stores`); no outside service.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Archive, Search, TriangleAlert } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { readJson } from '../../lib/readJson';
import { apiFetch } from '../../lib/shell/net';
import { WARNING_TEXT } from '../../lib/popoverStyles';
import { useAgentRegistry } from '../../state/agentRegistry';
import { refreshSystemHealth } from '../../state/systemHealth';
import { BTN, FIELD, SAVE } from '../Agents/AgentConfigPieces';
import { parseCard, storeLabel } from './memoryCard';
import { openAgentPlace } from './systemNav';

interface Store {
  id: string;
  kind: 'agent' | 'project';
  ownerAgentId: string | null;
  index: { lines: number; overLimit: boolean } | null;
  cards: { file: string; name: string; description: string; type: string }[];
  receivedBy: string[];
  readableBy: string[];
}
interface Problem { storeId: string; kind: string; text: string }
interface Result { storeId: string; file: string; name: string; description: string; type: string; snippet: string }
interface Open { storeId: string; file: string; content: string }

const cardUrl = (storeId: string, file: string) => `/api/memory-stores/${encodeURIComponent(storeId)}/cards/${encodeURIComponent(file)}`;

export function SystemMemory() {
  const tr = useT();
  const { reg } = useAgentRegistry();
  const [stores, setStores] = useState<Store[] | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[] | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);

  const load = useCallback(async () => {
    const body = await readJson('/api/memory-stores', { cache: 'no-store' }) as { stores?: Store[]; problems?: Problem[] } | null;
    if (body?.stores) { setStores(body.stores); setProblems(body.problems ?? []); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the read starts on mount; the state is set when the fetch resolves
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let alive = true;
    void readJson('/api/projects').then((b) => { const list = (b as { projects?: { name: string; path: string }[] } | null)?.projects; if (alive && list) setProjects(list); });
    return () => { alive = false; };
  }, []);

  const label = (storeId: string) => storeLabel(storeId, reg?.agents ?? [], projects);
  const nameOf = (id: string) => reg?.agents.find((a) => a.id === id)?.name || id;
  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) { setResults(null); return; }
    const body = await readJson(`/api/memory-stores/search?q=${encodeURIComponent(query.trim())}`) as { results?: Result[] } | null;
    setResults(body?.results ?? []);
  };
  const read = async (storeId: string, file: string) => {
    const body = await readJson(cardUrl(storeId, file), { cache: 'no-store' }) as { content?: string } | null;
    const content = body?.content ?? '';
    setOpen({ storeId, file, content });
    setDraft(content);
    setNote(null);
  };
  const save = async () => {
    if (!open) return;
    const r = await apiFetch(cardUrl(open.storeId, open.file), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: draft }) });
    setNote(r.ok ? tr('system.memory.saved') : tr('system.memory.failed'));
    if (r.ok) setOpen({ ...open, content: draft });
  };
  const archive = async () => {
    if (!open) return;
    const r = await apiFetch(`${cardUrl(open.storeId, open.file)}/archive`, { method: 'POST' });
    if (!r.ok) { setNote(tr('system.memory.failed')); return; }
    setOpen(null);
    setResults(null);
    await load();
    refreshSystemHealth();
  };

  const parsed = open ? parseCard(open.content) : null;
  const store = open ? stores?.find((s) => s.id === open.storeId) : null;
  const byStore = new Map<string, Result[]>();
  for (const r of results ?? []) byStore.set(r.storeId, [...(byStore.get(r.storeId) ?? []), r]);

  return (
    <section data-testid="system-memory" className="max-w-3xl space-y-4">
      <h2 className="text-body font-semibold text-app-text">{tr('system.memory.title')}</h2>
      <p data-testid="memory-explainer" className="text-prose text-app-text-secondary">
        {tr('system.memory.index')} {tr('system.memory.cards')} {tr('system.memory.scope')}
      </p>

      <form onSubmit={(e) => { void search(e); }} className="flex gap-2">
        <input data-testid="memory-search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('system.memory.searchPlaceholder')} className={FIELD} />
        <button type="submit" data-testid="memory-search-go" className={SAVE}><Search size={12} aria-hidden="true" className="mr-1 inline" />{tr('system.memory.search')}</button>
      </form>

      {results && (
        <div data-testid="memory-results" className="space-y-3">
          {results.length === 0 && <p className="text-prose text-app-text-muted">{tr('system.memory.noResults')}</p>}
          {[...byStore.entries()].map(([storeId, list]) => (
            <div key={storeId} data-testid="memory-result-store" data-store={storeId}>
              <h3 className="mb-1 text-mini font-semibold uppercase tracking-wide text-app-text-muted">{label(storeId)}</h3>
              <ul className="space-y-1">
                {list.map((r) => (
                  <li key={r.file}>
                    <button type="button" data-testid="memory-result" onClick={() => { void read(r.storeId, r.file); }} className="w-full rounded border border-app-border p-2 text-left hover:bg-app-hover">
                      <span className="block text-prose text-app-text">{r.name || r.file}</span>
                      <span className="block truncate text-mini text-app-text-muted">{r.snippet}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {open && parsed && (
        <div data-testid="memory-card" className="space-y-2 rounded border border-app-border p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-mini text-app-text-muted">
            <span className="font-medium text-app-text">{open.file}</span>
            <span data-testid="memory-card-store">{label(open.storeId)}</span>
            <span data-testid="memory-card-type">{tr('system.memory.type')}: {parsed.type || tr('system.memory.none')}</span>
            <span data-testid="memory-card-date">{tr('system.memory.date')}: {parsed.date ?? tr('system.memory.none')}</span>
          </div>
          <div data-testid="memory-card-links" className="flex flex-wrap items-center gap-1.5 text-mini">
            <span className="text-app-text-muted">{tr('system.memory.links')}:</span>
            {parsed.links.length === 0 && <span className="text-app-text-muted">{tr('system.memory.none')}</span>}
            {parsed.links.map((l) => {
              const target = store?.cards.find((c) => c.file === `${l}.md` || c.name === l);
              return target
                ? <button key={l} type="button" data-testid="memory-card-link" onClick={() => { void read(open.storeId, target.file); }} className="rounded-full border border-app-border px-2 py-0.5 text-app-text hover:bg-app-hover">{l}</button>
                : <span key={l} className="rounded-full border border-dashed border-app-border px-2 py-0.5 text-app-text-muted">{l}</span>;
            })}
          </div>
          <textarea data-testid="memory-card-text" value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} className={`${FIELD} font-mono`} />
          <div className="flex items-center gap-2">
            <button type="button" data-testid="memory-card-save" disabled={draft === open.content} onClick={() => { void save(); }} className={SAVE}>{tr('system.memory.save')}</button>
            <button type="button" data-testid="memory-card-archive" onClick={() => { void archive(); }} className={BTN}><Archive size={12} aria-hidden="true" className="mr-1 inline" />{tr('system.memory.archive')}</button>
            <button type="button" onClick={() => setOpen(null)} className={BTN}>{tr('system.memory.close')}</button>
            {note && <span className="text-mini text-app-text-muted">{note}</span>}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-1 text-prose font-semibold text-app-text">{tr('system.memory.stores')}</h3>
        {stores === null ? <p className="text-prose text-app-text-muted">{tr('system.reading')}</p> : stores.length === 0 ? (
          <p className="text-prose text-app-text-muted">{tr('system.memory.noStores')}</p>
        ) : (
          <ul className="space-y-2">
            {stores.map((s) => {
              const own = problems.filter((p) => p.storeId === s.id);
              const unreceived = own.some((p) => p.kind === 'unreceived');
              return (
                <li key={s.id} data-testid="memory-store" data-store={s.id} className="rounded border border-app-border p-2.5">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="text-prose font-medium text-app-text">{label(s.id)}</span>
                    <span className="text-mini text-app-text-muted">{tr(s.cards.length === 1 ? 'system.memory.cardOne' : 'system.memory.cardCount', { n: s.cards.length })}</span>
                    <span className="text-mini text-app-text-muted">{s.index ? tr('system.memory.indexLines', { n: s.index.lines }) : tr('system.memory.noIndex')}</span>
                  </div>
                  <p className="text-mini text-app-text-secondary">
                    {s.receivedBy.length > 0 ? tr('system.memory.receivedBy', { who: s.receivedBy.map(nameOf).join(', ') }) : tr('system.memory.receivedByNone')}
                    {s.readableBy.length > 0 && ` · ${tr('system.memory.readableBy', { who: s.readableBy.map(nameOf).join(', ') })}`}
                  </p>
                  {unreceived && (
                    <p data-testid="memory-store-unreceived" className={`mt-1 flex items-center gap-1.5 text-mini ${WARNING_TEXT}`}>
                      <TriangleAlert size={12} aria-hidden="true" />{tr('system.memory.unreceived')}
                      {s.ownerAgentId && <button type="button" data-testid="memory-store-fix" onClick={() => openAgentPlace(s.ownerAgentId!, 'memory')} className={BTN}>{tr('system.memory.openMemory')}</button>}
                    </p>
                  )}
                  {own.filter((p) => p.kind !== 'unreceived').map((p) => <p key={p.kind} className={`mt-1 text-mini ${WARNING_TEXT}`}>{p.text}</p>)}
                  <ul className="mt-1.5 flex flex-wrap gap-1">
                    {s.cards.slice(0, 12).map((c) => (
                      <li key={c.file}><button type="button" data-testid="memory-store-card" onClick={() => { void read(s.id, c.file); }} className="rounded border border-app-border px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-app-hover">{c.name || c.file}</button></li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
