/**
 * A rollback button that refuses OUT LOUD.
 *
 * The route answers with codes; the person reads a sentence in their own
 * language, never the code. These tests hold the decision that the timeline
 * renders: when the button is disabled, what its title says, what the dialog
 * promises. The catalogue is the real one, in Italian (the fallback locale,
 * always loaded), so a missing key would surface here as the key itself.
 *
 * The rendered half (the `disabled` and `title` attributes on the hovered
 * entry) is proven by the e2e spec `chat-checkpoints.spec.ts`, which is the
 * only bench in this repository with a DOM to hover in.
 *
 * @covers CHAT-05
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '../../lib/i18n';
import type { Checkpoint } from '../../../../shared/types';
import type { RestorePlan } from '../../../../shared/checkpoint-plan';
import {
  BLOCKER_KEY,
  ROLLBACK_TITLE_KEY,
  SKIPPED_SHOWN,
  rollbackButtonState,
  rollbackDialogText,
  type CheckpointPreflight,
} from './checkpointPlan';

const tr = (key: string, vars?: Record<string, string | number>) => t(key, 'it', vars);
const checkpoint: Checkpoint = { idx: 1, messageCount: 12, timestamp: '2026-09-05T10:00:00Z', description: 'Auth done', treeCommit: 'abc' };
const safePlan: RestorePlan = { targetCommit: 'abc', latestCommit: 'def', entries: [], skipped: [], blockers: [], safe: true };

function preflight(over: Partial<CheckpointPreflight>): CheckpointPreflight {
  return { checkpoint, plan: safePlan, canProceed: true, filesRestorable: true, ...over };
}

describe('the rollback button', () => {
  test('is disabled with the reason as its title when the route says the gesture stops', () => {
    const p = preflight({
      plan: { ...safePlan, blockers: [{ code: 'turn-in-progress' }], safe: false },
      canProceed: false, blockedBy: 'turn-in-progress', filesRestorable: false,
    });
    const state = rollbackButtonState(p, tr);
    expect(state.disabled).toBe(true);
    expect(state.title).toBe(tr('checkpoint.blocked.turnInProgress'));
    expect(state.title, 'the code must never reach the screen').not.toContain('turn-in-progress');
    expect(state.title, 'the key must never reach the screen either').not.toContain('checkpoint.blocked');
  });

  test('STAYS enabled on a legacy checkpoint: the conversation half is still a gesture', () => {
    const p = preflight({
      plan: { ...safePlan, blockers: [{ code: 'legacy-checkpoint' }], safe: false },
      canProceed: true, blockedBy: 'legacy-checkpoint', filesRestorable: false,
    });
    const state = rollbackButtonState(p, tr);
    expect(state.disabled).toBe(false);
    expect(state.title).toBe(tr('checkpoint.blocked.legacy'));
  });

  test('stays enabled while the preflight is missing: an aid, not a lock', () => {
    expect(rollbackButtonState(null, tr)).toEqual({ disabled: false, title: tr(ROLLBACK_TITLE_KEY) });
  });

  test('every blocker code has a sentence in both catalogues', () => {
    const en = readFileSync(join(import.meta.dir, '..', '..', 'lib', 'i18n-en.ts'), 'utf8');
    const it = readFileSync(join(import.meta.dir, '..', '..', 'lib', 'i18n-it.ts'), 'utf8');
    for (const key of Object.values(BLOCKER_KEY)) {
      expect(en, `${key} missing in English`).toContain(`'${key}'`);
      expect(it, `${key} missing in Italian`).toContain(`'${key}'`);
      expect(tr(key), `${key} has no Italian text`).not.toBe(key);
    }
  });
});

describe('the confirm dialog', () => {
  test('counts what comes back and what is deleted, and never promises a hash', () => {
    const p = preflight({
      plan: {
        ...safePlan,
        entries: [
          { path: 'a.txt', state: 'modified' },
          { path: 'gone.txt', state: 'deleted' },
          { path: 'src/new.ts', state: 'added' },
        ],
      },
    });
    const text = rollbackDialogText(checkpoint, p, tr);
    expect(text.lines).toEqual([
      tr('checkpoint.plan.conversation', { n: 12 }),
      tr('checkpoint.plan.restored', { n: 2 }),
      tr('checkpoint.plan.removed', { n: 1 }),
    ]);
    expect(text.lines.join('\n')).not.toContain('abc');
    expect(text.skippedPaths).toEqual([]);
    expect(text.more).toBeNull();
  });

  test('names the paths somebody else changed, up to the cap, then folds the rest', () => {
    const skipped = Array.from({ length: SKIPPED_SHOWN + 3 }, (_, i) => ({
      path: `lib/file-${i}.ts`, state: 'modified' as const, reason: 'changed-after-checkpoint' as const,
    }));
    const text = rollbackDialogText(checkpoint, preflight({ plan: { ...safePlan, skipped } }), tr);
    expect(text.lines).toContain(tr('checkpoint.plan.skipped', { n: SKIPPED_SHOWN + 3 }));
    expect(text.skippedPaths).toEqual(skipped.slice(0, SKIPPED_SHOWN).map((e) => e.path));
    expect(text.more).toBe(tr('checkpoint.plan.more', { n: 3 }));
  });

  test('on a legacy checkpoint it says in one line that the files stay', () => {
    const p = preflight({
      plan: { ...safePlan, blockers: [{ code: 'legacy-checkpoint' }], safe: false },
      canProceed: true, blockedBy: 'legacy-checkpoint', filesRestorable: false,
    });
    expect(rollbackDialogText(checkpoint, p, tr).lines).toEqual([
      tr('checkpoint.plan.conversation', { n: 12 }),
      tr('checkpoint.blocked.legacy'),
    ]);
  });

  test('without a preflight it says the plan is unknown instead of inventing one', () => {
    expect(rollbackDialogText(checkpoint, null, tr).lines[1]).toBe(tr('checkpoint.plan.unknown'));
  });
});

describe('the timeline wires the decision, not a copy of it', () => {
  // The two functions above are only worth something if the component uses
  // them for the attributes the e2e hovers on. A static read of the source
  // is the cheapest proof that it does; the hover itself is e2e territory.
  const src = readFileSync(join(import.meta.dir, 'CheckpointTimeline.tsx'), 'utf8');
  test('the button takes disabled and title from rollbackButtonState', () => {
    expect(src).toContain('rollbackButtonState(');
    expect(src).toMatch(/disabled=\{rollingBack \|\| \w+\.disabled\}/);
    expect(src).toMatch(/title=\{\w+\.title\}/);
  });
  test('the dialog is built from rollbackDialogText and no longer promises a checkout', () => {
    expect(src).toContain('rollbackDialogText(');
    expect(src).not.toContain('checked out');
  });
  test('the reason is rendered inline when disabled, from the same decision', () => {
    // A tooltip is invisible in a screenshot and on a phone. The component
    // shows `button.title` as text when `button.disabled`, and does not
    // decide the words a second time.
    expect(src).toMatch(/\{hoveredIdx === cp\.idx && button\.disabled && \(/);
    expect(src).toContain('data-testid="checkpoint-blocked-reason"');
    expect(src).toMatch(/data-testid="checkpoint-blocked-reason"[^>]*>\s*\{button\.title\}/);
  });
  test('hovering an entry asks for the plan', () => {
    expect(src).toMatch(/onMouseEnter=\{\(\) => \{[^}]*fetchPlan\(cp\.idx\)/);
  });
});
