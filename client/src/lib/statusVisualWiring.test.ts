/**
 * The status vocabulary is WIRED, not only declared: the surfaces that show
 * "waits for you", "at work" and "failed" read their colour from statusVisual,
 * so a surface that drifts back to rose or to the green of done fails here.
 *
 * @covers STATUS-VISUAL-01
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DISPATCH_CHIP } from '../components/Board/constants';
import { STATUS_CHIP, STATUS_ICON } from './statusVisual';

const source = (rel: string) => readFileSync(resolve(import.meta.dir, '..', rel), 'utf8');

describe('statusVisual wiring', () => {
  test('board dispatch chips use the status chips', () => {
    expect(DISPATCH_CHIP.needs_input.cls).toBe(STATUS_CHIP.wait);
    expect(DISPATCH_CHIP.needs_input.Icon).toBe(STATUS_ICON.wait);
    expect(DISPATCH_CHIP.working.cls).toBe(STATUS_CHIP.working);
    expect(DISPATCH_CHIP.failed.cls.startsWith(STATUS_CHIP.danger)).toBe(true);
    for (const key of ['needs_input', 'working', 'failed'] as const) {
      expect(DISPATCH_CHIP[key].cls).not.toContain('rose');
    }
  });

  test('agent surfaces paint "at work" with the working tone, never ok', () => {
    for (const file of ['components/Agents/AgentsPane.tsx', 'components/Sidebar/AgentLines.tsx', 'components/Sidebar/AgentsRow.tsx']) {
      const text = source(file);
      expect(text, file).not.toMatch(/STATUS_(INK|DOT)\.ok/);
      for (const m of text.matchAll(/working:\s*\{?[^,}]*?STATUS_(?:INK|DOT)\.(\w+)/g)) expect(m[1], file).toBe('working');
    }
  });

  test('failure chips on the board are red, not rose', () => {
    const card = source('components/Board/Card.tsx');
    const detail = source('components/Board/TaskDetail.tsx');
    for (const text of [card, detail]) {
      for (const line of text.split('\n').filter((l) => l.includes("board.task.stopped"))) {
        expect(line).toContain('STATUS_CHIP.danger');
      }
    }
    for (const line of card.split('\n').filter((l) => l.includes('card-action-error') || l.includes("'board.card.checksRed'"))) {
      expect(line).not.toContain('rose');
    }
  });
});
