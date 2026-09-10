/** @covers CODEX-02 */
/**
 * A stored thread id whose rollout file still exists is not proof the resume
 * itself will succeed: the CLI can still reject it, or the account/session
 * state can have moved on. Without a fallback, `resolveCodexInvocation` keeps
 * picking `resume` forever (it only drops an id whose rollout is GONE), so
 * the topic's Codex chat breaks permanently and the only fix is a manual
 * DELETE on `codex_sessions`. This proves the fallback: a resume that exits
 * non-zero retries once, fresh, with the history, and forgets the dead id.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getDatabase, initDatabase } from '../db';
import { _resetCodexBinCache } from '../lib/codex-bin';
import { CodexProvider } from './codex';

let tempRoot: string;
let codexHome: string;
const previousBin = process.env.CODEX_BIN;
const previousHome = process.env.CODEX_HOME;

const STALE_THREAD_ID = 'dead-thread-resume-fallback';

function seedTopic(sessionKey: string): void {
  const now = new Date().toISOString();
  getDatabase().prepare(`INSERT INTO topics
    (id, name, slug, session_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(sessionKey, 'Test', sessionKey, sessionKey, now, now);
}

function seedStoredThreadId(sessionKey: string): void {
  const now = new Date().toISOString();
  getDatabase().prepare(`INSERT INTO codex_sessions
    (session_key, codex_thread_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(sessionKey, STALE_THREAD_ID, now, now);
}

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'topics-codex-resume-fallback-')));
  initDatabase(join(import.meta.dir, '..', '..'), tempRoot);

  // A rollout file that DOES exist, so `resolveCodexInvocation` picks resume.
  codexHome = join(tempRoot, 'codex-home');
  const dayDir = join(codexHome, 'sessions', '2026', '09', '10');
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(join(dayDir, `rollout-2026-09-10T00-00-00-${STALE_THREAD_ID}.jsonl`), '');
  process.env.CODEX_HOME = codexHome;

  // The fixture fails every `exec resume`, and succeeds every fresh `exec`.
  // It reports the mode it saw AND the stdin prompt it received, so the test
  // can tell a real retry (fresh, with history) from a bare failure.
  const binary = join(tempRoot, 'fake-codex');
  writeFileSync(binary, `#!${process.execPath}
const input = await Bun.stdin.text();
const argv = process.argv.slice(2);
if (argv.includes("resume")) {
  console.error("simulated resume failure");
  process.exit(1);
}
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: input } }));
`, { mode: 0o700 });
  process.env.CODEX_BIN = binary;
  _resetCodexBinCache();
});

afterAll(() => {
  if (previousBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previousBin;
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  _resetCodexBinCache();
  closeDatabase();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('codex resume failure falls back to a fresh turn', () => {
  test('a resume that exits non-zero retries once fresh, with history, and forgets the dead thread id', async () => {
    const sessionKey = 'topic:codex-resume-fallback';
    seedTopic(sessionKey);
    seedStoredThreadId(sessionKey);

    const provider = new CodexProvider({ type: 'codex', defaultWorkspace: tempRoot });
    const errors: string[] = [];
    const result = await new Promise<string>((resolve, reject) => {
      void provider.sendChat(sessionKey, 'the new message', {
        onTextDelta() {}, onToolStart() {}, onToolResult() {},
        onError: (message) => { errors.push(message); },
        onDone: (done) => resolve(done?.result ?? ''),
      }, {
        model: 'gpt-test-fixture',
        history: [{ role: 'user', content: 'earlier turn' }, { role: 'assistant', content: 'earlier reply' }],
      }).catch(reject);
    });

    // The retry succeeded: no error surfaced from the dead resume.
    expect(errors).toEqual([]);
    // The fresh retry carried the history, since a resumed thread's prompt
    // (the one that failed) would have been ONLY the new message.
    expect(result).toContain('earlier turn');
    expect(result).toContain('the new message');

    // The dead thread id must not survive: otherwise every future turn
    // repeats the same failing resume forever.
    const row = getDatabase()
      .prepare('SELECT codex_thread_id FROM codex_sessions WHERE session_key = ?')
      .get(sessionKey);
    expect(row).toBeNull();
  });
});
