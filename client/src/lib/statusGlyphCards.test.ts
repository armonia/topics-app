/**
 * The card surfaces draw an agent at work with the square loader (`SparkLoader`),
 * the one status icon of Topics; `StatusIcon` (data-testid `status-glyph`) stays
 * for the still categories and never spins.
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
  'Board/SessionLiveRow.tsx',
  'Chat/BackgroundWorkLine.tsx',
  'Chat/SubAgentResultCard.tsx',
  'Chat/SubAgentsStrip.tsx',
];

describe('phase to glyph on the card surfaces', () => {
  for (const rel of CARD_SURFACES) {
    test(`${rel} draws work in progress with the square loader`, () => {
      const src = read(rel);
      // The bare loader, or the one that plays the card's action (TaskActionLoader wraps SparkLoader).
      expect(src).toMatch(/<SparkLoader size=\{12\}|<TaskActionLoader taskId=\{\w+\} activity=\{activity\} size=\{12\}/);
      expect(src).not.toMatch(/<StatusIcon status="in_progress" live/);
    });
  }

  for (const rel of ['Sidebar/AgentsJobsLevel.tsx', 'Sidebar/AgentLines.tsx']) {
    test(`${rel} draws a live agent with the square loader`, () => {
      const src = read(rel);
      expect(src).toMatch(/<SparkLoader size=\{1[12]\} activity="tool"/);
      expect(src).not.toMatch(/<StatusIcon status="in_progress" live/);
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

  test('the glyph exposes its status and never spins', () => {
    const src = read('Board/atoms.tsx');
    expect(src).toContain('data-testid="status-glyph"');
    expect(src).toContain('data-status={status}');
    expect(src).toContain("'failed'");
    expect(src).not.toContain('status-glyph-spin');
    expect(src).not.toMatch(/live\??:\s*boolean/);
  });
});

describe('the chat task card', () => {
  test('draws its phase with the glyph map, the loader while working, no lucide state icons', () => {
    const src = read('Chat/TaskToolCard.tsx');
    expect(src).not.toContain('Hourglass');
    expect(src).not.toContain('CircleCheck,');
    expect(src).toContain("PHASE_GLYPH[phase] === 'in_progress' ? <TaskActionLoader taskId={detail.taskId} size={12}");
    expect(src).toContain('<StatusIcon status={PHASE_GLYPH[phase]} className="h-3 w-3" />');
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
