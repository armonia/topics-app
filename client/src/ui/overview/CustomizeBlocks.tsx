import { ArrowDown, ArrowUp } from 'lucide-react';
import { IconButton } from '../primitives/Button';
import { Checkbox } from '../primitives/Field';
import type { OverviewBlockId } from './model';

export interface BlockChoiceModel {
  id: OverviewBlockId;
  label: string;
  /** One line on what the block shows. */
  detail: string;
  visible: boolean;
}

/**
 * The list a person uses to choose which blocks of the overview show and in
 * which order. Every block can be hidden; the order is the order of the list.
 */
export function CustomizeBlocks({ blocks, onToggle, onMove, upLabel, downLabel, listLabel }: {
  blocks: BlockChoiceModel[];
  onToggle: (id: OverviewBlockId, visible: boolean) => void;
  onMove: (id: OverviewBlockId, direction: -1 | 1) => void;
  upLabel: (block: string) => string;
  downLabel: (block: string) => string;
  listLabel: string;
}) {
  return (
    <ul aria-label={listLabel} className="divide-y divide-app-border-light rounded-lg border border-app-border">
      {blocks.map((b, i) => (
        <li key={b.id} className="flex items-center gap-3 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <Checkbox checked={b.visible} onChange={(v) => onToggle(b.id, v)} label={b.label} />
            <p className="pl-6 text-mini leading-4 text-app-text-tertiary">{b.detail}</p>
          </div>
          {/* The first block has no way up and the last none down: the arrow is not drawn, the slot stays. */}
          <span className="inline-flex h-7 w-7 shrink-0">
            {i > 0 && <IconButton icon={ArrowUp} label={upLabel(b.label)} onClick={() => onMove(b.id, -1)} />}
          </span>
          <span className="inline-flex h-7 w-7 shrink-0">
            {i < blocks.length - 1 && <IconButton icon={ArrowDown} label={downLabel(b.label)} onClick={() => onMove(b.id, 1)} />}
          </span>
        </li>
      ))}
    </ul>
  );
}
