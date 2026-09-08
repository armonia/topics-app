import { parseStatusEvent } from '../../../../shared/board';
import { isAwaitingHuman } from '../../../../shared/types';
import { toolsOf } from '../Chat/taskWorkFold';
import type { TimelineItem } from './taskTimeline';

type SessionRow = Extract<TimelineItem, { source: 'session' }>;
export type TaskSessionRunItem = SessionRow & { foldProgress: boolean };

/** Group adjacent session rows without changing their chronological anchors. */
export function taskSessionRuns(timeline: TimelineItem[], active: boolean, startedAt?: string | null) {
  const startIndex = timeline.findLastIndex((item) => item.source === 'comment'
    && item.kind === 'status' && parseStatusEvent(item.content)?.to === 'in_progress');
  const since = startIndex >= 0 ? timeline[startIndex].at : startedAt;
  const startTime = since ? Date.parse(since) : NaN;
  const runs = new Map<string, TaskSessionRunItem[]>();
  const hidden = new Set<string>();
  let current: TaskSessionRunItem[] | null = null;
  for (const [index, item] of timeline.entries()) {
    if (item.source !== 'session' || item.envelope || item.msg.role !== 'assistant') { current = null; continue; }
    // Missing status history must never classify every historical reply as live.
    const currentTurn = startIndex >= 0 ? index > startIndex : Date.parse(item.at) >= startTime;
    const row = { ...item, foldProgress: active && currentTurn };
    if (current) { current.push(row); hidden.add(item.id); }
    else { current = [row]; runs.set(item.id, current); }
  }
  for (const run of runs.values()) {
    let laterTool = false;
    const hasTools = run.some((item) => toolsOf(item.msg).length > 0);
    const lastTextIndex = run.findLastIndex((item) => item.msg.blocks?.length
      ? item.msg.blocks.some((block) => block.kind === 'text' && block.text.trim())
      : item.msg.content.trim().length > 0);
    for (let index = run.length - 1; index >= 0; index--) {
      const item = run[index];
      // Earlier fragments of a tool-backed turn remain work when it completes.
      // The final unmirrored message stays readable; input, media and errors are
      // always preserved by the block-level presentation below this grouping.
      const tools = toolsOf(item.msg);
      item.foldProgress ||= laterTool || (hasTools && !tools.length && index < lastTextIndex);
      // A question/error following the answer must not hide the context needed
      // to respond. Only subsequent ordinary work makes earlier prose progress.
      laterTool ||= tools.some((tool) => !isAwaitingHuman(tool.status) && tool.status !== 'error');
    }
  }
  return { runs, hidden, since };
}
