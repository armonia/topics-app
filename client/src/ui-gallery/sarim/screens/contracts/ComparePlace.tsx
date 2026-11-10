/**
 * Two versions of a contract compared (`/conoscenza/contratti/:id/confronto/:from/:to`): (allow-italian: address segments)
 * aligned by clause number, word by word, with the filter on the changed
 * clauses, a counter and arrows to go from one difference to the next, a
 * version picker on each side, and one line that sums it up: clauses changed,
 * words added and removed, and what the value does against the initial one
 * (with the 10% threshold for public contracts, art. 120 c. 3 D.Lgs. 36/2023).
 */
import { ArrowLeftRight, ChevronDown, ChevronUp, FileSignature, GitCompareArrows } from 'lucide-react';
import clsx from 'clsx';
import type { Contract } from '../../../../ui/fixtures/sarim-org/types';
import { Button, IconButton } from '../../../../ui/primitives/Button';
import { Checkbox, Select } from '../../../../ui/primitives/Field';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { ComparePane } from '../../../../ui/contracts/ComparePane';
import type { CompareRowModel } from '../../../../ui/contracts/model';
import { TONE_TEXT } from '../../../../ui/tone';
import { FOCUS_RING } from '../../../../ui/shell/pressable';
import type { ScreenCtx } from '../../../app/kit';
import { liveContractById } from '../../model/live';
import { actionLabel, compareVersions, currentVersion, formatMoney, formatShare, variantShare, versionOf, versionValue } from '../../model/contracts';
import { SP } from '../../paths';
import { ContractFrame, NotFound } from './frame';
import { actorOf, currentStep, isPublic } from './model';

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

function versionLabel(ctx: ScreenCtx, c: Contract, n: number): string {
  const t = ctx.copy.contracts.compare;
  const v = versionOf(c, n);
  const state = !v ? '' : v.n === currentVersion(c).n && v.signed ? t.versionState.inForce : v.signed ? t.versionState.signed : t.versionState.draft;
  return t.columnLabel(n, state);
}

export function ComparePlace({ ctx, id, from, to }: { ctx: ScreenCtx; id: string; from: number; to: number }) {
  const c = liveContractById(ctx.state, id);
  if (!c) return <NotFound ctx={ctx} />;
  const t = ctx.copy.contracts.compare;
  const [onlyChanged, setOnlyChanged] = ctx.ui<boolean>(`contracts.cmpOnly.${c.id}`, false);
  const [at, setAt] = ctx.ui<{ key: string; i: number; n: number }>(`contracts.cmpAt.${c.id}`, { key: '', i: -1, n: 0 });
  const [, setShown] = ctx.ui<number>(`contracts.show.${c.id}`, currentVersion(c).n);
  const valid = Boolean(versionOf(c, from) && versionOf(c, to));
  const options = [...c.versions].sort((a, b) => a.n - b.n).map((v) => ({ value: String(v.n), label: versionLabel(ctx, c, v.n) }));
  const pickers = (
    <div className="flex flex-wrap items-end gap-2">
      <Select size="sm" label={t.from} value={String(from)} options={options} onChange={(v) => ctx.go(SP.compare(c.id, Number(v), to))} />
      <IconButton icon={ArrowLeftRight} label={t.swap} onClick={() => ctx.go(SP.compare(c.id, to, from))} />
      <Select size="sm" label={t.to} value={String(to)} options={options} onChange={(v) => ctx.go(SP.compare(c.id, from, Number(v)))} />
    </div>
  );
  if (!valid || from === to) {
    return (
      <ContractFrame ctx={ctx} c={c} page="versions" crumb={t.crumb}>
        <div className="space-y-3 px-4 py-4">
          {pickers}
          <EmptyState icon={GitCompareArrows} title={t.sameVersion} className="min-h-0 rounded-lg border border-app-border bg-surface py-10" />
        </div>
      </ContractFrame>
    );
  }

  const comparison = compareVersions(c, from, to);
  const rows: CompareRowModel[] = comparison.map((r) => ({
    id: r.clauseId,
    n: r.n,
    title: r.title,
    status: r.status,
    left: r.status === 'added' ? [] : r.parts.filter((p) => p.kind !== 'added'),
    right: r.status === 'removed' ? [] : r.parts.filter((p) => p.kind !== 'removed'),
    inline: r.parts,
  }));
  const changed = rows.filter((r) => r.status !== 'same');
  const shown = onlyChanged ? changed : rows;
  const key = `${from}:${to}`;
  const index = at.key === key ? at.i : -1;
  const focus = index >= 0 ? changed[index] : undefined;
  const move = (step: 1 | -1) => {
    if (!changed.length) return;
    const next = index < 0 ? (step === 1 ? 0 : changed.length - 1) : (index + step + changed.length) % changed.length;
    setAt({ key, i: next, n: at.n + 1 });
  };
  const jump = (i: number) => setAt({ key, i, n: at.n + 1 });
  const words = comparison.reduce((acc, r) => {
    for (const p of r.parts) {
      if (p.kind === 'added') acc.added += countWords(p.text);
      if (p.kind === 'removed') acc.removed += countWords(p.text);
    }
    return acc;
  }, { added: 0, removed: 0 });
  const valueFrom = versionValue(c, from);
  const valueTo = versionValue(c, to);
  // Both shares are of the same initial value, so their difference is what this comparison changes, in either direction.
  const share = variantShare(c, to) - variantShare(c, from);
  // The threshold reads the newer version against the initial value: that is the modification art. 120 weighs.
  const over = Math.abs(variantShare(c, Math.max(from, to))) >= 10;
  const pending = currentStep(c.approvals);

  return (
    <ContractFrame ctx={ctx} c={c} page="versions" crumb={t.crumb}>
      <div className="space-y-3 px-4 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <h2 className="mr-auto text-body-lg font-semibold text-app-text">{t.title(from, to)}</h2>
          {pickers}
        </div>
        <div className={clsx('flex gap-x-3 gap-y-1.5 rounded-lg border border-app-border bg-surface px-3 py-2 text-prose', ctx.phone ? 'flex-col items-start' : 'flex-wrap items-center')}>
          <span data-compare-summary="true" className="text-app-text">{t.summary(changed.length, words.added, words.removed)}</span>
          {/* The dot only parts two things on one line; on a phone each part has its own line. */}
          {!ctx.phone && <span className="text-app-text-faint" aria-hidden="true">·</span>}
          {valueFrom !== valueTo ? (
            <span className="text-app-text">
              {t.value(ctx.copy.contracts.common.euro(formatMoney(valueFrom)), ctx.copy.contracts.common.euro(formatMoney(valueTo)), formatShare(share))}
              {isPublic(c) && <span className={clsx('ml-1.5', over ? TONE_TEXT.red : TONE_TEXT.green)}>{over ? t.threshold.over : t.threshold.under}</span>}
            </span>
          ) : (
            <span className="text-app-text-secondary">{t.valueSame}</span>
          )}
          {changed.length > 0 && (
            <span role="group" aria-label={t.jumpLabel} className="flex w-full basis-full flex-wrap items-center gap-1.5 border-t border-app-border pt-1.5">
              <span className="text-compact text-app-text-tertiary">{t.jumpLabel}</span>
              {changed.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={i === index}
                  data-tip={t.jumpTo(ctx.copy.contracts.common.clause(r.n), t.status[r.status])}
                  onClick={() => jump(i)}
                  className={clsx(
                    'inline-flex h-6 max-w-full items-center gap-1 rounded-full border px-2 text-compact font-medium transition-colors',
                    i === index ? 'border-primary/40 bg-primary/10 text-app-text' : 'border-app-border text-app-text-secondary hover:bg-app-hover hover:text-app-text',
                    FOCUS_RING,
                  )}
                >
                  <span aria-hidden="true" className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', r.status === 'added' ? 'bg-emerald-500' : r.status === 'removed' ? 'bg-rose-500' : 'bg-amber-500')} />
                  <span className="shrink-0">{ctx.copy.contracts.common.clause(r.n)}</span>
                  <span className="min-w-0 truncate font-normal text-app-text-tertiary">{r.title}</span>
                </button>
              ))}
            </span>
          )}
        </div>
        {pending && pending.action !== 'redige' && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/[0.06] px-3 py-2 text-compact text-sky-900 dark:text-sky-200">
            <FileSignature size={14} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{t.waiting(actorOf(pending.who).name, actionLabel[pending.action].toLowerCase())}</span>
            <Button size="sm" onClick={() => ctx.go(SP.signatures(c.id))}>{t.openSignatures}</Button>
          </div>
        )}
        <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-y border-app-border bg-app-bg/95 px-4 py-1.5 backdrop-blur">
          <Checkbox checked={onlyChanged} onChange={setOnlyChanged} label={t.onlyChanged} />
          <span className="flex-1" />
          <span className="inline-flex items-center gap-2 text-compact text-app-text-secondary">
            <del className="rounded-sm bg-rose-500/15 px-1 text-rose-800 dark:text-rose-300">{t.legend.removed}</del>
            <ins className="rounded-sm bg-emerald-500/20 px-1 text-emerald-900 no-underline dark:text-emerald-200">{t.legend.added}</ins>
          </span>
          <span className="min-w-[64px] text-right text-compact tabular-nums text-app-text-secondary" aria-live="polite">
            {changed.length ? t.counter(index + 1, changed.length) : t.none}
          </span>
          <IconButton icon={ChevronUp} label={t.previous} onClick={changed.length ? () => move(-1) : false} />
          <IconButton icon={ChevronDown} label={t.next} onClick={changed.length ? () => move(1) : false} />
        </div>
        <ComparePane
          rows={shown}
          fromLabel={versionLabel(ctx, c, from)}
          toLabel={versionLabel(ctx, c, to)}
          focusId={focus?.id}
          focusKey={focus ? `${key}:${at.n}` : undefined}
          onOpenClause={(cid) => { setShown(to); ctx.go(SP.clause(c.id, cid)); }}
          copy={ctx.copy}
          phone={ctx.phone}
        />
      </div>
    </ContractFrame>
  );
}
