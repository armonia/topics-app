/**
 * @covers CHAT-WAIT-02
 */
import { describe, expect, it } from 'bun:test';
import {
  deriveWorkLongevity,
  deriveSubjectTime,
  formatElapsedCompact,
  formatElapsedShort,
  formatRelative,
  WORK_ELAPSED_AFTER_MS,
  WORK_STALE_AFTER_MS,
} from './workLongevity';

const NOW = 1_700_000_000_000;

describe('deriveWorkLongevity', () => {
  it('a just-updated turn shows nothing (bare spinner)', () => {
    const r = deriveWorkLongevity(NOW - 5_000, NOW);
    expect(r.showElapsed).toBe(false);
    expect(r.isStale).toBe(false);
    expect(r.elapsedMs).toBe(5_000);
  });

  it('shows the "agg. Xm fa" readout at the elapsed threshold, still not stale', () => {
    const r = deriveWorkLongevity(NOW - WORK_ELAPSED_AFTER_MS, NOW);
    expect(r.showElapsed).toBe(true);
    expect(r.isStale).toBe(false);
  });

  it('just under the elapsed threshold stays bare', () => {
    const r = deriveWorkLongevity(NOW - (WORK_ELAPSED_AFTER_MS - 1), NOW);
    expect(r.showElapsed).toBe(false);
  });

  it('escalates to stale at the stale threshold', () => {
    const r = deriveWorkLongevity(NOW - WORK_STALE_AFTER_MS, NOW);
    expect(r.showElapsed).toBe(true);
    expect(r.isStale).toBe(true);
  });

  it('18 minutes with no update is stale', () => {
    const r = deriveWorkLongevity(NOW - 18 * 60_000, NOW);
    expect(r.isStale).toBe(true);
    expect(r.elapsedMs).toBe(18 * 60_000);
  });

  it('missing / invalid lastUpdate yields no readout and no escalation', () => {
    for (const bad of [undefined, 0, -1, NaN, Infinity]) {
      const r = deriveWorkLongevity(bad as number | undefined, NOW);
      expect(r).toEqual({ elapsedMs: 0, showElapsed: false, isStale: false });
    }
  });

  it('clock skew (lastUpdate in the future) clamps to 0, never negative', () => {
    const r = deriveWorkLongevity(NOW + 30_000, NOW);
    expect(r.elapsedMs).toBe(0);
    expect(r.showElapsed).toBe(false);
    expect(r.isStale).toBe(false);
  });
});

describe('formatElapsedCompact', () => {
  it('renders whole minutes without seconds', () => {
    expect(formatElapsedCompact(2 * 60_000)).toBe('2m');
    expect(formatElapsedCompact(18 * 60_000 + 43_000)).toBe('18m');
    expect(formatElapsedCompact(59 * 60_000)).toBe('59m');
  });

  it('renders hours + minutes past an hour', () => {
    expect(formatElapsedCompact(60 * 60_000)).toBe('1h 00m');
    expect(formatElapsedCompact(62 * 60_000)).toBe('1h 02m');
  });

  it('never renders "0m" and is empty for invalid input', () => {
    expect(formatElapsedCompact(30_000)).toBe('1m');
    expect(formatElapsedCompact(-1)).toBe('');
    expect(formatElapsedCompact(NaN)).toBe('');
  });
});


describe('deriveSubjectTime — quale tempo mostrare', () => {
  const M = 60_000;

  it('mentre LAVORA misura il turno, non l\'ultima azione', () => {
    // `since` e' l'inizio del tool corrente e si riazzera a ogni tool call: da
    // solo diceva «3s» a un turno che andava avanti da venti minuti.
    const t = deriveSubjectTime(
      { working: true, since: NOW - 3_000, turnSince: NOW - 20 * M },
      undefined,
      NOW,
    );
    expect(t).toEqual({ kind: 'working', ms: 20 * M, approx: false });
  });

  it('senza inizio del turno ricade su `since`, e lo DICHIARA', () => {
    // Succede quando il server e' ripartito a meta' turno: `turnStartedAt` non
    // e' persistito apposta. Il numero e' un MINIMO, non la verita', e `approx`
    // e' cio' che permette al tooltip di non spacciarlo per esatto.
    const t = deriveSubjectTime({ working: true, since: NOW - 4 * M }, undefined, NOW);
    expect(t).toEqual({ kind: 'working', ms: 4 * M, approx: true });
  });

  it('da FERMA misura quanto fa che ha finito', () => {
    // Per una sessione parcheggiata `since` E' il momento in cui e' entrata in
    // quella fase, cioe' la fine del turno.
    const t = deriveSubjectTime({ working: false, since: NOW - 7 * M }, undefined, NOW);
    expect(t).toEqual({ kind: 'done', ms: 7 * M, approx: false });
  });

  it('senza descrittore vivo usa l\'ultimo movimento noto', () => {
    // Una sessione conclusa non ha piu' un descrittore: resta
    // `sessionLastActivity`, che e' l'unica base per «finito X fa».
    const t = deriveSubjectTime(undefined, NOW - 90 * M, NOW);
    expect(t).toEqual({ kind: 'done', ms: 90 * M, approx: false });
  });

  it('niente da mostrare quando non si sa niente', () => {
    expect(deriveSubjectTime(undefined, undefined, NOW)).toBe(null);
    expect(deriveSubjectTime(undefined, 0, NOW)).toBe(null);
    expect(deriveSubjectTime({ working: true, since: 0 }, undefined, NOW)).toBe(null);
  });

  it('un orologio sfasato non produce durate negative', () => {
    expect(deriveSubjectTime({ working: true, since: NOW + 5 * M, turnSince: NOW + 5 * M }, undefined, NOW)?.ms).toBe(0);
    expect(deriveSubjectTime(undefined, NOW + 5 * M, NOW)?.ms).toBe(0);
  });

  it('UNA sola voce di tempo per soggetto: o lavora o ha finito', () => {
    const lavora = deriveSubjectTime({ working: true, since: NOW - M, turnSince: NOW - M }, NOW - 99 * M, NOW);
    expect(lavora?.kind).toBe('working');
    const ferma = deriveSubjectTime({ working: false, since: NOW - M }, NOW - 99 * M, NOW);
    expect(ferma?.kind).toBe('done');
  });
});

describe('formatElapsedShort', () => {
  it('sotto il minuto i secondi sono l\'informazione', () => {
    // `formatElapsedCompact` ha un pavimento a «1m»: mostrava «1m» a un turno di
    // tre secondi, cioe' proprio dove il numero serve piu' preciso.
    expect(formatElapsedShort(3_000)).toBe('3s');
    expect(formatElapsedShort(45_000)).toBe('45s');
    expect(formatElapsedShort(0)).toBe('0s');
  });

  it('sopra il minuto torna al formato compatto', () => {
    expect(formatElapsedShort(60_000)).toBe('1m');
    expect(formatElapsedShort(62 * 60_000)).toBe('1h 02m');
  });

  it('vuoto su input non valido', () => {
    expect(formatElapsedShort(-1)).toBe('');
    expect(formatElapsedShort(NaN)).toBe('');
  });
});


describe('formatRelative — la colonna «quanto tempo fa»', () => {
  const M = 60_000, H = 60 * M, D = 24 * H;

  it('scala di unita\' senza mai mostrare zero', () => {
    expect(formatRelative(NOW, NOW)).toBe('now');
    expect(formatRelative(NOW - 59_000, NOW)).toBe('now');
    expect(formatRelative(NOW - 2 * M, NOW)).toBe('2m');
    expect(formatRelative(NOW - 59 * M, NOW)).toBe('59m');
    expect(formatRelative(NOW - 3 * H, NOW)).toBe('3h');
    expect(formatRelative(NOW - 23 * H, NOW)).toBe('23h');
    expect(formatRelative(NOW - 5 * D, NOW)).toBe('5d');
    expect(formatRelative(NOW - 29 * D, NOW)).toBe('29d');
    expect(formatRelative(NOW - 60 * D, NOW)).toBe('2mo');
  });

  it('prende `now` come ARGOMENTO: e\' cio\' che le impedisce di congelarsi', () => {
    // Le tre copie che questa funzione ha sostituito leggevano `Date.now()`
    // dentro il render. Con `now` iniettato, lo stesso timestamp a due istanti
    // diversi da' due risposte diverse — che e' tutto il punto della colonna.
    const at = NOW - 2 * M;
    expect(formatRelative(at, NOW)).toBe('2m');
    expect(formatRelative(at, NOW + 30 * M)).toBe('32m');
  });

  it('un orologio indietro non produce durate assurde', () => {
    expect(formatRelative(NOW + 5 * M, NOW)).toBe('now');
  });
});
