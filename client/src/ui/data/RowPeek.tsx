import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Chip, FieldChip } from '../primitives/Chip';
import { KeyValue, PanelHeading, PanelSection } from '../primitives/Panel';
import { FOCUS_RING } from '../shell/pressable';
import { Avatar } from '../shell/SidebarRows';
import { TONE_TEXT } from '../tone';
import type { Action } from '../types';
import type { PeekModel } from './model';

/**
 * One row of the table, open at the side: its fields, what it links to (each
 * link opens what it names), its history. The footer opens the record when
 * the row has one. On a phone it stacks under the table.
 */
export function RowPeek({ row, copy, phone, onOpen, onOpenLinked }: {
  row: PeekModel;
  copy: UiCopy;
  phone: boolean;
  onOpen?: Action;
  onOpenLinked?: (id: string) => void;
}) {
  const d = copy.data;
  return (
    <aside className={clsx('flex shrink-0 flex-col border-app-border bg-surface', phone ? 'w-full border-t' : 'h-full w-[290px] border-l')}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PanelHeading tag={row.tag} title={row.title}>{row.badge && <Chip tone="green">{row.badge}</Chip>}</PanelHeading>
        <div className="space-y-3 border-b border-app-border px-4 py-3.5">
          {row.fields.map((f) => (
            <div key={f.label}>
              <div className="mb-1 text-compact text-app-text-tertiary">{f.label}</div>
              <div className={clsx('flex min-h-9 items-center gap-2 rounded-md bg-black/[0.04] px-3 py-1.5 text-prose dark:bg-white/[0.06]', f.tone ? `font-medium ${TONE_TEXT[f.tone]}` : 'text-app-text')}>
                {f.avatar && <Avatar text={f.avatar.text} color={f.avatar.color} size={20} />}
                {f.value}
              </div>
            </div>
          ))}
        </div>
        {row.linked.length > 0 && (
          <PanelSection label={d.linked}>
            {row.linked.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => onOpenLinked?.(l.id)}
                className={clsx('-mx-1 flex w-[calc(100%+8px)] items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]', FOCUS_RING)}
              >
                {/* Both sides may be long (a card's title, a town's name): they share the line and end in an ellipsis instead of pushing the panel wider. */}
                <span className="flex min-w-0 shrink" data-tip={l.field.name}><FieldChip field={l.field} className="max-w-full" /></span>
                <span className="ml-auto min-w-0 max-w-[50%] shrink-0 truncate text-right text-prose tabular-nums text-app-text" data-tip={l.value}>{l.value}</span>
              </button>
            ))}
          </PanelSection>
        )}
        {row.history.length > 0 && (
          <PanelSection label={d.rowHistory}>
            {row.history.map((h) => <KeyValue key={h.text + h.when} label={h.text} value={<span className="text-app-text-tertiary">{h.when}</span>} />)}
          </PanelSection>
        )}
      </div>
      {row.openLabel && (
        <div className="shrink-0 border-t border-app-border px-4 py-3">
          <Button variant="primary" className="w-full" onClick={onOpen}>{row.openLabel}</Button>
        </div>
      )}
    </aside>
  );
}
