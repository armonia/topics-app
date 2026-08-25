/**
 * Whether the composer may offer the Fast Mode toggle at all, and the sentence
 * that explains a blocking reason.
 *
 * @covers FAST-MODE-01
 */
import { describe, it, expect } from 'bun:test';
import { fastModeUi, fastModeReasonText } from './fastMode';
import type { ProvidersSnapshot } from '../types';

const snap = (
  entries: Array<{ name: string; fastMode?: { state: 'off' | 'on' | 'cooldown'; reason: string | null; costMultiplier: number | null } }>,
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
  it('non servibile → il bottone NON esiste', () => {
    // È il caso reale di oggi: le chat girano sulla via Agent SDK. Un comando
    // spento che occupa spazio e non si può usare è peggio di uno assente.
    expect(fastModeUi({
      snapshot: snap([{ name: 'claude-code', fastMode: { state: 'off', reason: 'sdk_opt_in_required', costMultiplier: 2 } }]),
      requested: true,
    })).toBeNull();
  });

  it('libera → il bottone segue quello che l\'utente ha chiesto', () => {
    const free = snap([{ name: 'claude-code', fastMode: { state: 'off', reason: null, costMultiplier: 2 } }]);
    expect(fastModeUi({ snapshot: free, requested: false })).toMatchObject({ pressed: false, costMultiplier: 2 });
    expect(fastModeUi({ snapshot: free, requested: true })).toMatchObject({ pressed: true, costMultiplier: 2 });
  });

  it('il prezzo sta anche nel tooltip, non solo nel badge', () => {
    const ui = fastModeUi({
      snapshot: snap([{ name: 'claude-code', fastMode: { state: 'off', reason: null, costMultiplier: 2 } }]),
      requested: false,
    })!;
    expect(ui.title).toContain('2×');
  });

  it('cooldown = accesa ma in pausa, e lo dice', () => {
    const ui = fastModeUi({
      snapshot: snap([{ name: 'claude-code', fastMode: { state: 'cooldown', reason: null, costMultiplier: 2 } }]),
      requested: false,
    })!;
    expect(ui.pressed).toBe(true);
    expect(ui.title).toContain('pausa');
  });

  it('«non lo so» NON fa sparire il bottone (ma non inventa un prezzo)', () => {
    // Nessuna sessione ha ancora parlato, o un provider che non ha il concetto.
    const ui = fastModeUi({ snapshot: snap([{ name: 'claude-code' }]), requested: false });
    expect(ui).not.toBeNull();
    expect(ui!.costMultiplier).toBeNull();
    expect(fastModeUi({ snapshot: null, requested: false })).not.toBeNull();
  });

  it('un modello fissato fuori da Opus non ha fast mode: niente numero', () => {
    const s = snap([{ name: 'claude-code', fastMode: { state: 'off', reason: null, costMultiplier: 2 } }]);
    expect(fastModeUi({ snapshot: s, requested: false, providerOverride: { provider: 'claude-code', model: 'claude-sonnet-5' } })!.costMultiplier).toBeNull();
    expect(fastModeUi({ snapshot: s, requested: false, providerOverride: { provider: 'claude-code', model: 'claude-opus-5[1m]' } })!.costMultiplier).toBe(2);
  });

  it('legge la riga del provider che serve QUESTA chat', () => {
    const s = snap([
      { name: 'claude-code', fastMode: { state: 'off', reason: 'sdk_opt_in_required', costMultiplier: 2 } },
      { name: 'codex', fastMode: { state: 'off', reason: null, costMultiplier: null } },
    ]);
    expect(fastModeUi({ snapshot: s, requested: false })).toBeNull();
    expect(fastModeUi({
      snapshot: s, requested: false,
      providerOverride: { provider: 'codex', model: 'gpt-5.5' },
    })).not.toBeNull();
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
