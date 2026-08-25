/**
 * TRE DOMANDE, TRE VOCI — e il test che impedisce di rifonderle.
 *
 * Il difetto originale non era una funzione mancante: le organizzazioni e i
 * profili delle persone c'erano già tutti, dentro una voce chiamata «Profilo»,
 * quarto e sesto riquadro di una colonna che si scorre. Chi li cercava non li
 * trovava, e «non li trovo» si racconta come «non ci sono». Rimetterli dentro
 * un'unica voce sarebbe una modifica di tre righe che nessun test rosso
 * fermerebbe: questo lo fa.
 *
 * Niente DOM: jsdom non è una dipendenza del progetto (stessa scelta di
 * `IdentitySection.test.tsx`). L'elenco delle voci è un DATO, quindi si legge.
  * @covers APPSET-05
 */
import { describe, test, expect } from 'bun:test';
import { SETTINGS_SECTIONS, IDENTITY_SECTIONS } from './sections';
import { t, missingKeys } from '../../lib/i18n';

describe('le voci delle impostazioni', () => {
  test('profile, followers, privacy and organization are top level entries', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(ids).toContain('profile');
    expect(ids).toContain('followers');
    expect(ids).toContain('privacy');
    expect(ids).toContain('organization');
  });

  // THE PROFILE IS NOT THE ORGANISATION. Putting the org page back among the
  // identity tabs is a one word change nobody would notice in review, and it
  // would undo the whole point: a profile answers who a person is, and "which
  // company they were added to" is not part of that answer. The org model
  // itself stays where it is, carrying grants and project visibility.
  test('the profile tab does not carry the organization', () => {
    expect(IDENTITY_SECTIONS).not.toContain('organization');
  });

  test('nessuna voce è ripetuta e ognuna ha la sua etichetta', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const chiavi = SETTINGS_SECTIONS.map((s) => s.labelKey);
    expect(new Set(chiavi).size).toBe(chiavi.length);
  });

  test('le tre pagine dell\'identità sono nell\'elenco delle voci', () => {
    for (const id of IDENTITY_SECTIONS) {
      expect(SETTINGS_SECTIONS.some((s) => s.id === id)).toBe(true);
    }
  });
});

describe('le etichette esistono in tutte e due le lingue', () => {
  const CHIAVI = [
    ...SETTINGS_SECTIONS.map((s) => s.labelKey),
    'settings.page.profile.title',
    'settings.page.profile.blurb',
    'settings.page.organization.title',
    'settings.page.organization.blurb',
    'settings.page.followers.title',
    'settings.page.followers.blurb',
    'settings.page.privacy.title',
    'settings.page.privacy.blurb',
  ];

  test('italiano: nessuna chiave nuda a schermo', () => {
    for (const chiave of CHIAVI) {
      // Una chiave mancante torna se stessa: è quella la prova, non il testo.
      expect(t(chiave, 'it')).not.toBe(chiave);
    }
  });

  test('inglese: tradotte davvero, non ripiegate sull\'italiano', async () => {
    // `t(..., 'en')` di una chiave mancante risponde in ITALIANO — il ripiego è
    // voluto — quindi non distinguerebbe «tradotta» da «assente». L'elenco
    // delle mancanti sì.
    const mancanti = new Set(await missingKeys('en'));
    for (const chiave of CHIAVI) {
      expect(mancanti.has(chiave)).toBe(false);
    }
  });
});
