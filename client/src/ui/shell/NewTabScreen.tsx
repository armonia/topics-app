import type { NavKind } from '../types';
import type { UiCopy } from '../copy/types';
import { NAV_ICON } from '../icons';
import { PaneHeader } from './PaneHeader';
import { FOCUS_RING } from './pressable';

type NewTabItem = { id: string; kind: NavKind; label: string; detail?: string };

/**
 * The pane of a new tab: the places that can be opened in it, in groups (what
 * was open lately, then every surface of the organization). It owns nothing;
 * the container decides what `onOpen` does with the id.
 */
export function NewTabScreen({ title, groups, onOpen, copy }: {
  title: string;
  groups: Array<{ id: string; label: string; items: NewTabItem[] }>;
  onOpen: (id: string) => void;
  copy: UiCopy;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: copy.shell.addTab }]} />
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pb-10 pt-10 sm:px-8 sm:pt-16">
        <h2 className="text-headline font-semibold text-app-text">{title}</h2>
        {groups.filter((g) => g.items.length > 0).map((g) => (
        <section key={g.id} aria-label={g.label} className="mt-6 w-full max-w-[720px]">
        <h3 className="mb-2 text-compact font-semibold text-app-text-tertiary">{g.label}</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {g.items.map((item) => {
            const Icon = NAV_ICON[item.kind];
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpen(item.id)}
                className={`flex flex-col items-start gap-1.5 rounded-lg border border-app-border bg-surface px-4 py-3.5 text-left transition-colors hover:bg-app-hover ${FOCUS_RING}`}
              >
                <Icon size={16} className="text-app-text-secondary" aria-hidden="true" />
                <span className="text-prose font-semibold text-app-text">{item.label}</span>
                {item.detail && <span className="text-compact text-app-text-tertiary">{item.detail}</span>}
              </button>
            );
          })}
        </div>
        </section>
        ))}
      </div>
    </div>
  );
}
