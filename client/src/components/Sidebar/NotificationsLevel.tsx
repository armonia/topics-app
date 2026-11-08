/**
 * THE NOTIFICATIONS, one home for every preference about them (USERMENU-03).
 *
 * This was the «Notifications» page of the Settings panel, and the bell's gear
 * opened that page. Everything that page held is here, moved and not
 * rewritten: the three switches, the true state of the system banners with the
 * one button that state allows (NOTIF-PERM-01), the disk access «Do not
 * disturb» needs when it is missing, this device's push subscription, the
 * other devices, and the muted projects. The push block is two child levels,
 * because in a 288px level it does not fit in one.
 *
 * The bell keeps the HISTORY; the preferences are here. Two panels, two jobs.
 */
import { lazy, Suspense } from 'react';
import { Bell } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { SubmenuItem } from '../Shared/SubmenuItem';
import type { MenuPreferences } from './AppearanceLevel';

// The level's body (and the push and shell status it reads) is loaded the
// first time the level opens: the row and its tail are all the first paint needs.
const NotificationsLevelBody = lazy(async () => {
  const { NotificationsLevelBody: Body } = await import('./NotificationsLevelBody');
  return { default: Body };
});

export function NotificationsLevel({ preferences, defaultOpen = false }: {
  preferences: MenuPreferences;
  defaultOpen?: boolean;
}) {
  const tr = useT();
  const on = preferences.settings.notificationsEnabled;

  return (
    <SubmenuItem
      icon={Bell}
      label={tr('settings.section.notifications')}
      testId="topics-menu-notifications"
      minWidth={288}
      maxWidth={340}
      defaultOpen={defaultOpen}
      tail={
        <span data-testid="topics-menu-notifications-tail" className="flex-shrink-0 text-mini text-app-text-tertiary">
          {on ? tr('notif.level.on') : tr('notif.level.off')}
        </span>
      }
    >
      <Suspense fallback={<div className="h-24" />}>
        <NotificationsLevelBody preferences={preferences} />
      </Suspense>
    </SubmenuItem>
  );
}

