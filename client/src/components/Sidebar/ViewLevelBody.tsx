/**
 * WHAT THE COLUMN SHOWS (USERMENU-02): every control says the state that IS,
 * never the one a click would bring. The row that opens it is in
 * `TopicsMenuItems`.
 */
import type { SidebarViewMode } from '@/hooks/useSidebarState';
import { useT } from '@/hooks/useT';
import { Segmented } from '../Shared/Segmented';
import { PreferenceRow, SwitchRow } from './PreferenceRow';
import type { MenuPreferences } from './AppearanceLevel';

export function ViewLevelBody({ showArchived, onToggleArchived, viewMode, onViewModeChange, preferences }: {
  showArchived: boolean;
  onToggleArchived: () => void;
  viewMode: SidebarViewMode;
  onViewModeChange: (mode: SidebarViewMode) => void;
  preferences: MenuPreferences;
}) {
  const tr = useT();
  const { settings, onSettingChange } = preferences;
  return (
    <div className="py-1">
      <SwitchRow
        label={tr('app.showArchived')}
        checked={showArchived}
        onChange={onToggleArchived}
        testId="topics-menu-archived"
      />
      <PreferenceRow label={tr('app.viewOrder')}>
        <Segmented<SidebarViewMode>
          value={viewMode}
          onChange={onViewModeChange}
          ariaLabel={tr('app.viewOrder')}
          testId="topics-menu-view-mode"
          options={[
            { value: 'timeline', label: tr('app.viewOrderTimeline') },
            { value: 'state', label: tr('app.viewOrderState') },
          ]}
        />
      </PreferenceRow>
      <SwitchRow
        label={tr('settings.board.showRow')}
        checked={settings.showBoardRow}
        onChange={(v) => onSettingChange('showBoardRow', v)}
        testId="topics-menu-board-row"
      />
    </div>
  );
}
