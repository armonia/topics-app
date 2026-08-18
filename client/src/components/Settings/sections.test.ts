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
 */
import { describe, test, expect } from 'bun:test';
import { SETTINGS_SECTIONS, IDENTITY_SECTIONS } from './sections';
import { t, missingKeys } from '../../lib/i18n';

describe('le voci delle impostazioni', () => {
  test('profilo, organizzazione e amici sono TRE voci di primo livello', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(ids).toContain('profile');
    expect(ids).toContain('organization');
    expect(ids).toContain('friends');
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
    'settings.page.friends.title',
    'settings.page.friends.blurb',
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
