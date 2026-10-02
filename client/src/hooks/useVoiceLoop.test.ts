/**
 * VOICE TURNED OFF WHILE THE MIC LISTENS: THE REPLY IS NOT ACTED ON.
 *
 * The loop checked the mode only at the top of each round. A turn already in
 * `recordUtterance` when the voice went `off` came back with whatever the room
 * said, and that transcript was classified and sent to the task as an approve
 * or an answer. Driven through the real hook; TTS, microphone, recorder and
 * network are faked.
 *
 * @covers VOICE-LOOP-01
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../test/reactHarness';
import { useVoiceLoop, type VoiceLoopMode } from './useVoiceLoop';
import type { WSMessage } from '../types';

const g = globalThis as unknown as Record<string, unknown>;
const KEYS = ['window', 'navigator', 'MediaRecorder', 'fetch'] as const;
const saved: Record<string, unknown> = {};
let harness: Harness | null = null;
let calls: string[] = [];

class FakeRecorder {
  static isTypeSupported() { return true; }
  static last: FakeRecorder | null = null;
  constructor() { FakeRecorder.last = this; }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)], { type: 'audio/webm' }) });
      this.onstop?.();
    }, 0);
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
  calls = [];
  FakeRecorder.last = null;
  for (const k of KEYS) saved[k] = g[k];
  // No `speechSynthesis`: the TTS fallback resolves at once.
  g.window = { dispatchEvent: () => true };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
  });
  g.MediaRecorder = FakeRecorder;
  g.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/api/tts')) return json({ error: 'off' }, 500);
    if (url.includes('/api/stt')) return json({ transcript: 'yes go ahead' });
    if (url.includes('/api/voice/intent')) return json({ intent: 'approve', source: 'keyword' });
    return json({ projectId: 'p1' });
  };
});

afterEach(() => {
  harness?.unmount();
  harness = null;
  for (const k of KEYS) {
    if (k === 'navigator') Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: saved[k] });
    else if (saved[k] === undefined) delete g[k]; else g[k] = saved[k];
  }
});

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

async function announceAndListen() {
  const state = { mode: 'always' as VoiceLoopMode };
  let handler: ((msg: WSMessage) => void) | null = null;
  const onWSMessage = (h: (msg: WSMessage) => void) => { handler = h; return () => { handler = null; }; };
  function Probe(): null {
    useVoiceLoop({ onWSMessage, mode: state.mode });
    return null;
  }
  harness = mount(React.createElement(Probe));
  handler!({ type: 'task:review-ready', taskId: 't1', projectId: 'p1', taskTitle: 'Fix' } as WSMessage);
  await settle();
  // The announcement is over and the mic is listening.
  expect(FakeRecorder.last?.state).toBe('recording');
  return state;
}

const afterTheTurn = () => calls.filter((u) => !u.includes('/api/tts') && !u.includes('/api/stt'));

describe('useVoiceLoop · switched off mid-turn', () => {
  test('the reply heard after «off» is neither classified nor sent to the task', async () => {
    const state = await announceAndListen();
    state.mode = 'off';
    harness!.rerender();
    FakeRecorder.last!.stop(); // the room speaks, the VAD closes the turn
    await settle();
    expect(afterTheTurn()).toEqual([]);
  });

  test('with the voice still on, the same reply reaches the task', async () => {
    await announceAndListen();
    FakeRecorder.last!.stop();
    await settle();
    expect(afterTheTurn()).toContain('/api/voice/intent');
    expect(afterTheTurn().length).toBeGreaterThan(1);
  });
});
