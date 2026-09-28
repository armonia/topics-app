/** @covers CHAT-CHANGES-01 */
/**
 * `codex exec --json` streams the items of its primary thread only (exec's
 * `should_process_notification`, codex-rs 0.153.4), so a patch applied by a
 * sub-agent the turn spawned never reaches routeCodexEvent. On the tasks the
 * card names that is most of the work: 47 of the 74 files of 7657f201 were
 * written by sub-agents alone. The provider reads them back from the
 * sub-agents' rollouts when the process exits, before the turn ends, so the
 * changed-files strip (refreshed at `stream:end`) lists them.
 *
 * The fixture binary behaves like the real CLI on this point: it writes its
 * own rollout and a sub-agent's under $CODEX_HOME/sessions, and prints only
 * the primary thread's events.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { _resetCodexBinCache } from '../lib/codex-bin';
import { aggregateTouchedFiles } from '../lib/topic-changes';
import type { ToolCall } from '../../shared/types';
import { CodexProvider } from './codex';

const SESSION = '01a09570-bba3-7c53-9417-b2ff4923c341';
const CHILD = '01a09572-3ca3-7d33-99aa-c837c22ad3b7';

let tempRoot: string;
const previousBin = process.env.CODEX_BIN;
const previousHome = process.env.CODEX_HOME;

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'topics-codex-subagent-patches-')));
  process.env.CODEX_HOME = join(tempRoot, 'codex-home');

  const binary = join(tempRoot, 'fake-codex');
  writeFileSync(binary, `#!${process.execPath}
import { mkdirSync, writeFileSync } from "fs";
await Bun.stdin.text();
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const dir = [process.env.CODEX_HOME, "sessions", now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("/");
mkdirSync(dir, { recursive: true });
const at = now.toISOString();
const stamp = at.slice(0, 19).replace(/:/g, "-");
const meta = (id, sub) => JSON.stringify({ timestamp: at, type: "session_meta", payload: {
  session_id: ${JSON.stringify(SESSION)}, id, cwd: "/wt", originator: "codex_exec", cli_version: "0.153.4",
  ...(sub ? { parent_thread_id: ${JSON.stringify(SESSION)}, thread_source: "subagent",
    source: { subagent: { thread_spawn: { parent_thread_id: ${JSON.stringify(SESSION)}, depth: 1, agent_path: "/root/worker", agent_nickname: "Bohr", agent_role: null } } } } : {}),
} });
const patch = (id, changes) => JSON.stringify({ timestamp: at, type: "event_msg", payload: {
  type: "item_completed", thread_id: ${JSON.stringify(CHILD)}, turn_id: "t1",
  item: { type: "FileChange", id, changes, status: "completed", stdout: "Success.", stderr: "" },
  started_at_ms: now.getTime(), completed_at_ms: now.getTime(),
} });
writeFileSync(dir + "/rollout-" + stamp + "-${SESSION}.jsonl", meta(${JSON.stringify(SESSION)}, false) + "\\n");
writeFileSync(dir + "/rollout-" + stamp + "-${CHILD}.jsonl", [
  meta(${JSON.stringify(CHILD)}, true),
  patch("exec-1", { "/wt/src/model-picker.ts": { type: "update", unified_diff: "@@ -1 +1 @@", move_path: null } }),
  patch("exec-2", { "/wt/src/model-selector.ts": { type: "add", content: "export {};" } }),
].join("\\n") + "\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: ${JSON.stringify(SESSION)} }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "file_change", status: "completed", changes: [{ path: "/wt/src/primary.ts", kind: "update" }] } }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "done" } }));
`, { mode: 0o700 });
  process.env.CODEX_BIN = binary;
  _resetCodexBinCache();
});

afterAll(() => {
  if (previousBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previousBin;
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  _resetCodexBinCache();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('patches applied by a Codex sub-agent', () => {
  test('reach the turn as write/edit tool calls before it ends, and the changed-files strip lists them', async () => {
    const provider = new CodexProvider({ type: 'codex', defaultWorkspace: tempRoot });
    const events: string[] = [];
    const calls = new Map<string, ToolCall>();
    await new Promise<void>((resolve, reject) => {
      void provider.sendChat('topic:codex-subagent-patches', 'edit the picker', {
        onTextDelta() {},
        onToolStart: (id, name, args) => {
          events.push(`start:${id}`);
          calls.set(id, { id, name, args: args ?? {} });
        },
        onToolResult: (id, result, error) => {
          events.push(`result:${id}`);
          const call = calls.get(id);
          if (call && error) call.error = result;
        },
        onError: (message) => reject(new Error(message)),
        onDone: () => { events.push('done'); resolve(); },
      }, { model: 'gpt-test-fixture' }).catch(reject);
    });

    expect(events).toEqual([
      'start:item_0:0', 'result:item_0:0',
      `start:${CHILD}:exec-1:0`, `result:${CHILD}:exec-1:0`,
      `start:${CHILD}:exec-2:0`, `result:${CHILD}:exec-2:0`,
      'done',
    ]);
    const files = aggregateTouchedFiles([{ timestamp: '2026-09-28T10:00:00.000Z', toolCalls: [...calls.values()] }]);
    expect(files.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: '/wt/src/primary.ts', kind: 'modified' },
      { path: '/wt/src/model-picker.ts', kind: 'modified' },
      { path: '/wt/src/model-selector.ts', kind: 'created' },
    ]);
  });
});
