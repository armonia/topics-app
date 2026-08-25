/**
 * @covers APPSET-05
 */
// UI mapping for the Behaviour-defaults controls (env-var audit, Phase B).
import { describe, test, expect } from 'bun:test';
import { enabledToSelect, selectToEnabled } from './behaviorDefaults';

// Il selettore riporta AUTO come null (SettingSelect mappa la sua opzione '__auto__' su
// null before calling onChange); reproduce that here.
const fromSelect = (raw: string | null) => selectToEnabled(raw);

describe('claude-code enable tri-state ↔ select value', () => {
  test('null (Auto) round-trips', () => {
    expect(enabledToSelect(null)).toBeNull();
    expect(fromSelect(null)).toBeNull();
  });

  test('true ↔ "on"', () => {
    expect(enabledToSelect(true)).toBe('on');
    expect(fromSelect('on')).toBe(true);
  });

  test('false ↔ "off"', () => {
    expect(enabledToSelect(false)).toBe('off');
    expect(fromSelect('off')).toBe(false);
  });

  test('picking "Disabled" persists an explicit false (beats env=true)', () => {
    // User opens Auto, chooses Disabled → patch carries `false`, not null.
    expect(fromSelect('off')).toBe(false);
  });

  test('picking "Auto" clears the override (null, so env/default wins)', () => {
    expect(fromSelect(null)).toBeNull();
  });
});
