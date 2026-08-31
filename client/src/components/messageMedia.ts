/**
 * I MARCATORI DEI MEDIA, e dove finiscono a schermo.
 *
 * Vive in un file suo per due motivi che coincidono: `react-refresh` vuole che
 * un modulo di componenti esporti SOLO componenti, e questa e' logica pura —
 * quindi si prova con `bun:test` senza montare niente (messageMedia.test.ts).
 *
 * Il requisito e' CHAT-MEDIA-01.
 */
export function extractMediaPaths(text: string): { cleanText: string; mediaPaths: string[]; voicePaths: Set<string> } {
  const mediaPaths: string[] = [];
  const voicePaths = new Set<string>();
  const mediaPattern = /MEDIA:([^\s\n]+)/g;
  let match;
  while ((match = mediaPattern.exec(text)) !== null) mediaPaths.push(match[1]);

  const attachedPattern = /\[Attached file:\s*([^\]]+)\]/g;
  while ((match = attachedPattern.exec(text)) !== null) mediaPaths.push(match[1].trim());

  const voicePattern = /\[Voice message:\s*([^\]]+)\]/g;
  while ((match = voicePattern.exec(text)) !== null) { const p = match[1].trim(); mediaPaths.push(p); voicePaths.add(p); }

  const cleanText = text
    .replace(/MEDIA:([^\s\n]+)/g, '')
    .replace(/\[Attached file:\s*[^\]]+\]/g, '')
    .replace(/\[Voice message:\s*[^\]]+\]/g, '')
    .trim();

  return { cleanText, mediaPaths, voicePaths };
}

/**
 * A MARKER IS DRAWN WHERE IT IS WRITTEN.
 *
 * Two things were wrong at once, and only one of them was a defect.
 *
 * The defect: `extractMediaPaths` above runs on `content`, but a message with a
 * timeline paints from `blocks`, and a block's text went to the screen
 * untouched — so the reader got `MEDIA:/Users/…/.topics/media/a.png` printed as
 * prose. Measured 2026-08-31 on a live row: two markers at the tail of block 57
 * of 58.
 *
 * The other thing was the DESIGN. Nobody had placed those images: the server
 * finds them, with a directory scan by mtime over `~/.topics/media`, and staples
 * them to the end of the turn (`updateLastMessageWithMedia`, server/utils.ts).
 * "Put them where the agent wanted them" was therefore not implementable — the
 * agent had never said.
 *
 * So the rule here is one rule, with no special case: the block is SPLIT and
 * every part is drawn in the order it appears. A marker the server appended sits
 * at the end of the last block, so it still lands at the end — nothing changes
 * for it. A marker the agent writes mid-sentence lands mid-sentence, which is
 * what makes showing a picture at the right moment possible at all.
 *
 * A part with empty prose is dropped: it carried nothing, and an empty bubble
 * between two images is a bubble about nothing.
 */
export type BlockPart = { kind: 'text'; text: string } | { kind: 'media'; path: string };

export function splitBlockMedia(text: string): BlockPart[] {
  if (!text.includes('MEDIA:') && !text.includes('[Attached file:') && !text.includes('[Voice message:')) {
    return text.trim() ? [{ kind: 'text', text }] : [];
  }
  // One pass, one regex, so the ORDER is the order on screen. Three shapes reach
  // a message: the marker the server appends, and the two bracket forms an
  // attachment and a voice note travel in.
  const pattern = /MEDIA:([^\s\n]+)|\[Attached file:\s*([^\]]+)\]|\[Voice message:\s*([^\]]+)\]/g;
  const parts: BlockPart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (raw: string) => { if (raw.trim()) parts.push({ kind: 'text', text: raw.trim() }); };
  while ((m = pattern.exec(text)) !== null) {
    pushText(text.slice(last, m.index));
    parts.push({ kind: 'media', path: (m[1] ?? m[2] ?? m[3] ?? '').trim() });
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return parts;
}

