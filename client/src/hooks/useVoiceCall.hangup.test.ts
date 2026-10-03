/**
 * HANGING UP MID-SENTENCE SENDS NOTHING.
 *
 * `endCall` stops the recorder, and the recorder's `onstop` runs AFTER it with
 * the chunks of the half sentence already collected (`start(250)` delivers one
 * every quarter second). It did not look at whether the call was still on:
 * the fragment was transcribed and sent to the agent after the hang-up. Driven
 * through the real hook; microphone, recorder and network are faked.
 *
 * @covers CHAT-01
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../test/reactHarness';
import { useVoiceCall } from './useSpeech';

const g = globalThis as unknown as Record<string, unknown>;
const KEYS = ['window', 'navigator', 'MediaRecorder', 'fetch'] as const;
const saved: Record<string, unknown> = {};
let harness: Harness | null = null;

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
    // As the browser does: the last chunk, then `stop`, both after the call.
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)], { type: 'audio/webm' }) });
      this.onstop?.();
    }, 0);
  }
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = g[k];
  g.window = {};
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
  });
  g.MediaRecorder = FakeRecorder;
  g.fetch = async () => new Response(JSON.stringify({ transcript: 'half a sentence' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
});

afterEach(() => {
  harness?.unmount();
  harness = null;
  for (const k of KEYS) {
    if (k === 'navigator') Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: saved[k] });
    else if (saved[k] === undefined) delete g[k]; else g[k] = saved[k];
  }
});

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

function drive() {
  const sent: string[] = [];
  let current: ReturnType<typeof useVoiceCall> | undefined;
  function Probe(): null {
    const call = useVoiceCall(async (c) => { sent.push(c); return true; }, [], false);
    React.useEffect(() => { current = call; });
    return null;
  }
  harness = mount(React.createElement(Probe));
  return { sent, api: () => current! };
}

describe('useVoiceCall · hanging up', () => {
  test('the half sentence recorded before «end» is not sent to the agent', async () => {
    const { sent, api } = drive();
    api().startCall();
    await settle();
    api().endCall();
    await settle();
    expect(sent).toEqual([]);
  });

  test('a turn closed while the call is on is still sent', async () => {
    const { sent, api } = drive();
    api().startCall();
    await settle();
    FakeRecorder.last!.stop();
    await settle();
    expect(sent).toEqual(['half a sentence']);
  });

  test('a transcription of the previous call is not sent into the next one', async () => {
    // The transcription answers only when released: the person hangs up while
    // it is in flight and calls again before it lands.
    let release: () => void = () => {};
    g.fetch = () => new Promise<Response>((resolve) => {
      release = () => resolve(new Response(JSON.stringify({ transcript: 'old half sentence' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    });
    const { sent, api } = drive();
    api().startCall();
    await settle();
    FakeRecorder.last!.stop();
    await settle();
    api().endCall();
    api().startCall();
    await settle();
    release();
    await settle();
    expect(sent).toEqual([]);
  });

  test('hanging up during the microphone prompt leaves the microphone off', async () => {
    // The permission prompt answers only when released: the person hangs up
    // while it is still open.
    let grant: () => void = () => {};
    let micStopped = false;
    const stream = { getTracks: () => [{ stop() { micStopped = true; } }] };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, writable: true,
      value: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = () => resolve(stream); }) } },
    });
    FakeRecorder.last = null;
    const { api } = drive();
    api().startCall();
    await settle();
    api().endCall();
    grant();
    await settle();
    expect(FakeRecorder.last).toBeNull();
    expect(micStopped).toBe(true);
  });
});
