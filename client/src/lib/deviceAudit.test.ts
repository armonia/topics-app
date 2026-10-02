import { describe, expect, test } from 'bun:test';
import { t as translate } from './i18n';
import { deviceRevokedLine, deviceSeenLine, deviceWhen } from './deviceAudit';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const italian = (key: string, vars?: Record<string, string | number>) => translate(key, 'it', vars);
const minutes = (n: number) => n * 60_000;

describe('deviceWhen', () => {
  test('says how long ago, in the coarsest unit that is still short', () => {
    expect(deviceWhen(NOW - 10_000, italian, 'it', NOW)).toBe('adesso');
    expect(deviceWhen(NOW - minutes(5), italian, 'it', NOW)).toBe('5 min fa');
    expect(deviceWhen(NOW - minutes(180), italian, 'it', NOW)).toBe('3 h fa');
    expect(deviceWhen(NOW - minutes(60 * 24 * 4), italian, 'it', NOW)).toBe('4 g fa');
  });

  test('past a month it is a date, and no timestamp is «never»', () => {
    const january = Date.UTC(2026, 0, 15, 12);
    expect(deviceWhen(january, italian, 'it', NOW)).toBe(new Date(january).toLocaleDateString('it-IT'));
    expect(deviceWhen(null, italian, 'it', NOW)).toBe('mai');
    expect(deviceWhen(undefined, italian, 'it', NOW)).toBe('mai');
  });
});

describe('deviceSeenLine', () => {
  test('a device away says when it was last seen and from which address it paired', () => {
    expect(deviceSeenLine({ connected: false, lastSeenAt: NOW - minutes(180), firstIp: '::ffff:192.168.1.4' }, italian, 'it', NOW))
      .toBe('visto 3 h fa · da 192.168.1.4');
  });

  test('a connected device says so, and a missing address is left out', () => {
    expect(deviceSeenLine({ connected: true, lastSeenAt: NOW - minutes(180), firstIp: null }, italian, 'it', NOW))
      .toBe('connesso adesso');
  });
});

describe('deviceRevokedLine', () => {
  test('says when the trust was taken away', () => {
    expect(deviceRevokedLine({ revokedAt: NOW - minutes(60 * 24 * 2) }, italian, 'it', NOW)).toBe('revocato 2 g fa');
  });
});
