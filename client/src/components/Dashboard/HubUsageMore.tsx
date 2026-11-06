/**
 * The drill-down of «Consumi» (hub-smistamento, HUBBR-12), what the hub's own
 * page had and the first move into Topics left out: the pickers that narrow
 * the window to one folder, one model or one account, the CSV of the rows
 * behind it, the input, output and requests of the window, the Claude tokens
 * per git folder and branch, Muse per folder, and how the proxy put its
 * requests in folders (from itself or from the session logs).
 */
import { useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Download, FolderGit2, Hash, LogIn, LogOut, ScanSearch } from 'lucide-react';
import { useLocale } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import { Select } from '../Shared/Select';
import { sharePct, type HubUsage, type HubUsageDays, type HubUsageFilter, type MuseFolder, type ProxyAttribution } from '../../lib/hubUsage';
import { usageFilterQuery } from '../../../../shared/hub-usage';
import { WARNING_TEXT } from '../../lib/popoverStyles';
import { BUTTON, Bar, Box, CARD, CHIP, FIGURE_COL, LINE, MoreRows, NAME_COL } from './hubUsageUi';
import { modelName, pctText, toneAt, tokensShort, whenText, type Tr } from './hubUsageFormat';

type Money = (usd: number) => string;

/** The empty folder on a picker: «all» is the empty value. */
const NO_FOLDER = '-';

/** The rows of a box before «altri N». */
const KEEP = 6;
/** The proxy's folders before «altre N», as the hub had them. */
const KEEP_PROXY = 10;

const numText = (n: number, locale: string) => n.toLocaleString(locale === 'it' ? 'it-IT' : 'en-US');

/** The pickers of the window and the CSV of its rows. */
export function UsageFilters({ usage, filter, days, onChange, tr }: { usage: HubUsage | null; filter: HubUsageFilter; days: HubUsageDays; onChange: (f: HubUsageFilter) => void; tr: Tr }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const opts = usage?.options ?? { models: [], accounts: [], repos: [] };
  // A value the window no longer has stays on the picker: the filter in force is said, never hidden.
  const withCurrent = (list: string[], cur: string | null) => (cur !== null && !list.includes(cur) ? [...list, cur] : list);
  const repoValue = filter.repo === null ? '' : filter.repo === '' ? NO_FOLDER : filter.repo;
  const exportCsv = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await apiFetch(`/api/hub-usage.csv?days=${days}${usageFilterQuery(filter)}`);
      const text = r.ok ? await r.text() : '';
      if (!r.ok) { setNote(tr('hubUsage.csv.failed')); return; }
      if (text.split('\n').length < 2) { setNote(tr('hubUsage.csv.empty')); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      a.download = `consumi-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      setNote(tr('hubUsage.csv.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="hub-usage-filters" className="flex flex-wrap items-center gap-1.5 @max-2xl:grid @max-2xl:grid-cols-2">
      <Select testId="hub-usage-filter-repo" ariaLabel={tr('hubUsage.filter.repo')} value={repoValue}
        options={[{ value: '', label: tr('hubUsage.filter.allRepos') }, ...withCurrent(opts.repos, filter.repo).map((k) => ({ value: k === '' ? NO_FOLDER : k, label: k === '' ? tr('hubUsage.noFolder') : k }))]}
        onChange={(v) => onChange({ ...filter, repo: v === '' ? null : v === NO_FOLDER ? '' : v })} />
      <Select testId="hub-usage-filter-model" ariaLabel={tr('hubUsage.filter.model')} value={filter.model ?? ''}
        options={[{ value: '', label: tr('hubUsage.filter.allModels') }, ...withCurrent(opts.models, filter.model).map((k) => ({ value: k, label: modelName(k, tr) }))]}
        onChange={(v) => onChange({ ...filter, model: v === '' ? null : v })} />
      <Select testId="hub-usage-filter-account" ariaLabel={tr('hubUsage.filter.account')} value={filter.account ?? ''}
        options={[{ value: '', label: tr('hubUsage.filter.allAccounts') }, ...withCurrent(opts.accounts, filter.account).map((k) => ({ value: k, label: k }))]}
        onChange={(v) => onChange({ ...filter, account: v === '' ? null : v })} />
      <span className="flex-1 @max-2xl:hidden" />
      {note && <span role="status" data-testid="hub-usage-csv-note" className="text-mini text-app-text-muted">{note}</span>}
      <button type="button" data-testid="hub-usage-csv" disabled={busy} className={BUTTON} onClick={() => void exportCsv()}>
        <Download size={12} aria-hidden="true" />{tr('hubUsage.csv')}
      </button>
    </div>
  );
}

/** Input, output and requests of the window: what the token total is made of. */
export function SplitStrip({ usage, tr }: { usage: HubUsage | null; tr: Tr }) {
  const locale = useLocale();
  const cells = [
    { key: 'input', icon: <LogIn size={12} />, label: tr('hubUsage.split.input'), value: usage ? tokensShort(usage.totals.inputTokens, locale) : null },
    { key: 'output', icon: <LogOut size={12} />, label: tr('hubUsage.split.output'), value: usage ? tokensShort(usage.totals.outputTokens, locale) : null },
    { key: 'requests', icon: <Hash size={12} />, label: tr('hubUsage.split.requests'), value: usage ? numText(usage.totals.requests, locale) : null },
  ];
  return (
    <div data-testid="hub-usage-split" className={`${CARD} grid grid-cols-3 tabular-nums`} title={tr('hubUsage.split.title')}>
      {cells.map((c) => (
        <div key={c.key} data-testid={`hub-usage-split-${c.key}`} className="flex items-baseline gap-1.5 border-l border-app-border-subtle px-3 py-1.5 first:border-l-0 @max-2xl:flex-col @max-2xl:gap-0">
          <span className="flex items-center gap-1 truncate text-mini text-app-text-muted"><span aria-hidden="true">{c.icon}</span>{c.label}</span>
          <b className="text-prose font-semibold text-app-text">{c.value ?? '-'}</b>
        </div>
      ))}
    </div>
  );
}

function RepoRow({ repo, usage, money, tr }: { repo: HubUsage['repos'][number]; usage: HubUsage; money: Money; tr: Tr }) {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronDown : ChevronRight;
  const name = repo.key === '' ? tr('hubUsage.noFolder') : repo.key;
  return (
    <>
      <button type="button" data-testid="hub-usage-repo-row" data-repo={repo.key} aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className={`${LINE} w-full text-left tabular-nums hover:bg-app-hover`} title={tr('hubUsage.repo.branches', { n: repo.branches.length })}>
        <span className={`${NAME_COL} flex items-center gap-1 text-app-text`}><Icon size={12} aria-hidden="true" className="flex-none text-app-text-muted" /><span className="truncate">{name}</span></span>
        <Bar pct={sharePct(repo, usage)} />
        <span className={FIGURE_COL}><b className="font-semibold text-app-text">{sharePct(repo, usage)}%</b> · {tokensShort(repo.tokens, locale)}</span>
        <span className="w-[56px] flex-none text-right text-mini text-app-text-muted">{money(repo.listUsd)}</span>
      </button>
      {open && repo.branches.map((b) => (
        <div key={b.key} data-testid="hub-usage-branch-row" data-branch={b.key} className={`${LINE} bg-app-hover/40 pl-7 tabular-nums`}>
          <span className={`${NAME_COL} w-[96px] text-app-text-secondary`}>{b.key === '' ? tr('hubUsage.noBranch') : b.key}</span>
          <Bar pct={sharePct(b, usage)} tone="bg-app-text-tertiary" />
          <span className={FIGURE_COL}>{sharePct(b, usage)}% · {tokensShort(b.tokens, locale)}</span>
          <span className="w-[56px] flex-none text-right text-mini text-app-text-muted">{money(b.listUsd)}</span>
        </div>
      ))}
    </>
  );
}

/** The Claude tokens of the window per git folder, its branches one click away. */
export function ByRepo({ usage, money, tr }: { usage: HubUsage | null; money: Money; tr: Tr }) {
  const locale = useLocale();
  const repos = usage?.repos ?? [];
  const tail = repos.slice(KEEP);
  return (
    <Box testId="hub-usage-repos" icon={<FolderGit2 size={13} />} title={tr('hubUsage.byRepo')} meta={tr('hubUsage.byRepoMeta')}>
      {usage && repos.length === 0 && <p className="px-3 py-2 text-mini text-app-text-muted">{tr('hubUsage.noData')}</p>}
      {usage && repos.slice(0, KEEP).map((r) => <RepoRow key={r.key} repo={r} usage={usage} money={money} tr={tr} />)}
      {usage && tail.length > 0 && (
        <MoreRows testId="hub-usage-repo-rest" label={tr('hubUsage.rest', { n: tail.length })} figure={tokensShort(tail.reduce((s, r) => s + r.tokens, 0), locale)}>
          {tail.map((r) => <RepoRow key={r.key} repo={r} usage={usage} money={money} tr={tr} />)}
        </MoreRows>
      )}
    </Box>
  );
}

function MuseRow({ f, tr }: { f: MuseFolder; tr: Tr }) {
  const locale = useLocale();
  return (
    <div data-testid="hub-usage-muse-row" data-folder={f.name} className="border-t border-app-border-subtle px-3 py-1.5 tabular-nums first:border-t-0">
      <div className="flex h-5 items-center gap-2">
        <span className={`${NAME_COL} text-app-text`}>{f.name}</span>
        <Bar pct={f.weekPct} tone={toneAt(1).bg} />
        <span className={FIGURE_COL}><b className="font-semibold text-app-text">{pctText(f.weekPct, locale)}</b></span>
      </div>
      <div className="text-mini text-app-text-muted">{tr('hubUsage.detail.line', { n: numText(f.requests, locale), tokens: tokensShort(f.tokens, locale), when: f.lastAt ? whenText(f.lastAt, locale) : '-' })}</div>
    </div>
  );
}

/** Muse this week per folder: its share of Muse's week, requests, tokens and last activity. */
export function MuseByFolder({ folders, tr }: { folders: MuseFolder[] | null; tr: Tr }) {
  const list = folders ?? [];
  return (
    <Box testId="hub-usage-muse-folders" icon={<Bot size={13} />} title={tr('hubUsage.museFolders')} meta={tr('hubUsage.museFoldersMeta')}>
      {folders === null && <p className="px-3 py-2 text-mini text-app-text-muted">{tr('hubUsage.museNone')}</p>}
      {folders !== null && list.length === 0 && <p className="px-3 py-2 text-mini text-app-text-muted">{tr('hubUsage.museIdle')}</p>}
      {list.slice(0, KEEP).map((f) => <MuseRow key={f.name} f={f} tr={tr} />)}
      {list.length > KEEP && (
        <MoreRows testId="hub-usage-muse-rest" label={tr('hubUsage.rest', { n: list.length - KEEP })}>
          {list.slice(KEEP).map((f) => <MuseRow key={f.name} f={f} tr={tr} />)}
        </MoreRows>
      )}
    </Box>
  );
}

function ProxyFolderRow({ f, tr }: { f: ProxyAttribution['folders'][number]; tr: Tr }) {
  const locale = useLocale();
  return (
    <div data-testid="hub-usage-proxy-row" data-source={f.fromLogs ? 'logs' : 'proxy'} className={`${LINE} tabular-nums`}>
      <span className={`${NAME_COL} flex-1 text-app-text`}>{f.name}</span>
      <span className="w-[64px] flex-none text-right text-mini text-app-text">{tr('hubUsage.proxy.requests', { n: numText(f.requests, locale) })}</span>
      <span className="w-[48px] flex-none text-right text-mini text-app-text-muted">{tokensShort(f.tokens, locale)}</span>
      <span className={`${CHIP} w-[104px] justify-center ${f.fromLogs ? `bg-amber-500/15 ${WARNING_TEXT}` : 'bg-app-hover text-app-text-secondary'}`}>
        {tr(f.fromLogs ? 'hubUsage.proxy.fromLogs' : 'hubUsage.proxy.fromProxy')}
      </span>
    </div>
  );
}

/** How the proxy put its requests in folders: its period, the sessions and requests left without one, and per folder the source. */
export function ProxyAttributionBox({ data, tr }: { data: ProxyAttribution | { note: string } | null; tr: Tr }) {
  const locale = useLocale();
  const ok = data !== null && !('note' in data) ? data : null;
  return (
    <Box testId="hub-usage-proxy" icon={<ScanSearch size={13} />} title={tr('hubUsage.proxy')} meta={tr('hubUsage.proxyMeta')}>
      {data === null && <p className="px-3 py-2 text-mini text-app-text-muted">{tr('hubUsage.proxy.none')}</p>}
      {data !== null && 'note' in data && <p className="px-3 py-2 text-mini text-app-text-muted">{data.note || tr('hubUsage.proxy.none')}</p>}
      {ok && (
        <>
          <p data-testid="hub-usage-proxy-summary" className="m-0 border-b border-app-border-subtle px-3 py-1.5 text-mini tabular-nums text-app-text-muted">
            {tr('hubUsage.proxy.summary', {
              n: numText(ok.requests, locale),
              from: ok.fromMs ? whenText(ok.fromMs, locale) : '-',
              to: ok.toMs ? whenText(ok.toMs, locale) : '-',
              blind: numText(ok.blindSessions, locale),
              without: numText(ok.withoutCwd, locale),
            })}
          </p>
          {ok.folders.slice(0, KEEP_PROXY).map((f) => <ProxyFolderRow key={f.name} f={f} tr={tr} />)}
          {ok.folders.length > KEEP_PROXY && (
            <MoreRows testId="hub-usage-proxy-rest" label={tr('hubUsage.restF', { n: ok.folders.length - KEEP_PROXY })}>
              {ok.folders.slice(KEEP_PROXY).map((f) => <ProxyFolderRow key={f.name} f={f} tr={tr} />)}
            </MoreRows>
          )}
        </>
      )}
    </Box>
  );
}
