/**
 * The card surfaces draw their state with `StatusIcon` (data-testid
 * `status-glyph`), never with the four-dot `SparkLoader`, and the live glyph
 * spins only under motion-safe at one turn per 1.44 s in 12 steps.
 *
 * @covers STATUS-VISUAL-01j
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const C = join(import.meta.dir, '../components');
const read = (rel: string) => readFileSync(join(C, rel), 'utf8');

const CARD_SURFACES = [
  'Board/CardLive.tsx',
  'Board/PlanTileParts.tsx',
  'Board/SessionLiveRow.tsx',
  'Chat/BackgroundWorkLine.tsx',
  'Chat/SubAgentResultCard.tsx',
  'Chat/SubAgentsStrip.tsx',
];

describe('phase to glyph on the card surfaces', () => {
  for (const rel of CARD_SURFACES) {
    test(`${rel} has no SparkLoader and uses the live status glyph`, () => {
      const src = read(rel);
      expect(src).not.toContain('SparkLoader');
      expect(src).toMatch(/<StatusIcon status="in_progress" live /);
    });
  }

  test('the sidebar needs-you mark is the amber alert, not the spinner', () => {
    const src = read('Sidebar/TopicTree.tsx');
    expect(src).not.toMatch(/<SparkLoader state="waiting"/);
    expect(src).toContain('STATUS_ICON.wait');
  });

  test('the glyph exposes its status and spins motion-safe at the tray cadence', () => {
    const src = read('Board/atoms.tsx');
    expect(src).toContain('data-testid="status-glyph"');
    expect(src).toContain('data-status={status}');
    expect(src).toContain("'failed'");
    expect(src).toContain('motion-safe:animate-[status-glyph-spin_1.44s_steps(12)_infinite]');
  });
});
