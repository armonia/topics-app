/**
 * The breakdown boxes of «Consumi» (hub-smistamento, HUBBR-12): per model and
 * per account with tokens and list price, per project with the cap you set
 * and, opened, who made its week, and the saving against the list price with
 * the curve of the plans paying for themselves.
 */
import { useState, type ReactNode } from 'react';
import { Cpu, FolderOpen, PauseCircle, PiggyBank, UserRound } from 'lucide-react';
import { useLocale } from '../../hooks/useT';
import { meteredProviders, type QuotaWindow } from '../../lib/accountQuotas';
import {
  accountShares, headAndRest, projectShares, savingCurve, sharePct, tokenParts,
  type HubUsage, type PlanCost, type ProjectDetail, type ProjectShare,
} from '../../lib/hubUsage';
import { WARNING_TEXT } from '../../lib/popoverStyles';
import { Bar, Box, CHIP, FIGURE_COL, LINE, MoreRows, NAME_COL } from './hubUsageUi';
import { HOT_AT, modelName, pctText, toneAt, tokensShort, whenText, type Tr } from './hubUsageFormat';

type Money = (usd: number) => string;

const MONEY_COL = 'w-[56px] flex-none text-right text-mini text-app-text-muted';

export function ByModel({ usage, money, tr }: { usage: HubUsage | null; money: Money; tr: Tr }) {
  const locale = useLocale();
  // Every model, as the hub listed them: the ones past the fourth share the chart's last tone.
  const rows = usage ? usage.models : [];
  return (
    <Box testId="hub-usage-models" icon={<Cpu size={13} />} title={tr('hubUsage.byModel')} meta={tr('hubUsage.byModelMeta')}>
      {rows.map((m, i) => (
        <div key={m.key} data-testid="hub-usage-model-row" data-model={m.key} className={`${LINE} tabular-nums`}>
          <span className={`${NAME_COL} flex items-center gap-1.5 text-app-text`}>
            <i className={`h-2 w-2 flex-none rounded-[2px] ${toneAt(i).bg}`} />
            <span className="truncate">{modelName(m.key, tr)}</span>
          </span>
          <Bar pct={usage ? sharePct(m, usage) : 0} tone={toneAt(i).bg} />
          <span className={FIGURE_COL}><b className="font-semibold text-app-text">{usage ? sharePct(m, usage) : 0}%</b> · {tokensShort(m.tokens, locale)}</span>
          <span className={MONEY_COL} data-testid="hub-usage-model-money" title={tr('hubUsage.listTitle')}>{money(m.listUsd)}</span>
        </div>
      ))}
    </Box>
  );
}

function QuotaRow({ label, pct }: { label: string; pct: number | null }) {
  if (pct === null) return null;
  const hot = pct >= HOT_AT;
  return (
    <div className="flex h-5 items-center gap-2 tabular-nums">
      <span className="w-9 flex-none text-mini text-app-text-muted">{label}</span>
      <Bar pct={pct} hot={hot} />
      <span className={`w-9 flex-none text-right text-mini ${hot ? WARNING_TEXT : 'text-app-text-muted'}`}>{pct}%</span>
    </div>
  );
}

const windowPct = (w: QuotaWindow | null) => (w ? w.pct : null);

export function ByAccount({ profiles, usage, pace, gates, money, tr }: { profiles: unknown; usage: HubUsage | null; pace: unknown; gates: unknown; money: Money; tr: Tr }) {
  const locale = useLocale();
  // Switched-off and removed accounts stay: what they carried is part of the window's whole.
  const accounts = accountShares(profiles, usage).filter((a) => !a.disabled || a.tokens > 0);
  // One row per provider: the reader lists the active account first, the Accounts view shows the rest.
  const metered = meteredProviders(pace, gates).filter((m, i, all) => all.findIndex((o) => o.provider === m.provider) === i);
  return (
    <Box
      testId="hub-usage-accounts" icon={<UserRound size={13} />} title={tr('hubUsage.byAccount')} meta={tr('hubUsage.byAccountMeta')}
      foot={<>
        <span>{tr('hubUsage.rulesIn')}</span>
        <button type="button" data-testid="hub-usage-accounts-link" className={`${CHIP} bg-app-hover text-app-text-secondary hover:text-app-text`}
          onClick={() => window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'accounts' } }))}>
          {tr('hubUsage.accountsLink')}
        </button>
      </>}
    >
      {accounts.length === 0 && metered.length === 0 && <p className="px-3 py-2 text-mini text-app-text-muted">{tr('hubUsage.noAccounts')}</p>}
      {accounts.map((a) => (
        <div key={a.label} data-testid="hub-usage-account-row" data-account={a.label} data-state={a.removed ? 'removed' : a.disabled ? 'off' : 'on'} className="border-t border-app-border-subtle px-3 py-2 first:border-t-0">
          <div className="flex items-center gap-1.5">
            <span className={`min-w-0 flex-1 truncate text-compact ${a.removed || a.disabled ? 'text-app-text-muted' : 'text-app-text'}`}>{a.label}</span>
            {a.inUse && <span className={`${CHIP} bg-primary/10 text-blue-800 dark:text-primary`}>{tr('hubUsage.inUse')}</span>}
            {a.disabled && <span className={`${CHIP} bg-app-hover text-app-text-secondary`}>{tr('hubUsage.off')}</span>}
            {a.removed && <span className={`${CHIP} bg-app-hover text-app-text-secondary`} title={tr('hubUsage.removedTitle')}>{tr('hubUsage.removed')}</span>}
            {a.share !== null && <span className="text-mini tabular-nums text-app-text-muted" title={tr('hubUsage.shareTitle', { pct: `${a.share}%` })}>{a.share}%</span>}
          </div>
          {a.tokens > 0 && (
            <div className="flex h-5 items-center gap-1 text-mini tabular-nums text-app-text-muted" data-testid="hub-usage-account-carried">
              {tr('hubUsage.carried', { tokens: tokensShort(a.tokens, locale), money: money(a.listUsd), n: a.requests.toLocaleString(locale === 'it' ? 'it-IT' : 'en-US') })}
            </div>
          )}
          <QuotaRow label={tr('hubUsage.fiveH')} pct={windowPct(a.fiveH)} />
          <QuotaRow label={tr('hubUsage.week')} pct={windowPct(a.week)} />
        </div>
      ))}
      {metered.map((m) => (
        <div key={m.provider} data-testid="hub-usage-metered-row" className="border-t border-app-border-subtle px-3 py-2 first:border-t-0">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-compact text-app-text">{m.provider === 'codex' ? 'Codex' : 'Muse'}</span>
            <span className={`${CHIP} bg-app-hover text-app-text-secondary`}>{tr('hubUsage.readOnly')}</span>
          </div>
          <QuotaRow label={tr('hubUsage.fiveH')} pct={m.fiveH} />
          <QuotaRow label={tr('hubUsage.week')} pct={m.week} />
        </div>
      ))}
    </Box>
  );
}

/** «di cui sottoagenti 15,3% · 7.522 rich.»: one part of a project's Claude week, or a dash. */
function partText(p: { pct: number; requests: number } | null, locale: string, tr: Tr): string {
  return p ? tr('hubUsage.part', { pct: pctText(p.pct, locale), n: p.requests.toLocaleString(locale === 'it' ? 'it-IT' : 'en-US') }) : '-';
}

function ProjectRow({ row: r, detail, tr }: { row: ProjectShare; detail: ProjectDetail | undefined; tr: Tr }) {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const title = [
    r.what,
    tr('hubUsage.projectTitle', { claude: pctText(r.claude, locale), codex: pctText(r.codex, locale), muse: pctText(r.muse, locale) }),
    r.budgetPct !== null ? tr('hubUsage.projectCapTitle', { cap: pctText(r.budgetPct, locale) }) : '',
  ].filter(Boolean).join(' · ');
  const num = (n: number) => n.toLocaleString(locale === 'it' ? 'it-IT' : 'en-US');
  return (
    <>
      <button type="button" data-testid="hub-usage-project-row" data-project={r.name} data-over={r.over ? 'true' : undefined} aria-expanded={open}
        onClick={() => setOpen((v) => !v)} className={`${LINE} w-full text-left tabular-nums hover:bg-app-hover`} title={title}>
        <span className={`${NAME_COL} flex items-center gap-1 text-app-text`}>
          <span className="truncate">{r.title}</span>
          {r.over && <PauseCircle size={12} className={`flex-none ${WARNING_TEXT}`} aria-hidden="true" />}
        </span>
        <Bar pct={r.shown} hot={r.over} cap={r.budgetPct} />
        <span className={FIGURE_COL}>
          <b className={`font-semibold ${r.over ? WARNING_TEXT : 'text-app-text'}`}>{pctText(r.shown, locale)}</b>{r.budgetPct !== null ? ` / ${pctText(r.budgetPct, locale)}` : ''}
        </span>
      </button>
      {open && (
        <div data-testid="hub-usage-project-detail" className="flex flex-col gap-0.5 border-t border-app-border-subtle bg-app-hover/40 px-3 py-1.5 text-mini tabular-nums text-app-text-muted">
          {r.what && <span className="text-app-text-secondary">{r.what}</span>}
          {detail ? (
            <>
              <span>{tr('hubUsage.detail.line', { n: num(detail.requests), tokens: tokensShort(detail.tokens, locale), when: detail.lastAt ? whenText(detail.lastAt, locale) : '-' })}</span>
              <span>
                {tr('hubUsage.detail.sub')} {partText(detail.sub, locale, tr)} · {tr('hubUsage.detail.jarvis')} {partText(detail.jarvis, locale, tr)} · {tr('hubUsage.detail.jcode')} {partText(detail.jcode, locale, tr)}
              </span>
            </>
          ) : <span>{tr('hubUsage.detail.none')}</span>}
        </div>
      )}
    </>
  );
}

export function ByProject({ live, details, tr }: { live: unknown; details: Map<string, ProjectDetail>; tr: Tr }) {
  const locale = useLocale();
  const { head, rest } = headAndRest(projectShares(live));
  return (
    <Box
      testId="hub-usage-projects" icon={<FolderOpen size={13} />} title={tr('hubUsage.byProject')} meta={tr('hubUsage.byProjectMeta')}
      foot={[...head, ...(rest?.rows ?? [])].some((r) => r.budgetPct !== null) ? <><span className="inline-block h-3 w-0.5 rounded-[1px] bg-app-text-secondary" aria-hidden="true" /><span>{tr('hubUsage.capLegend')}</span></> : undefined}
    >
      {head.length === 0 && <p className="px-3 py-2 text-mini text-app-text-muted">{tr('hubUsage.noProjects')}</p>}
      {head.map((r) => <ProjectRow key={r.name} row={r} detail={details.get(r.name)} tr={tr} />)}
      {rest && (
        <MoreRows testId="hub-usage-project-rest" label={tr('hubUsage.rest', { n: rest.count })} figure={<b className="font-semibold text-app-text">{pctText(rest.total, locale)}</b>}>
          {rest.rows.map((r) => <ProjectRow key={r.name} row={r} detail={details.get(r.name)} tr={tr} />)}
        </MoreRows>
      )}
    </Box>
  );
}

/** The list price summed day by day against what the plans cost so far: where the plans paid for themselves. */
function SavingCurve({ usage, planUsd, money, tr }: { usage: HubUsage; planUsd: number; money: Money; tr: Tr }) {
  const pts = savingCurve(usage, planUsd);
  if (pts.length === 0) return null;
  const W = 600;
  const H = 96;
  const top = Math.max(1e-9, ...pts.map((p) => Math.max(p.list, p.plan)));
  const x = (i: number) => (pts.length <= 1 ? W / 2 : (i / (pts.length - 1)) * W);
  const y = (v: number) => H - 3 - (v / top) * (H - 8);
  const line = (k: 'list' | 'plan') => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  return (
    <div data-testid="hub-usage-saving-curve" className="border-t border-app-border-subtle px-3 pb-2 pt-2">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[96px] w-full" role="img" aria-label={tr('hubUsage.curve.aria')}>
        <path d={line('list')} fill="none" className={toneAt(0).stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <path d={line('plan')} fill="none" className="stroke-app-text-muted" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-mini tabular-nums text-app-text-muted">
        <span className="inline-flex items-center gap-1"><i className={`inline-block h-0.5 w-3 ${toneAt(0).bg}`} />{tr('hubUsage.curve.list', { money: money(last.list) })}</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-0 w-3 border-t border-dashed border-app-text-muted" />{tr('hubUsage.curve.plan', { money: money(last.plan) })}</span>
        <span>{tr('hubUsage.curve.saved')} <b className="font-semibold text-emerald-600 dark:text-emerald-400">{money(Math.max(0, last.list - last.plan))}</b></span>
      </div>
    </div>
  );
}

export function Saving({ usage, planCost, saved, museTokens, money, tr }: {
  usage: HubUsage | null; planCost: PlanCost | null; saved: number | null; museTokens: number | null; money: Money; tr: Tr;
}) {
  const locale = useLocale();
  const m = museTokens === null ? null : tokenParts(museTokens, locale);
  let curve: ReactNode = null;
  if (usage && planCost) curve = <SavingCurve usage={usage} planUsd={planCost.usd} money={money} tr={tr} />;
  return (
    <Box testId="hub-usage-saving" icon={<PiggyBank size={13} />} title={tr('hubUsage.saving')} meta={tr('hubUsage.savingMeta')}>
      <div className="grid grid-cols-2 gap-4 px-3 py-2.5 tabular-nums @max-2xl:grid-cols-1">
        <div>
          <div className="text-mini text-app-text-muted">{tr('hubUsage.savingClaude')}</div>
          <div className="text-title font-semibold text-app-text">{saved === null ? '-' : money(saved)} <span className="text-mini font-normal text-app-text-muted">{tr('hubUsage.saved')}</span></div>
          {usage && planCost && <div className="text-mini text-app-text-muted">{tr('hubUsage.savingLine', { list: money(usage.totals.listUsd), paid: money(planCost.usd) })}</div>}
          {planCost && planCost.unpriced > 0 && <div className="text-mini text-app-text-muted">{tr('hubUsage.unpriced', { n: planCost.unpriced })}</div>}
        </div>
        <div>
          <div className="text-mini text-app-text-muted">{tr('hubUsage.savingMuse')}</div>
          {m ? (
            <>
              <div className="text-title font-semibold text-app-text">{m.value}{m.unit} <span className="text-mini font-normal text-app-text-muted">{tr('hubUsage.museTokens')}</span></div>
              <div className="text-mini text-app-text-muted">{tr('hubUsage.museLine')}</div>
            </>
          ) : <div className="text-mini text-app-text-muted">{tr('hubUsage.museNone')}</div>}
        </div>
      </div>
      {curve}
    </Box>
  );
}
