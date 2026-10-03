/**
 * THE CALENDAR FEED, in the menu of the pinned calendar tile (SETHOME-01).
 *
 * The tile is the agenda the person looks at; the iCal feed is where the agenda
 * the agents read comes from. Both are «my calendar», so the form lives in the
 * tile's own menu, with its state in the tail («Collegato», «In pausa», «Non
 * collegato»), and opens beside the tile. Nobody who never pinned a calendar
 * sees it in the column: for them the door is the palette's «Calendario».
 */
import { useEffect, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { appSettingsApi, type AppBehaviorSettings } from '@/lib/api';
import { openHome } from '@/lib/openHome';
import { POPOVER_ITEM } from '@/lib/popoverStyles';
import { calendarTail } from './formLevelTails';
import { useT } from '@/hooks/useT';

export function CalendarMenuRow({ tile, onPicked }: {
  /** The tile the menu was opened on: the panel hangs from it. */
  tile: HTMLElement | null;
  /** Closes the tile's menu. */
  onPicked: () => void;
}) {
  const tr = useT();
  const [settings, setSettings] = useState<AppBehaviorSettings | null>(null);
  // Mounted with the menu: read once per opening, never while it is closed.
  useEffect(() => {
    let alive = true;
    appSettingsApi.get().then((s) => { if (alive) setSettings(s); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const tail = calendarTail(settings, tr);
  return (
    <button
      type="button"
      onClick={() => { onPicked(); openHome('calendar', tile); }}
      className={POPOVER_ITEM}
      data-testid="calendar-tile-feed"
    >
      <CalendarDays size={14} />
      <span className="min-w-0 flex-1 truncate">{tr('home.calendar')}</span>
      {tail && <span data-testid="calendar-tile-feed-tail" className="flex-shrink-0 text-mini text-app-text-muted">{tail}</span>}
    </button>
  );
}
