/** «2 ore fa»-style relative time for the Agents pages, ticking on the shared clock. */
import { useMemo } from 'react';
import { useLocale } from '../../hooks/useT';
import { useSharedNow } from '../../state/useSharedNow';

export function useAgo() {
  const locale = useLocale();
  const now = useSharedNow();
  return useMemo(() => {
    const fmt = new Intl.RelativeTimeFormat(locale === 'en' ? 'en-GB' : 'it-IT', { numeric: 'auto' });
    return (at: number) => {
      const min = Math.round((at - now) / 60_000);
      if (Math.abs(min) < 60) return fmt.format(min, 'minute');
      const h = Math.round(min / 60);
      if (Math.abs(h) < 24) return fmt.format(h, 'hour');
      return fmt.format(Math.round(h / 24), 'day');
    };
  }, [locale, now]);
}
