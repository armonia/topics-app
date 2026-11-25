/**
 * THE DRAWER NOTES NAME THE BUTTONS THEY POINT AT, IN BOTH LANGUAGES.
 *
 * The line under «Approve» ("the code stays out of main") used to carry the
 * button names as typed text: the English copy cited the Italian labels, and
 * with red checks the real buttons read «approve anyway» / «land anyway» while
 * the line kept naming the plain ones. The line now interpolates the labels of
 * `reviewDecisionButtons`, the same function that draws the buttons.
 *
 * @covers REVIEW-BUTTONS-01
 */
import { describe, expect, test } from 'bun:test';
import IT from '../../lib/i18n-it';
import EN from '../../lib/i18n-en';
import { reviewDecisionButtons } from './taskActionWords';

type Dict = Record<string, string>;
const trFor = (dict: Dict) => (key: string, params?: Record<string, string | number>): string =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? `{${name}}`));

const KEY = 'board.task.approveLeavesBranchOut';
const withBranch = {
  status: 'review' as const, assignedTopicId: 'topic-1', checksState: null, deliveredBy: 'agent',
  deliveredReason: null, deliveryBranch: 'topics/x', deliveryCommit: 'abc', deliveryFilesChanged: 3, landingState: null,
};

/** What the drawer prints, built exactly the way TaskDetail builds it. */
function noteFor(dict: Dict, task: Parameters<typeof reviewDecisionButtons>[0]): string {
  const tr = trFor(dict);
  const buttons = reviewDecisionButtons(task, tr);
  return tr(KEY, { approve: buttons.accept.label, land: buttons.land?.label ?? '' });
}

describe.each([['it', IT as Dict], ['en', EN as Dict]])('approve-leaves-branch note (%s)', (_lang, dict) => {
  test('it names the labels of the real buttons, not hand-typed words', () => {
    const tr = trFor(dict);
    const buttons = reviewDecisionButtons(withBranch as never, tr);
    const note = noteFor(dict, withBranch as never);
    expect(note).toContain(`«${buttons.accept.label}»`);
    expect(note).toContain(`«${buttons.land!.label}»`);
    expect(note).not.toContain('{');
  });

  test('red checks rename the buttons and the note follows', () => {
    const red = { ...withBranch, checksState: 'fail' };
    const tr = trFor(dict);
    const buttons = reviewDecisionButtons(red as never, tr);
    expect(buttons.accept.label).not.toBe(reviewDecisionButtons(withBranch as never, tr).accept.label);
    expect(noteFor(dict, red as never)).toContain(`«${buttons.accept.label}»`);
  });
});

test('the English note does not cite the Italian button names', () => {
  const note = noteFor(EN as Dict, withBranch as never);
  expect(note).not.toContain('Approva');
  expect(note).not.toContain('Landa su main');
});
