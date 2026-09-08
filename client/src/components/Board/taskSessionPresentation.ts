import type { ChatMessage, ContentBlock } from '../../types';
import { isAwaitingHuman } from '../../../../shared/types';
import { blocksOf } from '../Chat/coalesceToolRun';
import { toolsOf } from '../Chat/taskWorkFold';
import { isActiveTool } from '../Chat/toolGrouping';
import { turnErrorOf } from '../Chat/turnError';
import { extractMediaPaths } from '../messageMedia';

export interface SessionSegment {
  message: ChatMessage;
  folded: boolean;
  /** The transcript belongs to a turn represented in the task conversation. */
  sessionDetail?: true;
}

function withVoiceMarkers(content: string, paths: Iterable<string>, voices: ReadonlySet<string>): string {
  const alreadyMarked = extractMediaPaths(content).voicePaths;
  const missing = [...paths].filter((path) => voices.has(path) && !alreadyMarked.has(path));
  return missing.length ? `${content}\n${missing.map((path) => `[Voice message: ${path}]`).join('\n')}` : content;
}

/** Keep decisions in view; mount completed work only when someone opens it. */
export function taskSessionSegments(message: ChatMessage, hasThreadReply = false): SessionSegment[] {
  const visible = () => [{ message, folded: false }];
  const tools = toolsOf(message);
  if (message.role !== 'assistant' || message.partial || turnErrorOf(message)
    || tools.some((tool) => isAwaitingHuman(tool.status) || isActiveTool(tool))) return visible();

  const extracted = extractMediaPaths(message.content ?? '');
  const voices = new Set(extracted.voicePaths);
  const inlinePaths = new Set<string>();
  const mediaByBlock = new Map<ContentBlock, string[]>();
  for (const block of message.blocks ?? []) {
    if (block.kind !== 'text') continue;
    const media = extractMediaPaths(block.text);
    if (!media.mediaPaths.length) continue;
    mediaByBlock.set(block, media.mediaPaths);
    for (const path of media.mediaPaths) inlinePaths.add(path);
    for (const path of media.voicePaths) voices.add(path);
  }
  // A late media update writes content alone. Move only attachments absent
  // from the block timeline to their own visible tail, once per path.
  const appended = [...new Set([...extracted.mediaPaths, ...(message.media ?? [])])]
    .filter((path) => !inlinePaths.has(path));
  const content = withVoiceMarkers(appended.length ? extracted.cleanText : message.content, inlinePaths, voices);
  const transcript = appended.length || message.media?.length || content !== message.content
    ? { ...message, content, media: undefined }
    : message;
  const blocks = blocksOf(transcript);
  const groups: Array<{ folded: boolean; blocks: ContentBlock[]; start: number }> = [];
  for (const [index, block] of blocks.entries()) {
    const folded = !mediaByBlock.has(block) && (hasThreadReply || block.kind === 'tool' || block.kind === 'thinking');
    const last = groups[groups.length - 1];
    if (last?.folded === folded) last.blocks.push(block);
    else groups.push({ folded, blocks: [block], start: index });
  }
  if (groups.length === 0 && appended.length === 0) return visible();
  const segments: SessionSegment[] = groups.map((group) => ({
    folded: group.folded,
    ...(group.folded && hasThreadReply ? { sessionDetail: true as const } : {}),
    message: groups.length === 1 ? transcript : {
      ...transcript,
      id: `${message.id}:${group.start}`,
      content: withVoiceMarkers(
        group.blocks.flatMap((block) => block.kind === 'text' ? [block.text] : []).join(''),
        new Set(group.blocks.flatMap((block) => mediaByBlock.get(block) ?? [])), voices,
      ),
      thinking: group.blocks.flatMap((block) => block.kind === 'thinking' ? [block.text] : []).join(''),
      toolCalls: group.blocks.flatMap((block) => block.kind === 'tool' ? [block.toolCall] : []),
      blocks: group.blocks,
    },
  }));
  if (appended.length) segments.push({
    folded: false,
    message: {
      ...message, id: `${message.id}:media`,
      content: withVoiceMarkers('', appended, voices), media: appended,
      thinking: undefined, toolCalls: undefined, blocks: undefined,
    },
  });
  return segments;
}
