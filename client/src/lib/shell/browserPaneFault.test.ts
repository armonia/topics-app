import { describe, it, expect } from 'bun:test';
import {
  NO_FAULT, FAULT_STREAK, STRUCTURAL_COMMANDS, recordPaneOk, recordPaneError, type FaultState,
} from './browserPaneFault';

/** Feed n failures of the same command through the reducer. */
function fail(times: number, command = 'browser_set_bounds', from: FaultState = NO_FAULT): FaultState {
  let s = from;
  for (let i = 0; i < times; i++) s = recordPaneError(s, command);
  return s;
}

describe('browserPaneFault', () => {
  it('one failure is not a broken pane', () => {
    // A command can race the pane's own teardown, or land between a deferred
    // close and the reopen that cancels it. Faulting on the first rejection
    // would put an error strip over a pane that is about to be fine.
    const s = fail(1);
    expect(s.faulted).toBe(false);
    expect(s.streak).toBe(1);
  });

  it('a streak is', () => {
    // A poisoned dispatcher mutex never recovers: it fails the next one too.
    const s = fail(FAULT_STREAK);
    expect(s.faulted).toBe(true);
    expect(s.streak).toBe(FAULT_STREAK);
  });

  it('names the command that tipped it over', () => {
    expect(fail(FAULT_STREAK, 'browser_navigate').command).toBe('browser_navigate');
  });

  it('a single success clears the streak', () => {
    expect(recordPaneOk(fail(FAULT_STREAK - 1))).toEqual(NO_FAULT);
  });

  it('a success clears the fault too — only a REPLACED view can answer again', () => {
    const broken = fail(FAULT_STREAK);
    expect(broken.faulted).toBe(true);
    expect(recordPaneOk(broken)).toEqual(NO_FAULT);
  });

  it('returns the SAME object when a success changes nothing', () => {
    // The hook compares by identity to avoid a setState per successful
    // set_bounds — and set_bounds fires on every frame of a drag.
    const s = recordPaneOk(NO_FAULT);
    expect(s).toBe(NO_FAULT);
  });

  it('non-structural failures neither accuse the pane nor absolve it', () => {
    // A page can hang on its own; a hung PAGE is not a broken pane.
    const half = fail(FAULT_STREAK - 1);
    const after = recordPaneError(half, 'browser_eval_js');
    expect(after).toBe(half);
    expect(after.faulted).toBe(false);
  });

  it('does not count the commands with a legitimate failure mode', () => {
    // eval/screenshot: a page can stall. animate_bounds: "this shell doesn't
    // have the command" is a capability answer. open/close: lifecycle, already
    // surfaced by the bounded-retry path at mount.
    for (const cmd of [
      'browser_eval_js', 'browser_exec_js', 'browser_screenshot',
      'browser_animate_bounds', 'browser_open', 'browser_close',
    ]) {
      expect(STRUCTURAL_COMMANDS.has(cmd)).toBe(false);
    }
  });

  it('counts the ones a poisoned dispatcher kills wholesale', () => {
    for (const cmd of [
      'browser_set_bounds', 'browser_navigate', 'browser_reload',
      'browser_back', 'browser_forward', 'browser_set_visible',
      'browser_set_user_agent', 'browser_go_to_index',
    ]) {
      expect(STRUCTURAL_COMMANDS.has(cmd)).toBe(true);
    }
  });

  it('the threshold is reachable by the command that fires most often', () => {
    // browser_set_bounds runs per frame during a drag, so the streak completes
    // in well under a second — no timer needed to tell permanent from transient.
    expect(STRUCTURAL_COMMANDS.has('browser_set_bounds')).toBe(true);
    expect(FAULT_STREAK).toBeGreaterThan(1);
  });
});
