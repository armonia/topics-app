/**
 * The rows of a command's card (CMDUI-04): `/status`'s report as label and
 * value, without the session's internal key.
 *
 * @covers CMDUI-04
 */
import { describe, expect, test } from 'bun:test';
import { reportRows, statusRows } from './commandAnswer';

describe('statusRows', () => {
  test('label and value per line; the internal session key is left out', () => {
    const report = 'Modello: opus (fissato su questo topic)\nEffort: high\nAutonomia: ask. Non tocca file\nSessione: topic:abc123';
    expect(statusRows(report)).toEqual([
      { label: 'Modello', value: 'opus (fissato su questo topic)' },
      { label: 'Effort', value: 'high' },
      { label: 'Autonomia', value: 'ask. Non tocca file' },
    ]);
  });

  test('a line without a label is kept whole', () => {
    expect(reportRows('Progetti nello spazio di lavoro:\n  - a\n')).toEqual([
      { label: '', value: 'Progetti nello spazio di lavoro:' },
      { label: '', value: '- a' },
    ]);
  });
});
