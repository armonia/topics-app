/**
 * One suggestion row, and the quiet heading above a group of them.
 *
 * This row used to live inside `TabSheetBody`, which was fine while the tab
 * sheet was the only surface suggesting addresses. The new-tab page suggests
 * from the same sources (NEWTAB-ARC-02) and draws the same row: one component
 * in one module, instead of two that drift.
 */
import type { ReactNode } from 'react';
import { POPOVER_ITEM } from '../../lib/popoverStyles';

/** A quiet heading: the list is read top to bottom. */
export function SuggestionSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-1.5 pb-0.5 text-mini font-medium uppercase tracking-wide text-app-text-faint select-none">
      {children}
    </div>
  );
}

/** One suggestion: an address (or a command, or a note to create) in one click. */
export function Suggestion({ icon, primary, secondary, title, onClick, testId, active, dataKind, dataValue, onHover }: {
  icon: ReactNode;
  primary: string;
  secondary?: string;
  title: string;
  onClick: () => void;
  testId?: string;
  /** Keyboard-selected: painted as if hovered, and said on the element. */
  active?: boolean;
  dataKind?: string;
  dataValue?: string;
  onHover?: () => void;
}) {
  return (
    <button
      type="button"
      className={`${POPOVER_ITEM}${active ? ' bg-app-hover' : ''}`}
      onClick={onClick}
      onMouseMove={onHover}
      title={title}
      data-testid={testId}
      data-kind={dataKind}
      data-value={dataValue}
      data-active={active || undefined}
    >
      <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5 text-app-text-tertiary">{icon}</span>
      <span className="flex-1 min-w-0 truncate text-left">{primary}</span>
      {secondary && <span className="shrink-0 max-w-[40%] truncate text-app-text-faint text-mini">{secondary}</span>}
    </button>
  );
}
