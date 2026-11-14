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

  for (const rel of ['Sidebar/AgentsJobsLevel.tsx', 'Sidebar/AgentLines.tsx']) {
    test(`${rel} draws a live agent with the spinning glyph, not SparkLoader`, () => {
      const src = read(rel);
      expect(src).not.toContain('SparkLoader');
      expect(src).toMatch(/<StatusIcon status="in_progress" live /);
    });
  }

  test('a space waiting for you shows the amber alert, not the waiting spinner', () => {
    const src = read('Sidebar/SpaceGroups.tsx');
    expect(src).not.toContain('SparkLoader');
    expect(src).toContain('STATUS_ICON.wait');
  });

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

describe('the chat task card', () => {
  test('draws its phase with the glyph map, not spinner or lucide state icons', () => {
    const src = read('Chat/TaskToolCard.tsx');
    expect(src).not.toContain('SparkLoader');
    expect(src).not.toContain('Hourglass');
    expect(src).not.toContain('CircleCheck,');
    expect(src).toContain('<StatusIcon status={PHASE_GLYPH[phase]} live');
  });

  test('PHASE_GLYPH maps working to the spinning half pie and review to three quarters', async () => {
    const { PHASE_GLYPH } = await import('./taskCardState');
    expect(PHASE_GLYPH.working).toBe('in_progress');
    expect(PHASE_GLYPH.review).toBe('review');
    expect(PHASE_GLYPH.done).toBe('done');
    expect(PHASE_GLYPH.failed).toBe('failed');
  });

  test('the tray colours are the dark theme tokens', () => {
    const rs = readFileSync(join(import.meta.dir, '../../../desktop-tauri/src-tauri/src/tray_agents.rs'), 'utf8');
    expect(rs).toContain('SKY: [u8; 3] = [0, 188, 255]');
    expect(rs).toContain('ROSE: [u8; 3] = [255, 99, 126]');
    expect(rs).toContain('AMBER: [u8; 3] = [255, 185, 0]');
    expect(rs).toContain('MUTED: [u8; 3] = [141, 147, 155]');
  });
});
