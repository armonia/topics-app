/**
 * THE AUDIT LINE OF A DEVICE: when it was last seen, from which address it
 * paired, and when it was revoked.
 *
 * The device list is the only place where an access you do not recognise shows
 * up, and a name alone does not tell a phone you own from one that paired with
 * a stolen code. The revoked rows stay and carry their date, so the list reads
 * as a history and not as an inventory.
 */
import type { PairedDevice } from './devicesRead';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** How long ago, in the coarsest unit that is still short; past a month, the
 *  date in the active language. */
export function deviceWhen(ms: number | null | undefined, t: Translate, locale: string, now = Date.now()): string {
  if (!ms) return t('devices.when.never');
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return t('devices.when.now');
  if (min < 60) return t('devices.when.min', { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('devices.when.hours', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('devices.when.days', { n: days });
  return new Date(ms).toLocaleDateString(locale === 'it' ? 'it-IT' : 'en-GB');
}

/** «connected now» or «seen 3 h ago», then the first address without the
 *  IPv4-mapped prefix the socket reports. */
export function deviceSeenLine(
  d: Pick<PairedDevice, 'connected' | 'lastSeenAt' | 'firstIp'>,
  t: Translate,
  locale: string,
  now = Date.now(),
): string {
  const seen = d.connected ? t('devices.connectedNow') : t('devices.seen', { quando: deviceWhen(d.lastSeenAt, t, locale, now) });
  return d.firstIp ? `${seen} · ${t('devices.fromIp', { ip: d.firstIp.replace(/^::ffff:/, '') })}` : seen;
}

/** «revoked 2 d ago». */
export function deviceRevokedLine(d: Pick<PairedDevice, 'revokedAt'>, t: Translate, locale: string, now = Date.now()): string {
  return t('devices.revokedWhen', { quando: deviceWhen(d.revokedAt, t, locale, now) });
}
