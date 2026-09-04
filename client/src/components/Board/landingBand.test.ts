/**
 * `settled` DOES NOT MEAN "landed".  @covers LAND-05
 *
 * A landing ticket has two fields that must be read together: `phase` says
 * whether the round is over, `outcome` says how it ended. Neither surface read
 * `outcome`, so a REFUSED merge (dirty checkout, conflict, pruned branch) was
 * indistinguishable from a successful one on the card AND in the drawer: the
 * card stayed in review, identical, forever.
 */
import { describe, it, expect } from 'bun:test';
import { landingBand, landingPolls } from './landingBand';
import type { LandingTicket } from '../../lib/board';

const ticket = (over: Partial<LandingTicket> = {}): LandingTicket => ({
  taskId: 't1',
  phase: 'queued',
  ahead: 0,
  queuedAt: '2026-09-10T10:00:00.000Z',
  settledAt: null,
  error: null,
  outcome: null,
  reason: null,
  ...over,
});

describe('landingBand', () => {
  it('in coda dice quanti ne ha davanti, in corso non ha nessun numero', () => {
    expect(landingBand(ticket({ phase: 'queued', ahead: 2 }))).toEqual({ kind: 'queued', ahead: 2, detail: null });
    expect(landingBand(ticket({ phase: 'running', ahead: 0 }))).toEqual({ kind: 'running', ahead: 0, detail: null });
  });

  it('un land RESPINTO ha la sua banda, e porta il motivo', () => {
    // The case nothing showed: `phase: 'settled'` read alone looks like a
    // success. The card stays in review, so without this line the only sign is
    // that nothing happens.
    const b = landingBand(ticket({ phase: 'settled', outcome: 'unlanded', reason: 'il checkout è sporco' }));
    expect(b).toEqual({ kind: 'unlanded', ahead: 0, detail: 'il checkout è sporco' });
  });

  it('un merge non verificabile non si dà per atterrato', () => {
    expect(landingBand(ticket({ phase: 'settled', outcome: 'unverifiable' }))?.kind).toBe('unverifiable');
  });

  it('un land ANDATO non disegna niente: la card si chiude da sola', () => {
    for (const outcome of ['landed', 'nothing', 'skipped'] as const) {
      expect(landingBand(ticket({ phase: 'settled', outcome }))).toBeNull();
    }
    expect(landingBand(null)).toBeNull();
  });

  it('il fallito porta l\'errore, e senza errore la banda c\'è lo stesso', () => {
    expect(landingBand(ticket({ phase: 'failed', error: 'git esploso' })))
      .toEqual({ kind: 'failed', ahead: 0, detail: 'git esploso' });
    expect(landingBand(ticket({ phase: 'failed' }))?.detail).toBeNull();
  });

  it('si ripolla solo finché il giro è aperto', () => {
    expect(landingPolls(ticket({ phase: 'queued' }))).toBe(true);
    expect(landingPolls(ticket({ phase: 'running' }))).toBe(true);
    expect(landingPolls(ticket({ phase: 'settled', outcome: 'landed' }))).toBe(false);
    expect(landingPolls(ticket({ phase: 'failed' }))).toBe(false);
    expect(landingPolls(null)).toBe(false);
  });
});
