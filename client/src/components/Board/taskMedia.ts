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

/** One screen of the full-screen evidence viewer. */
export type EvidenceSlide =
  | { kind: 'single'; path: string }
  /** Two files, shown on the same frame under a draggable divider. */
  | { kind: 'pair'; before: string; after: string }
  /** One image holding both halves side by side: left is before, right is after. */
  | { kind: 'sideBySide'; path: string };

const BEFORE_WORD = /(^|[^a-z])(prima|before|reference|ref|old)([^a-z]|$)/i;
const AFTER_WORD = /(^|[^a-z])(dopo|after|new|nuovo)([^a-z]|$)/i;
const SIDE_BY_SIDE = /(affianca|side-?by-?side|before-?after|prima-?dopo|ref(erence)?-?(dopo|after)|compare)/i;

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Whether a single file is a before/after composite (split down the middle). */
export function isSideBySideName(path: string): boolean {
  return SIDE_BY_SIDE.test(baseName(path));
}

/**
 * The viewer's slides. A file named like a before and one named like an after
 * collapse into ONE comparison slide at the position of the first of them;
 * a composite file becomes a comparison on its own; the rest stay single.
 */
export function buildEvidenceSlides(paths: readonly string[]): EvidenceSlide[] {
  const images = paths.filter((p) => !/\.(mp4|webm|mov)$/i.test(p));
  const before = images.find((p) => BEFORE_WORD.test(baseName(p)) && !AFTER_WORD.test(baseName(p)) && !isSideBySideName(p));
  const after = images.find((p) => AFTER_WORD.test(baseName(p)) && !BEFORE_WORD.test(baseName(p)) && !isSideBySideName(p));
  const pair = before && after ? { before, after } : null;
  const out: EvidenceSlide[] = [];
  let pairPlaced = false;
  for (const p of paths) {
    if (pair && (p === pair.before || p === pair.after)) {
      if (!pairPlaced) { out.push({ kind: 'pair', ...pair }); pairPlaced = true; }
      continue;
    }
    if (images.includes(p) && isSideBySideName(p)) out.push({ kind: 'sideBySide', path: p });
    else out.push({ kind: 'single', path: p });
  }
  return out;
}
