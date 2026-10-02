/**
 * THE SETTINGS PANEL HOLDS THE FORMS, AND NOTHING ELSE.
 *
 * What is a direct control (a switch, a segment, a stepper) lives in the user
 * menu; what is who you are lives in the Profile tab. The panel keeps the five
 * entries where something has to be TYPED (a key, a URL, a code, a token),
 * in a fixed order. Putting a sixth back is a one line change no other test
 * would stop: this one does.
 *
 * No DOM: jsdom is not a dependency of the project. The list is DATA.
 * @covers USERMENU-06
 * @covers APPSET-05
 */
import { describe, test, expect } from 'bun:test';
import { SETTINGS_SECTIONS } from './sections';
import { t, missingKeys } from '../../lib/i18n';

describe('the settings entries', () => {
  test('exactly the five forms, in order', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(['providers', 'tools', 'calendar', 'plan', 'nodes']);
  });

  test('no identity page and no direct preference is an entry', () => {
    const ids: readonly string[] = SETTINGS_SECTIONS.map((s) => s.id);
    for (const gone of ['appearance', 'notifications', 'profile', 'followers', 'organization', 'devices', 'privacy']) {
      expect(ids).not.toContain(gone);
    }
  });

  test('no entry is repeated and each has its own label', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = SETTINGS_SECTIONS.map((s) => s.labelKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the labels exist in both languages', () => {
  const KEYS = [
    ...SETTINGS_SECTIONS.map((s) => s.labelKey),
    'settings.title',
    'settings.page.organization.title',
    'settings.page.organization.blurb',
    'settings.page.privacy.title',
  ];

  test('italian: no bare key on screen', () => {
    for (const key of KEYS) {
      // A missing key returns itself: that is the proof, not the text.
      expect(t(key, 'it')).not.toBe(key);
    }
  });

  test('english: really translated, not folded back onto italian', async () => {
    // `t(..., 'en')` of a missing key answers in ITALIAN on purpose, so it
    // cannot tell "translated" from "absent". The list of missing keys can.
    const missing = new Set(await missingKeys('en'));
    for (const key of KEYS) {
      expect(missing.has(key)).toBe(false);
    }
  });
});
