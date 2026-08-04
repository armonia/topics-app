/**
 * La parte che conta di questa card non è il disegno: è la FRASE. Dire «sta
 * dispacciando» mentre il dispatcher aspetta manda qualcuno a letto convinto che
 * la coda stia girando, ed è l'unico errore che questa card può fare davvero.
 */
import { describe, test, expect } from 'bun:test';
import { describeNight, formatCountdown, type NightStatus } from './NightModeCard';

const st = (o: Partial<NightStatus>): NightStatus => ({
  enabled: true, until: '10:00', startedAt: null, action: 'dispatch', reason: null,
  load1: 1, cores: 12, busySessions: 0, endsInMs: null, ...o,
});

describe('describeNight', () => {
  test('spenta: lo dice, e dice cosa significa', () => {
    const r = describeNight(null, false);
    expect(r.tone).toBe('off');
    expect(r.title).toBe('Spenta');
  });

  test('in attesa: il MOTIVO è il contenuto, non un dettaglio', () => {
    // È la ragione per cui la card esiste: senza il motivo, «in attesa» non
    // permette di decidere niente.
    const r = describeNight(st({ action: 'wait', reason: '2 sessioni attive' }), true);
    expect(r.tone).toBe('wait');
    expect(r.detail).toBe('2 sessioni attive');
  });

  test('via libera: verde, e senza inventare motivi', () => {
    const r = describeNight(st({ action: 'dispatch' }), true);
    expect(r.tone).toBe('go');
    expect(r.title).toBe('Sta dispacciando');
  });

  test('scaduta NON è «sta dispacciando»', () => {
    // Lo spegnimento vero lo fa il dispatcher al prossimo giro; fino ad allora
    // la card non deve promettere che la coda parte.
    const r = describeNight(st({ action: 'expire', reason: 'orario di fine (10:00) raggiunto' }), true);
    expect(r.tone).toBe('off');
    expect(r.title).toBe('Scaduta');
  });

  test('accesa ma server muto: NON si finge che vada tutto bene', () => {
    // Il caso pericoloso: nessuna risposta ≠ via libera.
    const r = describeNight(null, true);
    expect(r.tone).toBe('wait');
    expect(r.title).not.toBe('Sta dispacciando');
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
});
