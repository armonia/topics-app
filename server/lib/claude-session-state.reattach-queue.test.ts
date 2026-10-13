/**
 * A notice the CLI queued while no server read the transcript leaves its task
 * in flight until its fate, as a live one does (MONITOR-04): the reattach's
 * catch-up reads the enqueue, and the task ends where the CLI delivers or lets
 * the notice go, or a minute after it was written with neither. Wherever that
 * end is read, it is of before the restart, and heals in silence.
 * @covers ATTN-03
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createClaudeSessionTracker } from './claude-session-tracker';
import { deriveTranscriptPath } from './claude-session-state';
import { resetAttentionStore, getAttention, countingTasks } from '../attention/store';
import { freshDb, turn, BASH_ABSORBED, ABSORBED_LINES, ABSORBED_AT, subjectOf, terminalTracker, durableAttention } from './claude-session-state.background-tasks.fixture';

// The store is a process singleton: leave it as the next file expects it.
afterAll(() => resetAttentionStore());

describe('a notice queued before the restart ends its task where the CLI settles it, in silence', () => {
  const { pushes, rows, reset, restart, boot } = durableAttention();
  beforeEach(reset);

  // Queued while no server read the file, its fate written after the reattach: the task ended before the restart, and
  // heals in silence wherever its fate is read (the CLI lets a notice go 3.9 s after its enqueue at the median).
  it('terminal: a notice queued before the restart and let go after it heals in silence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bg-reattach-let-go-'));
    try {
      const cwd = '/work/project';
      const { tracker, sid, subject } = terminalTracker([]);
      let t = ABSORBED_AT - 60_000;
      turn([BASH_ABSORBED]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
      const path = deriveTranscriptPath(home, cwd, sid);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ABSORBED_LINES[0] + '\n');
      restart();
      const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
      t = ABSORBED_AT + 1_000;
      const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home, now: () => t });
      after.registerTerminalSession(sid, { cwd, now: (t += 200) });
      await new Promise((r) => setTimeout(r, 150));
      expect(countingTasks(subject)).toBe(1);
      boot();
      const letGo = ABSORBED_LINES[1];
      appendFileSync(path, letGo + '\n');
      after.ingestTranscriptLine(sid, letGo, (t += 3_000));
      expect(countingTasks(subject)).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect({ epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length }).toEqual(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Never delivered nor let go (16 of about 1800): older than a minute at the reattach, the late read takes its task
  // out; younger, the reaper does a minute after it was written. In silence either way.
  for (const age of ['older than a minute', 'a second old'] as const) {
    it(`terminal: a notice queued before the restart, never delivered nor let go, ${age} at the reattach, heals in silence`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'bg-reattach-unanswered-'));
      try {
        const cwd = '/work/project';
        const { tracker, sid, subject } = terminalTracker([]);
        let t = ABSORBED_AT - 60_000;
        turn([BASH_ABSORBED]).forEach((h) => tracker.ingestHook({ ...h, session_id: sid } as never, (t += 200)));
        const path = deriveTranscriptPath(home, cwd, sid);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, ABSORBED_LINES[0] + '\n');
        restart();
        const before = { epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length };
        t = age === 'older than a minute' ? ABSORBED_AT + 60_000 : ABSORBED_AT + 1_000;
        const after = createClaudeSessionTracker({ db: freshDb(), broadcast: () => {}, coalesceWindowMs: 5, dedupWindowMs: 100, rateLimitPerSec: 50, attentionSubject: subjectOf, homeDir: home, now: () => t });
        after.registerTerminalSession(sid, { cwd, now: t });
        await new Promise((r) => setTimeout(r, 150));
        expect(countingTasks(subject)).toBe(age === 'older than a minute' ? 0 : 1);
        boot();
        after.reapOnce(ABSORBED_AT + 59_999);
        expect(countingTasks(subject)).toBe(age === 'older than a minute' ? 0 : 1);
        after.reapOnce(ABSORBED_AT + 60_000);
        expect(countingTasks(subject)).toBe(0);
        await new Promise((r) => setTimeout(r, 100));
        expect({ epoch: getAttention(subject).epoch, pushes: pushes.length, rows: rows.length }).toEqual(before);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
