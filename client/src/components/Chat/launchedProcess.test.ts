/**
 * The process a `run_command` / `run_script` answer started, which the card
 * shows the live log of.
 *
 * @covers SUBSTRIP-02
 */
import { describe, expect, test } from 'bun:test';
import { launchedProcessId } from './launchedProcess';

const PID = 'd99716b5-d372-4e82-be4b-5f5a565ff315';

const answer = (pid: string) => `started · processId=${pid} · pid=4242 · this topic gets a message with the outcome when it ends, so you can end your turn`;

describe('launchedProcessId', () => {
  test('reads the process a run_command or run_script answer started', () => {
    expect(launchedProcessId(answer(PID))).toBe(PID);
    expect(launchedProcessId(`started · processId=${PID} · pid=1 — read output with read_process_output(process_id="${PID}")`)).toBe(PID);
  });

  test('an answer that started nothing names nothing', () => {
    expect(launchedProcessId(undefined)).toBeNull();
    expect(launchedProcessId('')).toBeNull();
    expect(launchedProcessId('run_command: server did not return a processId')).toBeNull();
  });
});
