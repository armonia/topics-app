/**
 * WHAT THE COLUMN SHOWS (USERMENU-02): every control says the state that IS,
 * never the one a click would bring. The row that opens it is in
 * `TopicsMenuItems`.
 */
import { PanelLeft, PanelTop } from 'lucide-react';
import type { SidebarViewMode } from '@/hooks/useSidebarState';
import { useMobile } from '@/hooks/useMobile';
import { useT } from '@/hooks/useT';
import type { TabsPosition } from '@/lib/tabsPlacement';
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
  const { isMobile } = useMobile();
  return (
    <div className="py-1">
      {/* Desktop only: on a phone the column is the list and the row on top
          says the name, whatever is chosen here (`tabsPlacement`). The hint
          says where they are now, and when they move. */}
      {!isMobile && (
        <PreferenceRow
          label={tr('app.tabsPosition')}
          hint={tr(settings.tabsPosition === 'top' ? 'app.tabsPosition.topHint' : 'app.tabsPosition.sideHint')}
          testId="topics-menu-tabs-position-row"
        >
          <Segmented<TabsPosition>
            value={settings.tabsPosition === 'top' ? 'top' : 'side'}
            onChange={(v) => onSettingChange('tabsPosition', v)}
            ariaLabel={tr('app.tabsPosition')}
            testId="topics-menu-tabs-position"
            options={[
              { value: 'side', label: tr('app.tabsPosition.side'), icon: PanelLeft },
              { value: 'top', label: tr('app.tabsPosition.top'), icon: PanelTop },
            ]}
          />
        </PreferenceRow>
      )}
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
        label={tr('app.closeArchives')}
        hint={settings.closeArchives ? undefined : tr('app.closeArchives.hint')}
        checked={settings.closeArchives}
        onChange={(v) => onSettingChange('closeArchives', v)}
        testId="topics-menu-close-archives"
      />
      <SwitchRow
        label={tr('app.pinnedClosable')}
        checked={settings.pinnedClosable}
        onChange={(v) => onSettingChange('pinnedClosable', v)}
        testId="topics-menu-pinned-closable"
      />
      <SwitchRow
        label={tr('settings.board.showRow')}
        checked={settings.showBoardRow}
        onChange={(v) => onSettingChange('showBoardRow', v)}
        testId="topics-menu-board-row"
      />
      <SwitchRow
        label={tr('liveTerminals.setting')}
        checked={settings.showLiveTerminals}
        onChange={(v) => onSettingChange('showLiveTerminals', v)}
        testId="topics-menu-live-terminals"
      />
    </div>
  );
}
