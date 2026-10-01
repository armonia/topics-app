/**
 * WHICH CODE BLOCKS OF A REPLY CAN BE RUN, AND WHAT RUNS.
 *
 * Only the shell labels; for a console transcript only the lines with a
 * prompt, without it; a block with no label is never guessed at, because a
 * label that lies costs a `command not found` and a guess costs much more.
 * @covers CHAT-RUN-01
 */
import { describe, expect, test } from 'bun:test';
import { runnableCommand } from './runnableCommand';

describe('runnableCommand', () => {
  test('the four shell labels run the whole block, without the final newline', () => {
    for (const lang of ['bash', 'sh', 'zsh', 'shell']) {
      expect(runnableCommand(lang, 'cd app\nbun test\n')).toBe('cd app\nbun test');
    }
  });

  test('the label is read case-insensitively', () => {
    expect(runnableCommand('Bash', 'ls')).toBe('ls');
  });

  test('console and shellsession run only the prompted lines, without the prompt', () => {
    expect(runnableCommand('console', '$ git status\nOn branch main\n$ ls')).toBe('git status\nls');
    expect(runnableCommand('shellsession', '% brew update\nAlready up-to-date.\n')).toBe('brew update');
  });

  test('a console transcript with no prompt has nothing to run', () => {
    expect(runnableCommand('console', 'On branch main\nnothing to commit')).toBeNull();
  });

  test('no label, another language, or an empty block: nothing to run', () => {
    expect(runnableCommand('', 'sudo wg-quick up edm')).toBeNull();
    expect(runnableCommand('python', 'print(1)')).toBeNull();
    expect(runnableCommand('powershell', 'Get-ChildItem')).toBeNull();
    expect(runnableCommand('bash', '\n  \n')).toBeNull();
  });
});
