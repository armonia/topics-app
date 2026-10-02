/**
 * THE BOOTSTRAP BURST MUST FIND THE IDLE TIMER ARMED.
 *
 * `registerDomSink` flushes the events buffered before the mount SYNCHRONOUSLY,
 * inside the call. The sink was registered before `noteActivityRef` and
 * `parkWhenHiddenRef` were assigned, so on first mount the whole initial stream
 * met two null refs: if the remote page then stayed still, nothing ever armed
 * the idle park and the live Replayer kept its rAF loop at ~60/s, the exact
 * cost the parking block exists to remove.
 *
 * WHY THIS READS THE SOURCE. The effect bails out without a real root element
 * (`rootRef.current`), and this project has no DOM library, so the mirror
 * cannot be mounted here. What is guarded is the order inside the effect.
 *
 * @covers BROWSER-COBROWSE-01
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, 'DomCoBrowse.tsx'), 'utf8');
const at = (needle: string) => {
  const i = SRC.indexOf(needle);
  expect(i).toBeGreaterThan(-1);
  return i;
};

describe('DomCoBrowse · order inside the live effect', () => {
  test('the sink is registered after the activity and park refs are set', () => {
    const register = at('registerDomSink(handle)');
    expect(register).toBeGreaterThan(at('noteActivityRef.current = noteActivity'));
    expect(register).toBeGreaterThan(at('parkWhenHiddenRef.current = sync'));
  });
});
