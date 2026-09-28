/** @covers CMD-09 */
/**
 * `/clear` on a Codex chat: proof that the NEXT turn starts a new thread.
 *
 * The route emptied `messages`, but `clearActionFor` answered "none" for Codex
 * (no `resetSession`, no `sendToSession`), so the `codex_sessions` row stayed
 * and the next turn ran `codex exec resume <old-thread>`: the model remembered
 * a chat that was empty on screen. This walks the route's own path (policy,
 * then the provider method it picks) and then looks at the argv of the next
 * spawn.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getDatabase, initDatabase } from '../db';
import { _resetCodexBinCache } from '../lib/codex-bin';
import { clearActionFor } from '../routes/clearPolicy';
import { CodexProvider } from './codex';

let tempRoot: string;
const previousBin = process.env.CODEX_BIN;
const previousHome = process.env.CODEX_HOME;

const OLD_THREAD_ID = 'old-thread-before-clear';
const NEW_THREAD_ID = 'new-thread-after-clear';

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'topics-codex-reset-session-')));
  initDatabase(join(import.meta.dir, '..', '..'), tempRoot);

  // The old thread's rollout exists, so without a reset the next turn resumes it.
  const codexHome = join(tempRoot, 'codex-home');
  const dayDir = join(codexHome, 'sessions', '2026', '09', '29');
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(join(dayDir, `rollout-2026-09-29T00-00-00-${OLD_THREAD_ID}.jsonl`), '');
  process.env.CODEX_HOME = codexHome;

  // Echoes its argv as the reply, so the test reads what was spawned.
  const binary = join(tempRoot, 'fake-codex');
  writeFileSync(binary, `#!${process.execPath}
await Bun.stdin.text();
console.log(JSON.stringify({ type: "thread.started", thread_id: "${NEW_THREAD_ID}" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: process.argv.slice(2).join(" ") } }));
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

function storedThread(sessionKey: string): string | null {
  const row = getDatabase()
    .prepare('SELECT codex_thread_id FROM codex_sessions WHERE session_key = ?')
    .get(sessionKey) as { codex_thread_id: string } | null;
  return row?.codex_thread_id ?? null;
}

describe('CodexProvider.resetSession', () => {
  test('after /clear the next turn spawns a fresh `codex exec`, not `resume <old thread>`', async () => {
    const sessionKey = 'topic:codex-reset-session';
    const now = new Date().toISOString();
    const db = getDatabase();
    db.prepare(`INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionKey, 'Test', sessionKey, sessionKey, now, now);
    db.prepare(`INSERT INTO codex_sessions (session_key, codex_thread_id, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(sessionKey, OLD_THREAD_ID, now, now);

    const provider = new CodexProvider({ type: 'codex', defaultWorkspace: tempRoot });

    // What the /clear route does: ask the policy, run the gesture it names.
    const action = clearActionFor(provider);
    expect(action.kind).toBe('reset');
    await provider.resetSession(sessionKey);
    expect(storedThread(sessionKey)).toBeNull();

    const argv = await new Promise<string>((resolve, reject) => {
      void provider.sendChat(sessionKey, 'hello again', {
        onTextDelta() {}, onToolStart() {}, onToolResult() {},
        onError: (message) => reject(new Error(message)),
        onDone: (done) => resolve(done?.result ?? ''),
      }, { model: 'gpt-test-fixture' }).catch(reject);
    });

    expect(argv).toStartWith('exec ');
    expect(argv).not.toContain('resume');
    expect(argv).not.toContain(OLD_THREAD_ID);
    // The new thread becomes the one later turns resume.
    expect(storedThread(sessionKey)).toBe(NEW_THREAD_ID);
  });
});
