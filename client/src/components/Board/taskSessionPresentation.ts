import type { ChatMessage, ContentBlock } from '../../types';
import { isAwaitingHuman } from '../../../../shared/types';
import { blocksOf } from '../Chat/coalesceToolRun';
import { toolsOf } from '../Chat/taskWorkFold';
import { isActiveTool } from '../Chat/toolGrouping';
import { LEGACY_ERROR_PREFIX, turnErrorOf } from '../Chat/turnError';
import { extractMediaPaths, splitBlockMedia } from '../messageMedia';
import { parseQuestionBlock } from '../../../../shared/board';

export interface SessionSegment {
  message: ChatMessage;
  folded: boolean;
  /** Technical work and progress remain part of the expandable session. */
  sessionDetail?: true;
}

function withVoiceMarkers(content: string, paths: Iterable<string>, voices: ReadonlySet<string>): string {
  const alreadyMarked = extractMediaPaths(content).voicePaths;
  const missing = [...paths].filter((path) => voices.has(path) && !alreadyMarked.has(path));
  return missing.length ? `${content}\n${missing.map((path) => `[Voice message: ${path}]`).join('\n')}` : content;
}

/** Strip only the legacy error paragraph; its visible error block owns it. */
function withoutLegacyError(content: string): string {
  const text = content.trim();
  if (!text.startsWith(LEGACY_ERROR_PREFIX)) return content;
  return text.split(/\n\s*\n/).slice(1).join('\n\n');
}

/** Keep replies, decisions, failures and attachments in view, including live turns. */
export function taskSessionSegments(message: ChatMessage, hasThreadReply = false, activeRun = false): SessionSegment[] {
  const visible = () => [{ message, folded: false }];
  if (message.role !== 'assistant') return visible();
  const tools = toolsOf(message);
  const inFlight = activeRun || !!message.partial || tools.some(isActiveTool);

  const extracted = extractMediaPaths(message.content ?? '');
  const voices = new Set(extracted.voicePaths);
  const error = turnErrorOf({ content: extracted.cleanText, blocks: message.blocks });
  const legacyError = error !== null && !message.blocks?.some((block) => block.kind === 'error');
  // Imported failures can live only in content even when blocks exist. Give
  // that verdict its own visible block rather than exposing adjacent work.
  let sourceBlocks = blocksOf(message);
  if (legacyError) {
    sourceBlocks = sourceBlocks.flatMap((block): ContentBlock[] => {
      if (block.kind !== 'text' || !block.text.trim().startsWith(LEGACY_ERROR_PREFIX)) return [block];
      const media = extractMediaPaths(block.text);
      for (const path of media.voicePaths) voices.add(path);
      const inlineMedia = message.blocks?.length ? media.mediaPaths : [];
      const text = [
        withoutLegacyError(media.cleanText),
        ...new Set(inlineMedia.map((path) => `[${voices.has(path) ? 'Voice message' : 'Attached file'}: ${path}]`)),
      ].filter(Boolean).join('\n');
      return text ? [{ kind: 'text', text }] : [];
    });
    sourceBlocks.push({ kind: 'error', text: error });
  }
  const inlinePaths = new Set<string>();
  const mediaByBlock = new Map<ContentBlock, string[]>();
  // Only real timeline blocks own inline attachments. Content reconstructed
  // for legacy rows still uses the late/explicit attachment tail below.
  for (const block of message.blocks?.length ? sourceBlocks : []) {
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
  const content = withVoiceMarkers(
    legacyError ? withoutLegacyError(extracted.cleanText) : appended.length ? extracted.cleanText : message.content,
    inlinePaths, voices,
  );
  const transcript = appended.length || message.media?.length || content !== message.content || legacyError
    ? { ...message, content, media: undefined, ...(legacyError ? { blocks: sourceBlocks } : {}) }
    : message;
  const blocks = blocksOf(transcript);
  let lastTool = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.kind === 'tool' && !isAwaitingHuman(block.toolCall.status) && block.toolCall.status !== 'error') { lastTool = i; break; }
  }
  const groups: Array<{ folded: boolean; blocks: ContentBlock[]; start: string }> = [];
  const push = (block: ContentBlock, folded: boolean, start: string) => {
    const last = groups[groups.length - 1];
    if (last?.folded === folded) last.blocks.push(block);
    else groups.push({ folded, blocks: [block], start });
  };
  for (const [index, block] of blocks.entries()) {
    const folded = block.kind === 'error' ? false
      : block.kind === 'tool' ? !isAwaitingHuman(block.toolCall.status) && block.toolCall.status !== 'error'
      : block.kind === 'thinking' ? true
      : block.kind === 'text' ? !parseQuestionBlock(block.text) && (hasThreadReply || inFlight || index < lastTool)
      : hasThreadReply || inFlight;
    if (folded && block.kind === 'text' && mediaByBlock.has(block)) {
      // A progress sentence carrying an attachment must not expose the whole
      // progress update. Keep the media at its position and fold only the prose.
      for (const [partIndex, part] of splitBlockMedia(block.text).entries()) {
        const piece: ContentBlock = { kind: 'text', text: part.kind === 'text' ? part.text
          : `[${voices.has(part.path) ? 'Voice message' : 'Attached file'}: ${part.path}]` };
        if (part.kind === 'media') mediaByBlock.set(piece, [part.path]);
        push(piece, part.kind === 'text', partIndex === 0 ? String(index) : `${index}.${partIndex}`);
      }
    } else push(block, folded, String(index));
  }
  if (groups.length === 0 && appended.length === 0) return visible();
  const segments: SessionSegment[] = groups.map((group) => ({
    folded: group.folded,
    ...(group.folded ? { sessionDetail: true as const } : {}),
    message: groups.length === 1 ? { ...transcript, id: `${message.id}:${group.start}` } : {
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
