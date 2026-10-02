/**
 * /status: A FAILED POST OF THE OUTPUT REACHES THE ERROR LINE.
 *
 * `handleCommandStatus` called `addSystemMessage` without awaiting it, and
 * `addSystemMessage` did not return its promise. A network error on the POST
 * of the output therefore became an unhandled rejection: no output in the
 * chat and no error in `commandResult`.
 *
 * WHY THIS READS THE SOURCE. `ChatPanel` imports `ChatPane`, whose graph uses
 * the `@/` alias that `bun test` does not resolve, so the panel cannot be
 * mounted here (same limit as `Board/Card.test.ts`). What is guarded is the
 * wiring: the promise is returned and awaited inside the `try`.
 *
 * @covers CHAT-01
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, 'ChatPanel.tsx'), 'utf8');

function line(name: string): string {
  return SRC.split('\n').find((l) => l.includes(`const ${name} = useCallback(`)) ?? '';
}

describe('ChatPanel · /status output', () => {
  test('addSystemMessage hands its promise back', () => {
    // A block body with no `return` throws the promise away.
    expect(line('addSystemMessage')).toMatch(/useCallback\(\s*(async\s*)?\(content: string\)\s*=>\s*(apiFetch|\{\s*return)/);
  });

  test('handleCommandStatus awaits it inside the try', () => {
    expect(line('handleCommandStatus')).toMatch(/try \{[^}]*await addSystemMessage\(/);
  });
});
