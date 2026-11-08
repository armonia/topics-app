import { parseQuestionBlock, type TaskComment } from '../../../../shared/board';

/** Supplementary delivery notes stay available without repeating a turn's reply. */
export function deliveryNotesToFold(comments: readonly TaskComment[]): Set<string> {
  const responses = new Set<string>();
  const notes = new Set<string>();
  for (const comment of comments) {
    if (!comment.messageId || !(comment.author === 'agent' || comment.author.startsWith('agent:'))) continue;
    const key = `${comment.author}/${comment.messageId}`;
    if (parseQuestionBlock(comment.content)) continue;
    if (comment.kind === 'comment' && comment.content.trim()) responses.add(key);
    // Prose questions and Markdown links/images can carry the next action or
    // an artifact independently of the earlier reply. Keep them in full.
    if (comment.kind === 'delivery' && !comment.media?.length && !/[?]|\]\s*[([]/.test(comment.content) && responses.has(key)) notes.add(comment.id);
  }
  return notes;
}
