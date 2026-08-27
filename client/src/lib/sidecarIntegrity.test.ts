/**
 * @covers UPDATER-02
 *
 * When the "incomplete install" warning shows up, and above all when it does NOT.
 *
 * One rule, and it is not symmetric: only a verdict that was actually verified
 * accuses anyone. A build with no fingerprints (dev, or the stub sidecars CI
 * creates for the existence gate) knows nothing, and whoever knows nothing keeps
 * quiet. A warning that fires on every `tauri dev` is ignored on the day it is
 * true.
 */
import { describe, it, expect } from 'bun:test';
import { shouldWarnAboutSidecars, type SidecarReport } from './sidecarIntegrity';

const report = (r: Partial<SidecarReport>): SidecarReport => ({
  ok: true, checked: true, bad: [], items: [], ...r,
});

describe('avviso di installazione incompleta', () => {
  it('tace quando non c\'e\' nessun guscio da interrogare', () => {
    expect(shouldWarnAboutSidecars(null)).toBe(false);
  });

  it('tace su una build che non ha impronte da confrontare', () => {
    expect(shouldWarnAboutSidecars(report({ checked: false, ok: false, bad: ['pty-bridge'] }))).toBe(false);
  });

  it('tace quando tutto corrisponde', () => {
    expect(shouldWarnAboutSidecars(report({ items: [{ name: 'pty-bridge', state: 'ok' }] }))).toBe(false);
  });

  it('parla per il caso del 27/08: app nuova, un binario della build precedente', () => {
    const r = report({ ok: false, bad: ['pty-bridge'], items: [{ name: 'pty-bridge', state: 'stale' }] });
    expect(shouldWarnAboutSidecars(r)).toBe(true);
  });
});
