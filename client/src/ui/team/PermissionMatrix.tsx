import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Chip } from '../primitives/Chip';
import { Toggle } from '../primitives/Field';
import type { MatrixRoleModel, MatrixRowModel, RightsCell, RightsRowModel } from './model';

// The permission column takes most of the room: its hint is a sentence that must read in full.
const FIRST_MIN = 280;
const FIRST = `minmax(${FIRST_MIN}px, 2.6fr)`;

/**
 * Permissions by role: one row per permission, one switch per role. Every
 * switch is real: the caller applies it and the whole preview follows. A
 * switch the reader changed from the role's starting permissions carries a
 * dot, so a change is never silent. Wider than its place it scrolls inside
 * its own frame.
 */
export function PermissionMatrix({ ariaLabel, permissionColumn, roles, rows, onToggle, toggleTitle, disabledTitle, changedTitle }: {
  ariaLabel: string;
  permissionColumn: string;
  roles: MatrixRoleModel[];
  rows: MatrixRowModel[];
  onToggle: (roleId: string, rowId: string, next: boolean) => void;
  /** The accessible name of one switch. */
  toggleTitle: (role: string, row: string) => string;
  /** Set when the reader may not change them: the switches are drawn off and say why. */
  disabledTitle?: string;
  changedTitle: string;
}) {
  const template = `${FIRST} repeat(${roles.length}, minmax(84px, 1fr))`;
  const minWidth = FIRST_MIN + roles.length * 84;
  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-lg border border-app-border bg-surface">
      <div role="table" aria-label={ariaLabel} style={{ minWidth }} className="text-prose">
        <div role="row" style={{ gridTemplateColumns: template }} className="grid items-end border-b border-app-border bg-app-inset text-compact font-medium text-app-text-secondary">
          <span role="columnheader" className="px-3 py-2">{permissionColumn}</span>
          {roles.map((r) => (
            <span key={r.id} role="columnheader" className="px-1 py-2 text-center leading-4">{r.label}</span>
          ))}
        </div>
        {rows.map((row) => (
          <div key={row.id} role="row" style={{ gridTemplateColumns: template }} className="grid min-h-12 items-center border-b border-app-border last:border-b-0">
            <span role="cell" className="min-w-0 px-3 py-1.5">
              <span className="block font-medium text-app-text">{row.label}</span>
              {row.hint && <span className="block text-mini text-app-text-tertiary">{row.hint}</span>}
            </span>
            {roles.map((r) => (
              <span key={r.id} role="cell" className="relative flex justify-center">
                <Toggle
                  checked={row.values[r.id] ?? false}
                  onChange={(next) => onToggle(r.id, row.id, next)}
                  disabled={disabledTitle !== undefined}
                  title={disabledTitle ?? toggleTitle(r.label, row.label)}
                />
                {row.changed[r.id] && (
                  <span aria-hidden="true" data-tip={changedTitle} className="absolute right-3 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />
                )}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Cell({ cell, everyone, nobody }: { cell: RightsCell; everyone: string; nobody: string }) {
  if (cell.all) return <Chip tone="green">{everyone}</Chip>;
  if (cell.items.length === 0) return <span className="text-app-text-faint">{nobody}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {cell.items.map((i) => <Chip key={i}>{i}</Chip>)}
    </span>
  );
}

/** Who sees, proposes, changes and approves each part of the structure, read from the permissions. */
export function RightsTable({ rows, copy }: { rows: RightsRowModel[]; copy: UiCopy }) {
  const s = copy.team.structure;
  const cols = [s.columns.part, s.columns.sees, s.columns.proposes, s.columns.edits, s.columns.approves];
  const template = 'minmax(170px, 1.2fr) repeat(4, minmax(120px, 1fr))';
  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-lg border border-app-border bg-surface">
      <div role="table" aria-label={s.partsLabel} style={{ minWidth: 170 + 4 * 120 }} className="text-prose">
        <div role="row" style={{ gridTemplateColumns: template }} className="grid h-9 items-center border-b border-app-border bg-app-inset text-compact font-medium text-app-text-secondary">
          {cols.map((c) => <span key={c} role="columnheader" className="truncate px-3">{c}</span>)}
        </div>
        {rows.map((r) => (
          <div key={r.id} role="row" style={{ gridTemplateColumns: template }} className="grid items-center border-b border-app-border last:border-b-0">
            <span role="cell" className="px-3 py-2 font-medium text-app-text">{r.name}</span>
            {([r.sees, r.proposes, r.edits, r.approves] as RightsCell[]).map((cell, i) => (
              <span key={cols[i + 1]} role="cell" className={clsx('px-3 py-2')}>
                <Cell cell={cell} everyone={s.everyone} nobody={s.nobody} />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
