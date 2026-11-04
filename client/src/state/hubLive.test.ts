/**
 * @covers HUBBR-03
 *
 * The client keeps the hub's live data as the socket delivers it, seeds it
 * once from `/api/hub-live`, and never lets an older reading overwrite a newer
 * one (the seed can land after the first frame).
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { _adoptForTests, _everReadForTests, _readForTests, _resetForTests, _seedForTests } from './hubLive';

afterEach(() => {
  _resetForTests();
});

describe('HUBBR-03: hub live data in the client', () => {
  it('adopts a frame per topic', () => {
    _adoptForTests({ type: 'hub:live', topic: 'pace', data: [{ pct: 40 }], at: 10 });
    _adoptForTests({ type: 'hub:live', topic: 'mac', error: 'hub down', at: 11 });
    expect(_readForTests()).toEqual({ pace: { data: [{ pct: 40 }], at: 10 }, mac: { error: 'hub down', at: 11 } });
  });

  it('ignores other frames and unknown topics', () => {
    _adoptForTests({ type: 'provider:usage', topic: 'pace', data: 1, at: 1 });
    _adoptForTests({ type: 'hub:live', topic: 'board', data: 1, at: 1 });
    _adoptForTests({ type: 'hub:live', topic: 'pace', data: 1 });
    expect(_readForTests()).toEqual({});
  });

  it('an older reading never replaces a newer one', () => {
    _adoptForTests({ type: 'hub:live', topic: 'pace', data: 'new', at: 20 });
    _adoptForTests({ type: 'hub:live', topic: 'pace', data: 'old', at: 10 });
    expect(_readForTests().pace).toEqual({ data: 'new', at: 20 });
  });

  it('seeds from the snapshot endpoint', async () => {
    const asked: string[] = [];
    await _seedForTests(async (path) => {
      asked.push(path);
      return new Response(JSON.stringify({ services: { data: [{ label: 'x' }], at: 3 } }));
    });
    expect(asked).toEqual(['/api/hub-live']);
    expect(_readForTests()).toEqual({ services: { data: [{ label: 'x' }], at: 3 } });
  });

  it('a failed seed leaves the state empty instead of inventing one', async () => {
    await _seedForTests(async () => new Response('{}', { status: 503 }));
    await _seedForTests(async () => { throw new Error('offline'); });
    expect(_readForTests()).toEqual({});
  });

  it('knows the System topics too', () => {
    for (const topic of ['attesa', 'alerts', 'gates', 'automations']) {
      _adoptForTests({ type: 'hub:live', topic, data: { n: 1 }, at: 1 });
    }
    expect(Object.keys(_readForTests()).sort()).toEqual(['alerts', 'attesa', 'automations', 'gates']);
  });

  it('remembers that the hub was read once, even after it goes down', () => {
    expect(_everReadForTests()).toBe(false);
    _adoptForTests({ type: 'hub:live', topic: 'mac', error: 'hub down', at: 1 });
    expect(_everReadForTests()).toBe(false);
    _adoptForTests({ type: 'hub:live', topic: 'mac', data: { cpu: 1 }, at: 2 });
    _adoptForTests({ type: 'hub:live', topic: 'mac', error: 'hub down', at: 3 });
    expect(_everReadForTests()).toBe(true);
    expect(_readForTests().mac).toEqual({ error: 'hub down', at: 3 });
  });
});
