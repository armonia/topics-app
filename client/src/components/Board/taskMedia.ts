import type { ChatMessage } from '../../types';
import { extractMediaPaths } from '../messageMedia';

/** Whether an attachment is already represented in the conversation. */
export function hasConversationMedia(
  path: string | null | undefined,
  comments: readonly { content?: string; media?: string[] }[],
  messages: readonly Pick<ChatMessage, 'role' | 'content' | 'media' | 'blocks'>[],
): boolean {
  if (!path) return false;
  const contains = (content?: string) => extractMediaPaths(content ?? '').mediaPaths.includes(path);
  // Comment and user prose use Markdown alone; only assistant content renders
  // MEDIA markers. Counting an unrendered marker would hide the only opener.
  return comments.some((comment) => comment.media?.includes(path))
    || messages.some((message) => message.role === 'assistant' && (message.media?.includes(path) || contains(message.content)
      || message.blocks?.some((block) => block.kind === 'text' && contains(block.text))));
}

/**
 * Gli artefatti di un task, in ordine, deduplicati — uno per tab.
 *
 * Due sorgenti che prima non si parlavano: l'ANTEPRIMA della consegna, che
 * l'agente imposta con `update_task(previewImage=…)`, e gli ALLEGATI dei
 * commenti del thread. Le tab dei media si costruivano solo dai secondi, per
 * cui l'anteprima — l'artefatto che il reviewer guarda per primo — era l'unico
 * senza una sua tab: si poteva solo sbirciare nel drawer o aprire fuori
 * dall'app.
 *
 * L'anteprima va in TESTA perché è la consegna; i commenti seguono dal più
 * recente, che è l'ordine in cui una review li vuole.
 */
export function collectTaskMediaPaths(
  previewImage: string | null | undefined,
  comments: readonly { media?: string[] }[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (previewImage) { seen.add(previewImage); out.push(previewImage); }
  for (let i = comments.length - 1; i >= 0; i--) {
    for (const m of comments[i]!.media ?? []) {
      if (!seen.has(m)) { seen.add(m); out.push(m); }
    }
  }
  return out;
}
