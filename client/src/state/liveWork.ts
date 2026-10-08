/**
 * WHAT A CHAT HAS AT WORK NOW, kept fresh for the strip under the chat
 * (chat-live-work). The server says which rows (`GET /api/topics/:id/live-work`);
 * the frames that already exist say when to ask again, and nothing polls:
 *
 *   - `scripts:output` carries the line a command is printing: its row's
 *     preview changes in place, with no request;
 *   - a process started, ended or found its port (`scripts:updated`,
 *     `background:changed`), a sub-agent changed phase (`terminal:sessions`),
 *     a turn started or ended (`stream:start`, `stream:end`), the hooks moved a
 *     CLI child to another tool (`session:state`), the socket came back: the
 *     rows are read again, at most once every half second;
 *   - a native child's tool calls reach a window only for a topic it holds
 *     (`holdTopic`): held while its row is live, its preview follows them.
 *
 * An ended row leaves when the server said it would (`goneInMs`), a minute
 * after its end: a reload asks the server again, which counts from the end,
 * so it does not bring the row back for longer.
 */
import { useEffect, useState } from 'react';
import { liveWorkApi } from '../lib/api';
import { subscribeFrames, subscribeLifecycle } from '../lib/wsFrameBus';
import { holdTopic } from './topicSubscriptions';
import type { LiveWorkRow } from '../../../shared/live-work';

const REFETCH_MS = 500;
const PREVIEW_CHARS = 200;

/** A tool call as one line, the way the server writes a CLI child's: `Bash: npm test`. */
export function toolCallLine(name: string, args: unknown): string {
  const o = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  for (const key of ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const v = o[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    const one = v.trim().replace(/\s+/g, ' ');
    return `${name}: ${one.length > PREVIEW_CHARS ? one.slice(0, PREVIEW_CHARS) : one}`;
  }
  return name;
}

/** The rows with one row's preview changed. The same array when nothing changes. */
export function withPreview(rows: readonly LiveWorkRow[], id: string, preview: string): readonly LiveWorkRow[] {
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0 || rows[i]!.preview === preview) return rows;
  const next = rows.slice();
  next[i] = { ...rows[i]!, preview };
  return next;
}

/** An ended row the person dismissed is not shown; a live one always is (its dismissal is from an earlier life). */
export function visibleRows(rows: readonly LiveWorkRow[], dismissed: readonly string[]): readonly LiveWorkRow[] {
  if (!dismissed.length) return rows;
  const out = rows.filter((r) => !(r.kind === 'agent' && r.state === 'ended' && dismissed.includes(r.id)));
  return out.length === rows.length ? rows : out;
}

export function useLiveWork(topicId: string): readonly LiveWorkRow[] {
  const [rows, setRows] = useState<readonly LiveWorkRow[]>([]);
  useEffect(() => {
    let alive = true;
    let current: readonly LiveWorkRow[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let again = false;
    const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const holds = new Map<string, () => void>();

    const show = (next: readonly LiveWorkRow[]) => {
      if (!alive || next === current) return;
      current = next;
      setRows(next);
      // A live native child's tool calls come to this window only while it holds its topic.
      const want = new Set(next.filter((r) => r.kind === 'agent' && r.runtime === 'topics' && r.state !== 'ended').map((r) => r.id));
      for (const [id, release] of holds) if (!want.has(id)) { release(); holds.delete(id); }
      for (const id of want) if (!holds.has(id)) holds.set(id, holdTopic(id));
    };
    const apply = (next: readonly LiveWorkRow[]) => {
      for (const t of expiryTimers.values()) clearTimeout(t);
      expiryTimers.clear();
      for (const r of next) {
        if (r.kind !== 'agent' || r.state !== 'ended' || typeof r.goneInMs !== 'number') continue;
        const id = r.id;
        // A delay past 2^31-1 ms overflows in a browser and fires at once.
        expiryTimers.set(id, setTimeout(() => { expiryTimers.delete(id); show(current.filter((x) => x.id !== id)); }, Math.min(r.goneInMs, 2 ** 31 - 1)));
      }
      show(next);
    };
    const load = async () => {
      if (inFlight) { again = true; return; }
      inFlight = true;
      try {
        const answer = await liveWorkApi.get(topicId);
        if (alive) apply(answer.rows);
      } catch {
        // The rows on screen stay: the next frame asks again.
      } finally {
        inFlight = false;
        if (again && alive) { again = false; void load(); }
      }
    };
    const soon = () => {
      if (!timer && alive) timer = setTimeout(() => { timer = null; void load(); }, REFETCH_MS);
    };

    void load();
    const offOutput = subscribeFrames((f) => {
      const { processId, line } = f as { processId?: unknown; line?: unknown };
      if (typeof processId === 'string' && typeof line === 'string') show(withPreview(current, processId, line));
    }, { types: ['scripts:output'] });
    const offTools = subscribeFrames((f) => {
      const { topicId: child, toolCall } = f as { topicId?: unknown; toolCall?: { name?: unknown; args?: unknown } };
      if (typeof child !== 'string' || typeof toolCall?.name !== 'string') return;
      if (current.some((r) => r.kind === 'agent' && r.id === child && r.state !== 'ended')) {
        show(withPreview(current, child, toolCallLine(toolCall.name, toolCall.args)));
      }
    }, { types: ['stream:tool_call'] });
    const offChanges = subscribeFrames((f) => {
      const frame = f as { type?: string; topicId?: unknown };
      if (frame.type === 'background:changed' && frame.topicId !== topicId) return;
      // Every Claude session's hooks: only a CLI child here makes them worth a read.
      if (frame.type === 'session:state' && !current.some((r) => r.kind === 'agent' && r.runtime === 'cli' && r.state !== 'ended')) return;
      soon();
    }, { types: ['scripts:updated', 'background:changed', 'terminal:sessions', 'stream:start', 'stream:end', 'session:state'] });
    const offSocket = subscribeLifecycle((e) => { if (e === 'open') soon(); });

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      for (const t of expiryTimers.values()) clearTimeout(t);
      for (const release of holds.values()) release();
      offOutput(); offTools(); offChanges(); offSocket();
    };
  }, [topicId]);
  return rows;
}
