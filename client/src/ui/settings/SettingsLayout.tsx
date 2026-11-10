import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { CrumbModel } from '../types';
import { PaneHeader } from '../shell/PaneHeader';
import { SectionLabel } from '../primitives/Panel';
import { FOCUS_RING } from '../shell/pressable';

export interface SettingsSectionModel {
  id: string;
  label: string;
  icon: LucideIcon;
}

export interface SettingsGroupModel {
  label: string;
  sections: SettingsSectionModel[];
}

/**
 * The frame of every settings page: the list of sections on the left, grouped,
 * the current one lit; the page on the right under its own header. On a phone
 * the list becomes a row of chips above the page.
 */
export function SettingsLayout({ crumbs, groups, activeId, onSelect, actions, phone, children }: {
  crumbs: CrumbModel[];
  groups: SettingsGroupModel[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Controls of the page, right of its header. */
  actions?: ReactNode;
  phone?: boolean;
  children: ReactNode;
}) {
  const all = groups.flatMap((g) => g.sections);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader crumbs={crumbs}>{actions}</PaneHeader>
      {phone ? (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-app-border px-3 py-2" role="tablist">
          {all.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === activeId}
              onClick={() => onSelect(s.id)}
              className={clsx('h-7 shrink-0 rounded-full px-3 text-mini font-medium', FOCUS_RING, s.id === activeId ? 'bg-primary text-white' : 'bg-black/[0.05] text-app-text dark:bg-white/[0.08]')}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {!phone && (
          <nav aria-label={crumbs[0]?.label} className="w-[220px] shrink-0 overflow-y-auto border-r border-app-border px-2 py-3">
            {groups.map((g) => (
              <div key={g.label} className="mb-3">
                <SectionLabel className="mb-1 px-2">{g.label}</SectionLabel>
                {g.sections.map((s) => {
                  const Icon = s.icon;
                  const on = s.id === activeId;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-current={on ? 'page' : undefined}
                      onClick={() => onSelect(s.id)}
                      className={clsx(
                        'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-prose transition-colors',
                        FOCUS_RING,
                        on ? 'bg-black/[0.06] font-medium text-app-text dark:bg-white/[0.10]' : 'text-app-text-secondary hover:bg-black/[0.04] hover:text-app-text dark:hover:bg-white/[0.06]',
                      )}
                    >
                      <Icon size={14} className="shrink-0" aria-hidden="true" />
                      <span className="truncate">{s.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[880px] px-4 py-5 md:px-8">{children}</div>
        </div>
      </div>
    </div>
  );
}
