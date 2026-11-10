/** Settings · The product (`g01`): what Topics promises, and the state of each function with the place where it lives. */
import { BookOpen, Eye, History, Lock, Monitor, RefreshCw, Search, ShieldCheck, Sparkles, User, Users, Zap, type LucideIcon } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import type { FunctionId, FunctionStatus, PrincipleId } from '../../../../ui/settings/model';
import { P } from '../../paths';
import { settingsFrame } from '../settings-frame';
import { Block } from '../../../../ui/settings/Block';
import { FunctionList, PrincipleCard } from '../../../../ui/settings/Product';
import { Tabs } from '../../../../ui/primitives/Tabs';
import { TextField } from '../../../../ui/primitives/Field';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { Button } from '../../../../ui/primitives/Button';
import { FUNCTIONS, PRINCIPLES } from '../../../../ui/fixtures/settings';

const PRINCIPLE_ICON: Record<PrincipleId, LucideIcon> = {
  anonymization: Lock, speed: Zap, security: ShieldCheck, determinism: RefreshCw, context: Eye,
  memory: BookOpen, person: User, anywhere: Monitor, tracked: History, team: Users,
};

/** Where each promise lives in the app. */
const PRINCIPLE_PATH: Record<PrincipleId, string> = {
  anonymization: P.settings('anonimizzazione'),
  speed: P.settings('sicurezza'),
  security: P.settings('sicurezza'),
  determinism: P.flowDecides('pec'),
  context: P.flowDecides('pec'),
  memory: P.knowledgeMap(),
  person: P.inbox(),
  anywhere: P.settings('dove-gira'),
  tracked: P.settings('registro'),
  team: P.settings('squadra'),
};

/** Where each function lives in the app. */
const FUNCTION_PATH: Record<FunctionId, string> = {
  flows: P.flows(),
  data: P.data(),
  knowledge: P.knowledge(),
  views: P.views(),
  channels: P.channels(),
  programs: P.programs(),
  anonymization: P.settings('anonimizzazione'),
  agents: P.pcAgent(),
  testing: P.testAll(),
  team: P.settings('squadra'),
  log: P.settings('registro'),
};

type Filter = 'all' | FunctionStatus;

export function ProductPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.settings;
  const p = c.product;
  const [filter, setFilter] = ctx.ui<Filter>('prodotto.filter', 'all');
  const [query, setQuery] = ctx.ui<string>('prodotto.q', '');

  const q = query.trim().toLowerCase();
  const visible = FUNCTIONS.filter((f) => {
    if (filter !== 'all' && f.status !== filter) return false;
    if (!q) return true;
    const t = p.functions[f.id];
    return [t.name, t.exists, t.toBuild, t.base].some((s) => s.toLowerCase().includes(q));
  });
  const count = (s: Filter) => (s === 'all' ? FUNCTIONS.length : FUNCTIONS.filter((f) => f.status === s).length);

  return settingsFrame(ctx, 'prodotto', {
    children: (
      <div className="flex flex-col gap-4">
        <p className="text-prose leading-5 text-app-text-secondary">{p.intro}</p>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {PRINCIPLES.map((r) => (
            <PrincipleCard
              key={r.id}
              p={{
                id: r.id,
                icon: PRINCIPLE_ICON[r.id],
                name: p.principles[r.id].name,
                text: p.principles[r.id].text,
                measure: p.principles[r.id].measure,
                value: r.value,
                kind: r.kind,
                kindLabel: c.common.kinds[r.kind],
                onOpen: () => ctx.go(PRINCIPLE_PATH[r.id]),
                openLabel: p.openIn(p.principles[r.id].name),
              }}
            />
          ))}
        </div>

        <Block title={p.functionsTitle} description={p.functionsSub} bodyClassName="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Tabs<Filter>
              ariaLabel={p.functionsTitle}
              value={filter}
              onChange={setFilter}
              className="min-w-0 flex-1"
              options={[
                { value: 'all', label: p.filters.all, count: count('all') },
                { value: 'active', label: p.filters.active, count: count('active') },
                { value: 'testing', label: p.filters.testing, count: count('testing') },
                { value: 'next', label: p.filters.next, count: count('next') },
              ]}
            />
            <TextField size="sm" type="search" icon={Search} value={query} onChange={setQuery} placeholder={p.search} className="w-full sm:w-56" />
          </div>
          <p className="text-mini text-app-text-tertiary">{p.count(visible.length, FUNCTIONS.length)}</p>
          {visible.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={p.empty.title}
              action={<Button onClick={() => { setFilter('all'); setQuery(''); }}>{c.common.clearFilters}</Button>}
            >
              {p.empty.body(query.trim())}
            </EmptyState>
          ) : (
            <FunctionList
              ariaLabel={p.functionsTitle}
              labels={{ area: p.columns.area, exists: p.columns.exists, toBuild: p.columns.toBuild, base: p.columns.base }}
              items={visible.map((f) => ({
                id: f.id,
                name: p.functions[f.id].name,
                status: f.status,
                statusLabel: p.status[f.status],
                exists: p.functions[f.id].exists,
                toBuild: p.functions[f.id].toBuild,
                base: p.functions[f.id].base,
                onOpen: () => ctx.go(FUNCTION_PATH[f.id]),
                openLabel: p.openIn(p.functions[f.id].name),
              }))}
            />
          )}
        </Block>
      </div>
    ),
  });
}
