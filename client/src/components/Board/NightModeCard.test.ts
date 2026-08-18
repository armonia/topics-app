/**
 * La parte che conta di questa card non è il disegno: è la FRASE. Dire «sta
 * dispacciando» mentre il dispatcher aspetta manda qualcuno a letto convinto che
 * la coda stia girando, ed è l'unico errore che questa card può fare davvero.
 */
import { describe, test, expect } from 'bun:test';
import { describeNight, formatCountdown, type NightStatus } from './nightModeText';
import { ensureLocaleLoaded } from '../../lib/i18n';
// L'inglese vive in un chunk suo (`i18n-en.ts`, split del 15/08) e `t()` è
// sincrona: senza attendere il catalogo questi casi leggono il fallback italiano
// e falliscono per un motivo che non è quello che vogliono misurare.
await ensureLocaleLoaded('en');


const st = (o: Partial<NightStatus>): NightStatus => ({
  enabled: true, until: '10:00', startedAt: null, action: 'dispatch', reason: null,
  load1: 1, cores: 12, busySessions: 0, endsInMs: null, ...o,
});

describe('describeNight', () => {
  test('spenta: lo dice, e dice cosa significa', () => {
    const r = describeNight(null, false);
    expect(r.tone).toBe('off');
    expect(r.titleKey).toBe('board.night.state.off');
  });

  test('in attesa: il MOTIVO è il contenuto, non un dettaglio', () => {
    // È la ragione per cui la card esiste: senza il motivo, «in attesa» non
    // permette di decidere niente.
    const r = describeNight(st({ action: 'wait', reason: '2 sessioni attive' }), true);
    expect(r.tone).toBe('wait');
    // Il motivo arriva dal server già scritto: si mostra, non si ritraduce —
    // due copie della stessa frase divergerebbero.
    expect(r.detailText).toBe('2 sessioni attive');
    expect(r.detailKey).toBeNull();
  });

  test('via libera: verde, e senza inventare motivi', () => {
    const r = describeNight(st({ action: 'dispatch' }), true);
    expect(r.tone).toBe('go');
    expect(r.titleKey).toBe('board.night.state.go');
  });

  test('scaduta NON è «sta dispacciando»', () => {
    // Lo spegnimento vero lo fa il dispatcher al prossimo giro; fino ad allora
    // la card non deve promettere che la coda parte.
    const r = describeNight(st({ action: 'expire', reason: 'orario di fine (10:00) raggiunto' }), true);
    expect(r.tone).toBe('off');
    expect(r.titleKey).toBe('board.night.state.expired');
  });

  test('accesa ma server muto: NON si finge che vada tutto bene', () => {
    // Il caso pericoloso: nessuna risposta ≠ via libera.
    const r = describeNight(null, true);
    expect(r.tone).toBe('wait');
    expect(r.titleKey).not.toBe('board.night.state.go');
  });

  test('«non ho ancora chiesto» non è «il server non risponde»', () => {
    // Confonderli fa lampeggiare un errore a ogni accensione, e un errore che
    // sparisce da solo insegna a non fidarsi di quelli veri.
    expect(describeNight(null, true, false).titleKey).toBe('board.night.state.checking');
    expect(describeNight(null, true, true).titleKey).toBe('board.night.state.unknown');
  });
});

describe('formatCountdown', () => {
  test('la scadenza si legge come durata, non come orario', () => {
    expect(formatCountdown(45 * 60_000)).toBe('45 min');
    expect(formatCountdown(2 * 3600_000)).toBe('2h');
    expect(formatCountdown(2 * 3600_000 + 15 * 60_000)).toBe('2h 15min');
  });

  test('sotto il minuto non diventa «0 min»', () => {
    expect(formatCountdown(20_000)).toBe('meno di un minuto');
    expect(formatCountdown(0)).toBe('meno di un minuto');
  });

  test('segue la lingua scelta', () => {
    expect(formatCountdown(20_000, 'en')).toBe('less than a minute');
    expect(formatCountdown(2 * 3600_000 + 15 * 60_000, 'en')).toBe('2h 15min');
  });
});
