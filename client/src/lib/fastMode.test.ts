import { describe, it, expect } from 'bun:test';
import { fastModeUi, fastModeReasonText } from './fastMode';
import type { ProvidersSnapshot } from '../types';

const snap = (
  entries: Array<{ name: string; fastMode?: { state: 'off' | 'on' | 'cooldown'; reason: string | null } }>,
  defaultProvider = 'claude-code',
): ProvidersSnapshot => ({
  providers: entries.map((e) => ({
    name: e.name,
    status: 'ready' as const,
    isDefault: e.name === defaultProvider,
    models: [],
    requirements: [],
    fetchedAt: '2026-08-07T00:00:00.000Z',
    fastMode: e.fastMode,
  })),
  defaultProvider,
  generatedAt: '2026-08-07T00:00:00.000Z',
});

describe('fastModeUi', () => {
  it('bloccata → spento, e il tooltip DICE perché', () => {
    // È il caso reale di oggi: le chat girano sulla via Agent SDK.
    const ui = fastModeUi({
      snapshot: snap([{ name: 'claude-code', fastMode: { state: 'off', reason: 'sdk_opt_in_required' } }]),
      requested: true,
    });
    expect(ui.available).toBe(false);
    // Chiesta dall'utente, ma NON disegnata accesa: sarebbe una bugia.
    expect(ui.pressed).toBe(false);
    expect(ui.title).toContain('Agent SDK');
  });

  it('libera → il bottone segue quello che l\'utente ha chiesto', () => {
    const free = snap([{ name: 'claude-code', fastMode: { state: 'off', reason: null } }]);
    expect(fastModeUi({ snapshot: free, requested: false })).toMatchObject({ available: true, pressed: false });
    expect(fastModeUi({ snapshot: free, requested: true })).toMatchObject({ available: true, pressed: true });
  });

  it('cooldown = accesa ma in pausa, e lo dice', () => {
    const ui = fastModeUi({
      snapshot: snap([{ name: 'claude-code', fastMode: { state: 'cooldown', reason: null } }]),
      requested: false,
    });
    expect(ui.available).toBe(true);
    expect(ui.pressed).toBe(true);
    expect(ui.title).toContain('pausa');
  });

  it('«non lo so» NON spegne il bottone', () => {
    // Nessuna sessione ha ancora parlato, o un provider che non ha il concetto.
    expect(fastModeUi({ snapshot: snap([{ name: 'claude-code' }]), requested: false }).available).toBe(true);
    expect(fastModeUi({ snapshot: null, requested: false }).available).toBe(true);
  });

  it('legge la riga del provider che serve QUESTA chat', () => {
    const s = snap([
      { name: 'claude-code', fastMode: { state: 'off', reason: 'sdk_opt_in_required' } },
      { name: 'codex', fastMode: { state: 'off', reason: null } },
    ]);
    expect(fastModeUi({ snapshot: s, requested: false }).available).toBe(false);
    expect(fastModeUi({
      snapshot: s, requested: false,
      providerOverride: { provider: 'codex', model: 'gpt-5.5' },
    }).available).toBe(true);
  });
});

describe('fastModeReasonText', () => {
  it('ogni motivo della CLI ha la sua frase, non un generico', () => {
    for (const r of [
      'sdk_opt_in_required', 'not_first_party', 'model_not_allowed', 'disabled_by_env',
      'extra_usage_disabled', 'free', 'preference', 'network_error', 'pending',
    ]) {
      expect(fastModeReasonText(r)).not.toBe(fastModeReasonText('unknown'));
    }
  });

  it('un motivo nuovo non lascia il tooltip vuoto', () => {
    expect(fastModeReasonText('motivo-che-non-esiste-ancora')).toBe(fastModeReasonText('unknown'));
  });
});
