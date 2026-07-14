import type { PaneType } from '../state/pane/types';

/**
 * Background tier of a layout CELL hosting a content pane (GroupLayout and
 * StandaloneChatGroup keep-alive wrappers — one decision, two call sites).
 *
 * Three tiers under the mac vibrancy shell:
 * - '' (fully transparent): `project` and `terminal` — they paint their own
 *   chrome and frost themselves;
 * - `pane-frost`: chat topics + kanban — frosted tier (transparent under
 *   `.electron-mac`, opaque `bg-surface` fallback on the web; see index.css);
 * - `bg-surface`: every other pane keeps the opaque content backdrop that
 *   keeps dense text crisp (dashboard tables, file trees, session viewers).
 */
export function paneCellBg(type: PaneType): string {
  if (type === 'project' || type === 'terminal') return '';
  if (type === 'chat' || type === 'kanban' || type === 'board') return 'pane-frost';
  return 'bg-surface';
}
