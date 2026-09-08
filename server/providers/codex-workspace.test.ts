/** @covers MP-TASK-01 */
/** Codex must execute in the task checkout, regardless of the server cwd. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getDatabase, initDatabase } from '../db';
import { _resetCodexBinCache } from '../lib/codex-bin';
import { CodexProvider } from './codex';

let tempRoot: string;
let projectDir: string;
let worktreeDir: string;
let defaultDir: string;
const previousBin = process.env.CODEX_BIN;

function seedTopic(sessionKey: string, projectPath: string | null, worktreeId: string | null): void {
  const now = new Date().toISOString();
  getDatabase().prepare(`INSERT INTO topics
    (id, name, slug, session_key, project_path, worktree_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionKey, 'Test', sessionKey, sessionKey, projectPath, worktreeId, now, now);
}

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'topics-codex-cwd-')));
  initDatabase(join(import.meta.dir, '..', '..'), tempRoot);
  projectDir = join(tempRoot, 'project');
  worktreeDir = join(tempRoot, 'task-checkout');
  defaultDir = join(tempRoot, 'default');
  for (const path of [projectDir, worktreeDir, defaultDir]) mkdirSync(path);
  const binary = join(tempRoot, 'fake-codex');
  // This fixture only reports its OS cwd after receiving stdin; it cannot
  // call a model, read credentials, or execute any of the CLI arguments.
  writeFileSync(binary, `#!${process.execPath}\nawait Bun.stdin.text();\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.cwd()}}));\n`, { mode: 0o700 });
  process.env.CODEX_BIN = binary;
  _resetCodexBinCache();
  const now = new Date().toISOString();
  getDatabase().prepare(`INSERT INTO projects
    (id, name, slug, path, archived, created_at, updated_at)
    VALUES ('codex-project', 'Project', 'codex-project', ?, 0, ?, ?)`).run(projectDir, now, now);
  getDatabase().prepare(`INSERT INTO worktrees
    (id, project_id, name, mode, abs_path, status, created_at, updated_at)
    VALUES ('codex-worktree', 'codex-project', 'Task', 'branch', ?, 'ready', ?, ?)`).run(worktreeDir, now, now);
});

afterAll(() => {
  if (previousBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = previousBin;
  _resetCodexBinCache();
  closeDatabase();
  rmSync(tempRoot, { recursive: true, force: true });
});

async function spawnedWorkspace(sessionKey: string): Promise<string> {
  const provider = new CodexProvider({ type: 'codex', defaultWorkspace: defaultDir });
  return new Promise<string>((resolve, reject) => {
    void provider.sendChat(sessionKey, 'Report the fixture cwd', {
      onTextDelta() {}, onToolStart() {}, onToolResult() {},
      onDone: (result) => resolve(result?.result ?? ''),
      onError: (error) => reject(new Error(error)),
    }, { model: 'gpt-test-fixture' }).catch(reject);
  });
}

describe('Codex subprocess workspace', () => {
  test('the ready task worktree takes precedence over project and provider defaults', async () => {
    seedTopic('topic:codex-worktree', projectDir, 'codex-worktree');
    expect(await spawnedWorkspace('topic:codex-worktree')).toBe(worktreeDir);
  });

  test('a project conversation executes in its checkout', async () => {
    seedTopic('topic:codex-project', projectDir, null);
    expect(await spawnedWorkspace('topic:codex-project')).toBe(projectDir);
  });

  test('an unbound conversation retains the configured fallback', async () => {
    seedTopic('topic:codex-unbound', null, null);
    expect(await spawnedWorkspace('topic:codex-unbound')).toBe(defaultDir);
  });
});
