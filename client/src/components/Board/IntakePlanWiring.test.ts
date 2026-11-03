/**
 * The composer cannot be mounted under `bun test` (it imports the `@/` alias), so the wiring is
 * proved on its source: every entry point goes through `submit`, which defers to the open plan.
 * Turn the gate off in the composer and these go red.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const composer = readFileSync(join(here, 'FloatingTaskComposer.tsx'), 'utf8');
const panel = readFileSync(join(here, 'IntakePlanPanel.tsx'), 'utf8');

describe('composer wiring of the intake plan', () => {
  test('Enter and the send button both call submit', () => {
    expect(composer).toContain("e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }");
    expect(composer).toContain('onClick={submit}');
  });

  test('submit confirms the open plan before it can create a card', () => {
    const body = composer.slice(composer.indexOf('const submit = async'));
    const gate = body.indexOf('if (planRows) {');
    expect(gate).toBeGreaterThan(-1);
    expect(body.slice(gate, gate + 120)).toContain('confirmPlan()');
    expect(gate).toBeLessThan(body.indexOf('boardApi.create'));
  });

  test('the proposal opens only through submitAction, and cancel clears the rows', () => {
    expect(composer).toContain("submitAction(false, raw, attachments.length > 0, planProjects) === 'propose'");
    expect(composer).toMatch(/const cancelPlan = \(\) => \{ setPlanRows\(null\)/);
    expect(composer).toContain('onCancel={cancelPlan}');
  });

  test('moving a row re-applies the parent rule and the panel offers existing cards', () => {
    expect(composer).toContain('onChange={(next) => setPlanRows(followParents(next))}');
    expect(panel).toContain('intake-plan-relation');
    expect(composer).toContain('{ parentTaskId: newTaskId }');
  });
});
