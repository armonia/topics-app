import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { Select } from '../Shared/Select';
import { WorktreesPreview } from './WorktreesPreview';
import { WorktreesMachines } from './WorktreesMachines';
import { ApiError, appSettingsApi, type AppBehaviorSettings } from '../../lib/api';
import {
  DEFAULT_CARGO_TARGET_MODE,
  DEFAULT_GC_FOREIGN_MODE,
  DEFAULT_WORKTREE_ABANDON_DAYS,
  DEFAULT_WORKTREE_DISK_FLOOR_GB,
  DEFAULT_WORKTREE_MAX_PER_PROJECT,
  DEFAULT_WORKTREE_QUARANTINE_DAYS,
} from '../../../../shared/worktree-settings';

/** Closed sets for the three dials: short lists read better than a free number. */
const MAX_CHOICES = [5, 10, 20, 40, 80];
const FLOOR_CHOICES = [5, 12, 20, 50, 100];
const ABANDON_CHOICES = [3, 7, 14, 30, 60];
const QUARANTINE_CHOICES = [1, 3, 7, 14, 30];

/** The reason the server gave for refusing the root, when it named one. */
function rootRefusalCode(err: unknown): string | null {
  if (!(err instanceof ApiError) || !Array.isArray(err.errors)) return null;
  const hit = (err.errors as Array<{ field?: unknown; code?: unknown }>).find((e) => e.field === 'worktreeRoot' && typeof e.code === 'string');
  return hit ? String(hit.code) : null;
}

/**
 * WORKTREES: where agents' checkouts live and how many to keep (change
 * worktree-standard, T1). Machine preferences, every one with a default that
 * works untouched, so this form changes nothing until somebody opens it.
 *
 * The root is the only free field. It is validated by the server (absolute,
 * not a temp, system or home folder, not a folder holding projects or other
 * files); a refusal is shown as the form's one error line, with the server's
 * reason, instead of being silently corrected, because a folder typed wrong and
 * "fixed" quietly would send every new checkout somewhere the person never chose.
 */
export function WorktreesSection() {
  const t = useT();
  const [settings, setSettings] = useState<AppBehaviorSettings | null>(null);
  const [root, setRoot] = useState('');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void appSettingsApi.get().then((s) => {
      if (!alive.current) return;
      setSettings(s);
      setRoot(s.worktreeRoot ?? '');
    }).catch(() => {});
    return () => { alive.current = false; };
  }, []);

  const patch = useCallback(async (body: Partial<AppBehaviorSettings>, failure?: string) => {
    setError(null);
    try {
      const next = await appSettingsApi.update(body);
      if (alive.current) { setSettings(next); setRoot(next.worktreeRoot ?? ''); }
      return true;
    } catch (err) {
      const code = 'worktreeRoot' in body ? rootRefusalCode(err) : null;
      if (alive.current) setError(code ? t(`worktrees.root.refuse.${code}`) : failure ?? t('worktrees.saveFailed'));
      return false;
    }
  }, [t]);

  const saved = settings?.worktreeRoot ?? '';
  const dirty = root.trim() !== saved;

  return (
    <div className="space-y-5">
      <p className="text-compact leading-relaxed text-app-text-muted">{t('worktrees.blurb')}</p>

      <div className="space-y-2">
        <label className="block text-compact text-app-text" htmlFor="worktrees-root">{t('worktrees.root')}</label>
        <p className="text-mini leading-relaxed text-app-text-muted">{t('worktrees.root.hint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="worktrees-root"
            data-testid="worktrees-root"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={root}
            placeholder={t('worktrees.root.placeholder')}
            onChange={(e) => { setRoot(e.target.value); setError(null); }}
            className="min-w-0 flex-1 rounded-md border border-app-border bg-app-bg px-2.5 py-1.5 text-compact text-app-text placeholder:text-app-text-muted focus:border-primary focus:outline-none coarse:min-h-11"
          />
          <button
            type="button"
            data-testid="worktrees-root-save"
            disabled={!dirty || root.trim() === ''}
            onClick={() => { void patch({ worktreeRoot: root.trim() }, t('worktrees.root.saveFailed')); }}
            className="rounded-md bg-primary px-2.5 py-1.5 text-compact font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 coarse:min-h-11 coarse:px-3"
          >
            {t('worktrees.root.save')}
          </button>
        </div>
        {error && <div data-testid="worktrees-error" className="text-compact text-red-600 dark:text-red-400">{error}</div>}
        {saved !== '' && (
          <button
            type="button"
            data-testid="worktrees-root-reset"
            onClick={() => { void patch({ worktreeRoot: null }); }}
            className="text-compact text-app-text-muted underline-offset-2 hover:text-app-text hover:underline"
          >
            {t('worktrees.root.reset')}
          </button>
        )}
      </div>

      <div className="space-y-1 border-t border-app-border pt-3">
        <Dial
          label={t('worktrees.max')}
          hint={t('worktrees.max.hint')}
          value={String(settings?.worktreeMaxPerProject ?? DEFAULT_WORKTREE_MAX_PER_PROJECT)}
          options={withCurrent(MAX_CHOICES, settings?.worktreeMaxPerProject ?? DEFAULT_WORKTREE_MAX_PER_PROJECT).map((n) => ({ value: String(n), label: t('worktrees.count', { n: String(n) }) }))}
          onChange={(v) => { void patch({ worktreeMaxPerProject: Number(v) }); }}
        />
        <Dial
          label={t('worktrees.floor')}
          hint={t('worktrees.floor.hint')}
          value={String(settings?.worktreeDiskFloorGb ?? DEFAULT_WORKTREE_DISK_FLOOR_GB)}
          options={withCurrent(FLOOR_CHOICES, settings?.worktreeDiskFloorGb ?? DEFAULT_WORKTREE_DISK_FLOOR_GB).map((n) => ({ value: String(n), label: t('worktrees.gb', { n: String(n) }) }))}
          onChange={(v) => { void patch({ worktreeDiskFloorGb: Number(v) }); }}
        />
        <Dial
          label={t('worktrees.abandon')}
          hint={t('worktrees.abandon.hint')}
          value={String(settings?.worktreeAbandonDays ?? DEFAULT_WORKTREE_ABANDON_DAYS)}
          options={withCurrent(ABANDON_CHOICES, settings?.worktreeAbandonDays ?? DEFAULT_WORKTREE_ABANDON_DAYS).map((n) => ({ value: String(n), label: t('worktrees.days', { n: String(n) }) }))}
          onChange={(v) => { void patch({ worktreeAbandonDays: Number(v) }); }}
        />
        <Dial
          label={t('worktrees.quarantine')}
          hint={t('worktrees.quarantine.hint')}
          value={String(settings?.worktreeQuarantineDays ?? DEFAULT_WORKTREE_QUARANTINE_DAYS)}
          options={withCurrent(QUARANTINE_CHOICES, settings?.worktreeQuarantineDays ?? DEFAULT_WORKTREE_QUARANTINE_DAYS).map((n) => ({ value: String(n), label: t('worktrees.days', { n: String(n) }) }))}
          onChange={(v) => { void patch({ worktreeQuarantineDays: Number(v) }); }}
        />
        <Dial
          label={t('worktrees.cargo')}
          hint={t('worktrees.cargo.hint')}
          value={settings?.cargoTargetMode ?? DEFAULT_CARGO_TARGET_MODE}
          options={[
            { value: 'shared', label: t('worktrees.cargo.shared') },
            { value: 'per-worktree', label: t('worktrees.cargo.perWorktree') },
          ]}
          onChange={(v) => { void patch({ cargoTargetMode: v as 'shared' | 'per-worktree' }); }}
        />
        <Dial
          label={t('worktrees.foreign')}
          hint={t('worktrees.foreign.hint')}
          value={settings?.gcForeign ?? DEFAULT_GC_FOREIGN_MODE}
          options={[
            { value: 'off', label: t('worktrees.foreign.off') },
            { value: 'merged', label: t('worktrees.foreign.merged') },
          ]}
          onChange={(v) => { void patch({ gcForeign: v as 'off' | 'merged' }); }}
        />
      </div>

      <WorktreesMachines />

      <WorktreesPreview />
    </div>
  );
}

/** The closed list plus the stored value, so a number set by hand still shows as itself. */
function withCurrent(choices: number[], current: number): number[] {
  return choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b);
}

/** A labelled dropdown over a short list, same shape as the calendar's dials. */
function Dial({ label, hint, value, options, onChange }: {
  label: string;
  hint: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1">
      <span className="flex min-w-0 flex-col">
        <span className="text-compact text-app-text">{label}</span>
        <span className="text-mini break-words text-app-text-muted">{hint}</span>
      </span>
      <Select
        ariaLabel={label}
        align="right"
        value={value}
        onChange={onChange}
        className="max-w-full min-w-[140px] flex-shrink-0"
        options={options}
      />
    </div>
  );
}
