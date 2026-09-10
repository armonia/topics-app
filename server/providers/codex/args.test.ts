/** @covers CODEX-RESUME-01 */
import { expect, test } from 'bun:test';
import { buildCodexArgs, buildCodexResumeArgs } from './args';

test('buildCodexResumeArgs targets `exec resume <thread_id>` instead of a fresh exec', () => {
  const args = buildCodexResumeArgs({
    threadId: 'thread-123',
    model: 'gpt-5-codex',
    approvalMode: null,
    sandbox: 'workspace-write',
    bridge: null,
    reasoningEffort: null,
  });
  expect(args.slice(0, 5)).toEqual(['exec', 'resume', 'thread-123', '--json', '--skip-git-repo-check']);
  expect(args).toContain('--model');
  expect(args).toContain('gpt-5-codex');
});

test('buildCodexResumeArgs sets the sandbox via `-c sandbox_mode=` because `codex exec resume` has no --sandbox flag', () => {
  // Verified against the live CLI (`codex exec resume --help`, codex-cli
  // 0.153.4): unlike `codex exec`, `resume` does not expose `-s/--sandbox` at
  // all. The sandbox is still settable, just through the generic `-c`
  // override, and `-c sandbox_mode=<value> --strict-config` was confirmed to
  // accept the same enum (`read-only` / `workspace-write` /
  // `danger-full-access`) that `--sandbox` takes on plain `exec`.
  const args = buildCodexResumeArgs({
    threadId: 'thread-abc',
    sandbox: 'read-only',
    reasoningEffort: null,
  });
  expect(args).not.toContain('--sandbox');
  expect(args).toContain('-c');
  expect(args).toContain('sandbox_mode="read-only"');
});

test('buildCodexResumeArgs defaults to workspace-write, mirroring buildCodexArgs', () => {
  const resumeArgs = buildCodexResumeArgs({ threadId: 'thread-xyz' });
  expect(resumeArgs).toContain('sandbox_mode="workspace-write"');
});

test('buildCodexResumeArgs keeps --dangerously-bypass-approvals-and-sandbox for full-access, exactly like buildCodexArgs', () => {
  const freshArgs = buildCodexArgs({ approvalMode: 'full-access' });
  const resumeArgs = buildCodexResumeArgs({ threadId: 'thread-full', approvalMode: 'full-access' });
  expect(freshArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
  expect(resumeArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
  expect(resumeArgs).not.toContain('--sandbox');
  expect(resumeArgs).not.toContain('sandbox_mode');
});

test('buildCodexResumeArgs forwards the bridge and reasoning effort exactly like buildCodexArgs', () => {
  const bridge = { command: '/usr/bin/topics-bridge', args: ['--stdio'] };
  const resumeArgs = buildCodexResumeArgs({ threadId: 'thread-bridge', bridge, reasoningEffort: 'high' });
  expect(resumeArgs).toContain('-c');
  expect(resumeArgs).toContain('mcp_servers.topics.command="/usr/bin/topics-bridge"');
  expect(resumeArgs).toContain('mcp_servers.topics.args=["--stdio"]');
  expect(resumeArgs).toContain('model_reasoning_effort="high"');
});

test('buildCodexResumeArgs forwards isolated exactly like buildCodexArgs', () => {
  const resumeArgs = buildCodexResumeArgs({ threadId: 'thread-iso', isolated: true });
  expect(resumeArgs).toContain('--ignore-user-config');
  expect(resumeArgs).toContain('--ignore-rules');
});
