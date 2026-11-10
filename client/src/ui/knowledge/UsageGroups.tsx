import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { SectionLabel } from '../primitives/Panel';
import { FOCUS_RING } from '../shell/pressable';
import type { UsageGroupModel } from './model';

/**
 * What cites a document, by kind: cases, procedures, flow steps, answers.
 * Every row opens the thing that cites it.
 */
export function UsageGroups({ groups, copy, onOpen }: {
  groups: UsageGroupModel[];
  copy: UiCopy;
  onOpen: (groupId: string, rowId: string) => void;
}) {
  const shown = groups.filter((g) => g.rows.length);
  if (!shown.length) return <p className="text-prose text-app-text-tertiary">{copy.preview.noUsage}</p>;
  return (
    <div className="space-y-5">
      {shown.map((g) => (
        <section key={g.id}>
          <SectionLabel className="mb-2">{g.label} · {g.rows.length}</SectionLabel>
          <ul className="space-y-0.5">
            {g.rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpen(g.id, r.id)}
                  className={clsx('-mx-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-app-hover', FOCUS_RING)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-prose font-semibold text-app-text">{r.title}</span>
                    <span className="block text-compact text-app-text-tertiary">{r.detail}</span>
                  </span>
                  <ChevronRight size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
