import { INCOMPLETE_CARD_NOTICE_PREFIX } from '../../../../shared/agent-card-contract';

type Tr = (key: string, vars?: Record<string, string | number>) => string;

/**
 * What a thread line says to a reader: the system notices that the server writes
 * in English are replaced by the catalogue sentence, and a leaked raw
 * `human_ask:` field name is dropped so only the question stays.
 */
export function readableCommentContent(content: string, tr: Tr): string {
  if (content.startsWith(INCOMPLETE_CARD_NOTICE_PREFIX)) return tr('board.task.incompleteCardNotice');
  return content.replace(/^\s*human_ask:\s*/i, '');
}
