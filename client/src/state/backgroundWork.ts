/**
 * THE WORK A CLOSED TURN LEFT RUNNING, as the client reads and keeps it.
 *
 * `GET /api/topics/streaming` answers three kinds of rows: a reply in progress
 * (`streaming`), one parked on a question (`waiting`), and a chat with no turn
 * open whose last turn left an Agent, a Bash or a Monitor running
 * (`background`). The first two are turns; the third is not, and it must never
 * be read as one: `reconcileServerStreams` and the composer would treat the
 * chat as mid-reply, queue the next message and reopen a turn that is over.
 *
 * So the reading rule lives here, in one pure function, and the background
 * rows go to a set (per session, for the composer's Stop) and a map (per
 * topic, for the glyphs, the chat line and the agent list) of their own.
 */
import type { BackgroundTaskSummary, BackgroundWorkDetail } from '../../../shared/background-work';
import type { Topic } from '../types';

/** A chat waiting on background work: the session that owns it, its tasks and the last news. */
export type TopicBackgroundWork = BackgroundWorkDetail & { sessionKey: string };

/** One row of the poll, as loosely as it arrives. */
export type StreamingRowInput = {
  topicId?: string;
  sessionKey?: string;
  state?: string;
  tasks?: BackgroundTaskSummary[];
  lastSignalAt?: number;
};

export interface StreamingSnapshot {
  /** Topics with a turn open, answering or parked on a question. */
  streamingTopics: Set<string>;
  /** The same turns by session: what the self-heal compares against. */
  streamingSessions: Set<string>;
  /** Topics whose open turn waits for an answer. */
  waitingTopics: Set<string>;
  /** Sessions with background work only: the composer offers their Stop. */
  backgroundSessions: Set<string>;
  /** The same work by topic, with what it is. */
  backgroundTopics: Map<string, TopicBackgroundWork>;
}

/**
 * The reading rule of the poll. `waiting` is an OPEN turn and stays among the
 * streaming ones, or the self-heal would close a chat parked on a question; a
 * background row never enters them.
 */
export function readStreamingSnapshot(rows: ReadonlyArray<StreamingRowInput>): StreamingSnapshot {
  const snap: StreamingSnapshot = {
    streamingTopics: new Set(),
    streamingSessions: new Set(),
    waitingTopics: new Set(),
    backgroundSessions: new Set(),
    backgroundTopics: new Map(),
  };
  for (const s of rows) {
    if (s.state === 'background') {
      if (!s.sessionKey) continue;
      snap.backgroundSessions.add(s.sessionKey);
      if (s.topicId) {
        snap.backgroundTopics.set(s.topicId, {
          sessionKey: s.sessionKey,
          // A server older than the task list sends none: nothing is named.
          tasks: Array.isArray(s.tasks) ? s.tasks : [],
          lastSignalAt: typeof s.lastSignalAt === 'number' ? s.lastSignalAt : 0,
        });
      }
      continue;
    }
    if (s.state !== 'streaming' && s.state !== 'waiting') continue;
    if (s.topicId) snap.streamingTopics.add(s.topicId);
    if (s.sessionKey) snap.streamingSessions.add(s.sessionKey);
    if (s.state === 'waiting' && s.topicId) snap.waitingTopics.add(s.topicId);
  }
  return snap;
}

function sameWork(a: TopicBackgroundWork, b: TopicBackgroundWork): boolean {
  return a.sessionKey === b.sessionKey
    && a.lastSignalAt === b.lastSignalAt
    && a.tasks.length === b.tasks.length
    && a.tasks.every((t, i) => t.type === b.tasks[i].type && t.description === b.tasks[i].description);
}

/**
 * The next per-topic map, keeping every entry that did not change, and the
 * previous map itself when nothing did: every sidebar row and tab selects its
 * own entry, and a poll that brings no news must not re-render them.
 */
export function mergeBackgroundWork(
  prev: ReadonlyMap<string, TopicBackgroundWork>,
  next: ReadonlyMap<string, TopicBackgroundWork>,
): ReadonlyMap<string, TopicBackgroundWork> {
  let changed = prev.size !== next.size;
  const out = new Map<string, TopicBackgroundWork>();
  for (const [id, work] of next) {
    const old = prev.get(id);
    if (old && sameWork(old, work)) out.set(id, old);
    else { out.set(id, work); changed = true; }
  }
  return changed ? out : prev;
}

/**
 * How many chats of a project wait on background work: the same child-walk as
 * `useProjectLoading`. An archived chat is left out, the gate the agent list
 * applies too (`visibleTopicSignalIds`): closing a tab archives the chat and
 * leaves its work running, and a folder lit by a chat that no row, tab or agent
 * line names is a glyph nobody can trace.
 */
export function projectBackgroundCount(
  projectPath: string,
  topics: Record<string, Topic>,
  work: ReadonlyMap<string, TopicBackgroundWork>,
): number {
  let n = 0;
  for (const id of work.keys()) {
    const t = topics[id];
    if (t && !t.archived && t.projectPath === projectPath) n++;
  }
  return n;
}
