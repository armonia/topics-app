/**
 * The composer cannot be mounted under `bun test` (it imports the `@/` alias and there is no DOM), so the
 * decision behind Enter and the send button lives in `runIntakeSubmit` (behaviour tested in
 * `shared/intake-plan.test.ts`, counting creates; mutating its early returns turns that file red). Here the
 * composer is proved to route EVERY entry point through it.
 *
 * @covers KANBAN-105
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const composer = readFileSync(join(here, 'FloatingTaskComposer.tsx'), 'utf8');
const panel = readFileSync(join(here, 'IntakePlanPanel.tsx'), 'utf8');

describe('composer wiring of the intake plan', () => {
  test('Enter, the send button and the panel all go through submit, which calls submitIntake first', () => {
    expect(composer).toContain("e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }");
    expect(composer).toContain('onClick={() => { void submit(); }}');
    expect(composer).toContain('onConfirm={() => { void submit(); }}');
    const body = composer.slice(composer.indexOf('const submit = async'));
    expect(body).toContain('runIntakeSubmit(');
    // The one-card path is only a callback of runIntakeSubmit: the composer has no other door to boardApi.create besides the plan rows.
    expect(body).toContain('createSingle: async');
    expect(composer).not.toContain('confirmPlan');
  });

  test('a blocked proposal is reported and keeps the text; cancel clears only the rows', () => {
    expect(composer).toContain('onBlocked:');
    expect(composer).toMatch(/const cancelPlan = \(\) => \{ setPlanRows\(null\)/);
    expect(composer).toContain('onCancel={cancelPlan}');
    expect(composer).toContain('onSingle={() => { void submit(true); }}');
    expect(panel).toContain('intake-plan-single');
  });

  test('each card of a confirmed plan keeps the composer options and the link', () => {
    const row = composer.slice(composer.indexOf('const createPlanRow'), composer.indexOf('const adoptExisting'));
    for (const opt of ['stayLocal', 'model', 'topicsRouting', 'priority', 'intakeLink']) expect(row).toContain(opt);
  });

  test('moving a row re-applies the parent rule and the panel offers existing cards', () => {
    expect(composer).toContain('onChange={(next) => setPlanRows(followParents(next))}');
    expect(panel).toContain('intake-plan-relation');
    expect(composer).toContain('{ parentTaskId: newTaskId }');
  });
});
