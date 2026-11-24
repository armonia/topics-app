/**
 * THE «SISTEMA» ROW at the foot of the sidebar: the door to the agents' system
 * page. Its tail is the number of problems T7 found, nothing when there are
 * none, amber for warnings and red as soon as one is an error.
 */
import { Stethoscope } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import SYSTEM_ROW_IT from '../../lib/i18n-system-row-it';
import SYSTEM_ROW_EN from '../../lib/i18n-system-row-en';
import { highestSeverity, useSystemHealth } from '../../state/systemHealth';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { sidebarRowCard, ROW_PX, ROW_H, ROW_INSET, ROW_GLYPH, ROW_GLYPH_SLOT, TAB_LABEL_TYPE } from '../../lib/selectionStyles';

addCatalogue('it', SYSTEM_ROW_IT);
addCatalogue('en', SYSTEM_ROW_EN);

export function SystemRow({ open }: { open: boolean }) {
  const tr = useT();
  const { problems } = useSystemHealth();
  const count = problems?.length ?? 0;
  const severity = problems ? highestSeverity(problems) : null;
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={open}
      data-testid="sidebar-system"
      title={tr('system.rowTitle')}
      onClick={() => window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'system-page' } }))}
      className={`flex flex-shrink-0 items-center gap-2 leading-none ${ROW_PX} ${ROW_H} select-none ${sidebarRowCard({ focused: open })}`}
      style={{ width: `calc(100% - ${ROW_INSET * 2}px)` }}
    >
      <span className={ROW_GLYPH_SLOT} data-row-glyph-slot="glyph">
        <Stethoscope size={ROW_GLYPH} className="text-app-text-secondary" aria-hidden="true" />
      </span>
      <span className={`min-w-0 flex-1 truncate text-left ${TAB_LABEL_TYPE}`}>{tr('system.row')}</span>
      {count > 0 && (
        <span
          data-testid="sidebar-system-count"
          data-severity={severity}
          title={tr('system.rowProblems', { n: count })}
          className={`flex-shrink-0 text-mini tabular-nums ${severity === 'error' ? DANGER_TEXT : WARNING_TEXT}`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
