/**
 * The clock of «Account e quote» (hub-smistamento, HUBBR-10): «gio 10:00» and
 * «10:00» in the user's language, built once per language.
 */
import { useMemo } from 'react';

export type Clock = ReturnType<typeof useClock>;

export function useClock(locale: string) {
  return useMemo(() => {
    const tag = locale === 'en' ? 'en-GB' : 'it-IT';
    const time = new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit' });
    const day = new Intl.DateTimeFormat(tag, { weekday: 'short' });
    return { time: (ms: number) => time.format(ms), dayTime: (ms: number) => `${day.format(ms).replace('.', '')} ${time.format(ms)}` };
  }, [locale]);
}
