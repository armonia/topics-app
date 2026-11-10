import { BookOpen, Plus, X } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { MenuButton } from '../primitives/Menu';
import { FOCUS_RING } from '../shell/pressable';

/** The knowledge a step reads, as chips that open it, with a menu to add more and a cross to take one away. */
export function KnowledgeChips({ copy, used, pool, editable, deniedTitle, onAdd, onRemove, onOpen }: {
  copy: UiCopy;
  used: string[];
  pool: string[];
  editable: boolean;
  deniedTitle?: string;
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  onOpen: (name: string) => void;
}) {
  const c = copy.flowRun.knowledge;
  const free = pool.filter((p) => !used.includes(p));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {used.map((name) => (
        <span key={name} className="inline-flex h-6 items-center rounded-md bg-black/[0.05] text-compact text-app-text dark:bg-white/10">
          <button
            type="button"
            onClick={() => onOpen(name)}
            data-tip={c.open(name)}
            className={clsx('inline-flex h-6 items-center gap-1 rounded-md pl-1.5 pr-1.5 hover:underline underline-offset-2', FOCUS_RING)}
          >
            <BookOpen size={12} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
            {name}
          </button>
          {editable && (
            <button
              type="button"
              onClick={() => onRemove(name)}
              aria-label={c.remove(name)}
              data-tip={c.remove(name)}
              className={clsx('mr-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-app-text-tertiary hover:bg-black/[0.08] hover:text-app-text', FOCUS_RING)}
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
      <MenuButton
        label={c.add}
        icon={Plus}
        size="sm"
        variant="ghost"
        disabled={!editable || free.length === 0}
        title={!editable ? deniedTitle : free.length === 0 ? c.nothingToAdd : undefined}
        items={free.map((f) => ({ id: f, label: f, icon: BookOpen }))}
        onSelect={onAdd}
      />
    </div>
  );
}
