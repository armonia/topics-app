import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createExternalSessionScanner,
  encodeClaudeCwd,
  readTranscriptMeta,
  type ExternalSessionScanner,
} from './external-session-scanner';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ext-scan-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a fake transcript for `cwd` and set its mtime. */
function seedTranscript(opts: {
  cwd: string;
  csid: string;
  ageMs?: number;
  sidechain?: boolean;
  title?: string;
  lines?: string[];
  now?: number;
}): string {
  const dir = join(root, encodeClaudeCwd(opts.cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${opts.csid}.jsonl`);
  const lines = opts.lines ?? [
    ...(opts.title ? [JSON.stringify({ type: 'ai-title', aiTitle: opts.title, sessionId: opts.csid })] : []),
    JSON.stringify({ type: 'user', cwd: opts.cwd, isSidechain: opts.sidechain ?? false, sessionId: opts.csid }),
    JSON.stringify({ type: 'assistant', cwd: opts.cwd, isSidechain: opts.sidechain ?? false, sessionId: opts.csid }),
  ];
  writeFileSync(path, lines.join('\n') + '\n');
  const mtime = new Date((opts.now ?? Date.now()) - (opts.ageMs ?? 0));
  utimesSync(path, mtime, mtime);
  return path;
}

function scanner(over: Partial<Parameters<typeof createExternalSessionScanner>[0]> = {}): {
  s: ExternalSessionScanner;
  broadcasts: object[];
} {
  const broadcasts: object[] = [];
  const s = createExternalSessionScanner({
    projectsRoot: root,
    knownSessionIds: () => new Set(),
    broadcast: (m) => broadcasts.push(m),
    ...over,
  });
  return { s, broadcasts };
}

describe('external-session-scanner', () => {
  it('detects a fresh bare-terminal session with cwd, title and activity', () => {
    seedTranscript({ cwd: '/Users/x/Projects/dancerooms', csid: 'aaa-111', title: 'Fix login', ageMs: 10_000 });
    const { s } = scanner();
    const found = s.scanOnce();
    expect(found.length).toBe(1);
    expect(found[0].claudeSessionId).toBe('aaa-111');
    expect(found[0].cwd).toBe('/Users/x/Projects/dancerooms');
    expect(found[0].title).toBe('Fix login');
    expect(Date.now() - found[0].lastActivityAt).toBeGreaterThan(5_000);
  });

  it('ignores transcripts older than the live window', () => {
    seedTranscript({ cwd: '/Users/x/Projects/old', csid: 'old-1', ageMs: 10 * 60_000 });
    const { s } = scanner({ liveWindowMs: 5 * 60_000 });
    expect(s.scanOnce().length).toBe(0);
  });

  it('excludes sessions Topics already tracks (csid match)', () => {
    seedTranscript({ cwd: '/Users/x/Projects/p', csid: 'known-1' });
    seedTranscript({ cwd: '/Users/x/Projects/p', csid: 'unknown-2' });
    const { s } = scanner({ knownSessionIds: () => new Set(['known-1']) });
    const found = s.scanOnce();
    expect(found.map((f) => f.claudeSessionId)).toEqual(['unknown-2']);
  });

  it('excludes sidechain transcripts (Task-tool sub-agents)', () => {
    seedTranscript({ cwd: '/Users/x/Projects/p', csid: 'side-1', sidechain: true });
    const { s } = scanner();
    expect(s.scanOnce().length).toBe(0);
  });

  it('excludes cwds under ignored roots (worktrees, tmp scratchpads)', () => {
    seedTranscript({ cwd: '/Users/x/.topics/worktrees/app/abc', csid: 'wt-1' });
    seedTranscript({ cwd: '/Users/x/Projects/p', csid: 'ok-1' });
    const { s } = scanner({ ignoredCwdRoots: ['/Users/x/.topics/worktrees'] });
    const found = s.scanOnce();
    expect(found.map((f) => f.claudeSessionId)).toEqual(['ok-1']);
  });

  it('finds the cwd from the TAIL when early lines are giant snapshots', () => {
    const cwd = '/Users/x/Projects/bigsnap';
    const giant = JSON.stringify({ type: 'file-history-snapshot', snapshot: 'x'.repeat(200 * 1024) });
    seedTranscript({
      cwd, csid: 'tail-1',
      lines: [giant, JSON.stringify({ type: 'user', cwd, isSidechain: false })],
    });
    const { s } = scanner();
    const found = s.scanOnce();
    expect(found.length).toBe(1);
    expect(found[0].cwd).toBe(cwd);
  });

  it('busyInfo matches by cwd nesting and falls back to the encoded dirName', () => {
    seedTranscript({ cwd: '/Users/x/Projects/repo/sub', csid: 'b-1' });
    // No parsable cwd → dirName fallback only.
    const dir = join(root, encodeClaudeCwd('/Users/x/Projects/blind'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'b-2.jsonl'), 'not-json\n');
    const { s } = scanner();
    s.scanOnce();
    expect(s.busyInfo('/Users/x/Projects/repo')?.count).toBe(1);      // session cwd nested in repo
    expect(s.busyInfo('/Users/x/Projects/repo/sub/deep')?.count).toBe(1); // repo path nested in session cwd
    expect(s.busyInfo('/Users/x/Projects/blind')?.count).toBe(1);     // encoded-dir fallback
    expect(s.busyInfo('/Users/x/Projects/other')).toBeNull();
  });

  it('broadcasts on change, stays quiet when nothing moved', () => {
    seedTranscript({ cwd: '/Users/x/Projects/p', csid: 'w-1' });
    const { s, broadcasts } = scanner();
    s.scanOnce();
    expect(broadcasts.length).toBe(1);
    expect((broadcasts[0] as { type: string }).type).toBe('external-sessions:state');
    s.scanOnce(); // same snapshot → no second frame
    expect(broadcasts.length).toBe(1);
  });

  it('readTranscriptMeta reads title from head and cwd/sidechain from tail', () => {
    const path = seedTranscript({
      cwd: '/Users/x/Projects/meta', csid: 'm-1', title: 'Titolo bello',
    });
    const meta = readTranscriptMeta(path, Bun.file(path).size);
    expect(meta.title).toBe('Titolo bello');
    expect(meta.cwd).toBe('/Users/x/Projects/meta');
    expect(meta.sidechain).toBe(false);
  });
});
