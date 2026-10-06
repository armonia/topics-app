/** @covers MUSE-02 */
import { expect, test } from 'bun:test';
import { buildMuseArgs, buildMuseSingleShotArgs } from './args';

test('a chat turn is `exec --json` with session, workspace and prompt file', () => {
  const args = buildMuseArgs({
    sessionId: 'sid-123',
    workspace: '/tmp/ws',
    promptFile: '/tmp/p/prompt.md',
  });
  expect(args.slice(0, 2)).toEqual(['exec', '--json']);
  expect(args).toContain('--disable-reminders');
  expect(args).toContain('--user-input-auto-resolve');
  expect(args).toContain('--session-id');
  expect(args).toContain('sid-123');
  expect(args).toContain('--workspace');
  expect(args).toContain('/tmp/ws');
  // The prompt travels by file: `muse exec` does not read stdin for it, and a
  // 20-turn transcript exceeds the per-argv ceiling.
  expect(args.slice(-2)).toEqual(['--prompt-file', '/tmp/p/prompt.md']);
});

test('resume and fresh turns share the same argv shape: only the session id changes', () => {
  const fresh = buildMuseArgs({ sessionId: 'fresh-sid', promptFile: '/tmp/p/prompt.md' });
  const resume = buildMuseArgs({ sessionId: 'stored-sid', promptFile: '/tmp/p/prompt.md' });
  // Unlike codex (`exec` vs `exec resume <thread>`), muse has no resume
  // subcommand: the same `exec --session-id` both creates and resumes.
  expect(fresh.filter((a) => a !== 'fresh-sid')).toEqual(resume.filter((a) => a !== 'stored-sid'));
});

test('--model is passed only when explicit, and the effort only when resolved', () => {
  const bare = buildMuseArgs({ sessionId: 's', promptFile: '/tmp/p/prompt.md' });
  expect(bare).not.toContain('--model');
  expect(bare).not.toContain('--reasoning-effort');
  const full = buildMuseArgs({
    sessionId: 's',
    model: 'muse-spark-1.3',
    reasoningEffort: 'low',
    promptFile: '/tmp/p/prompt.md',
  });
  expect(full).toContain('muse-spark-1.3');
  expect(full).toContain('low');
});

test('full-access bypasses approval and sandbox; anything else leaves the CLI defaults', () => {
  const bypass = buildMuseArgs({ sessionId: 's', promptFile: '/tmp/p/prompt.md', approvalMode: 'full-access' });
  expect(bypass).toContain('--disable-approval');
  expect(bypass).toContain('--disable-sandbox');
  const auto = buildMuseArgs({ sessionId: 's', promptFile: '/tmp/p/prompt.md', approvalMode: 'auto' });
  expect(auto).not.toContain('--disable-approval');
  expect(auto).not.toContain('--disable-sandbox');
  expect(auto).not.toContain('--yolo');
});

test('a oneshot completion is plain `exec` with --no-session-log and no --json', () => {
  const args = buildMuseSingleShotArgs({ model: 'muse-spark-1.3', reasoningEffort: 'minimal', promptFile: '/tmp/p/prompt.md' });
  expect(args[0]).toBe('exec');
  expect(args).not.toContain('--json');
  // A completion is not a conversation: nothing must land in the session log.
  // (--session-id and --no-session-log together are exit 2, so no sid here.)
  expect(args).toContain('--no-session-log');
  expect(args).not.toContain('--session-id');
  expect(args).toContain('muse-spark-1.3');
  expect(args).toContain('minimal');
  expect(args.slice(-2)).toEqual(['--prompt-file', '/tmp/p/prompt.md']);
});
