/**
 * The three choices change the REAL limit and the choice survives a restart.
 * "Real limit" = `effectiveDispatchCap`, the function the dispatcher reads;
 * "restart" = the cap written to the settings row and read back by the
 * server's own reader (`readGlobalCap`), then mapped back to a choice.
 *
 * @covers AICTRL-05
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CAP_PRESETS, CAUTIOUS_CAP, PUSHED_CAP, gbLeftFor, presetOf, presetPatch } from './capPresets';
import { effectiveDispatchCap } from '../../lib/board';
import { readGlobalCap } from '../../../../server/services/dispatch-capacity';

const RECOMMENDED = 5;

/** What `setGlobalCap` writes for a patch, on the columns the reader reads. */
function writeAndReadBack(patch: { auto?: boolean; max?: number }) {
  const db = new Database(':memory:');
  db.run('CREATE TABLE board_settings (project_id TEXT PRIMARY KEY, max_agents INTEGER, max_agents_auto INTEGER, max_agents_mode TEXT, machine_budget_share REAL)');
  db.run("INSERT INTO board_settings (project_id, max_agents) VALUES ('*', 3)");
  if (patch.auto !== undefined) db.query("UPDATE board_settings SET max_agents_auto = ? WHERE project_id = '*'").run(patch.auto ? 1 : 0);
  if (patch.max !== undefined) db.query("UPDATE board_settings SET max_agents = ? WHERE project_id = '*'").run(patch.max);
  return readGlobalCap(db);
}

describe('cap presets', () => {
  test('each choice moves the limit the dispatcher uses', () => {
    const limit = (p: (typeof CAP_PRESETS)[number]) => effectiveDispatchCap(writeAndReadBack(presetPatch(p)), RECOMMENDED);
    expect(limit('cautious')).toBe(CAUTIOUS_CAP);
    expect(limit('balanced')).toBe(RECOMMENDED);
    expect(limit('pushed')).toBe(PUSHED_CAP);
    expect(CAUTIOUS_CAP).toBeLessThan(RECOMMENDED);
    expect(PUSHED_CAP).toBeGreaterThan(RECOMMENDED);
  });

  test('the choice survives the restart: stored cap maps back to the same choice', () => {
    for (const p of CAP_PRESETS) expect(presetOf(writeAndReadBack(presetPatch(p)))).toBe(p);
  });

  test('a number set by hand is no choice', () => {
    expect(presetOf(writeAndReadBack({ auto: false, max: 5 }))).toBeNull();
    expect(presetOf(null)).toBeNull();
  });

  test('the memory left to the apps shrinks as the limit grows', () => {
    expect(gbLeftFor(32, 1.5, 2)).toBe(29);
    expect(gbLeftFor(32, 1.5, 8)).toBe(20);
    expect(gbLeftFor(8, 3, 8)).toBe(0);
  });
});
