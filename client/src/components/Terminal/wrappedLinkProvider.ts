import type { Terminal, IDisposable, ILink, ILinkProvider } from '@xterm/xterm';
import { openLink, isExternalLinkGesture } from '@/lib/openLink';

// xterm's WebLinksAddon scans one visible line at a time, so a URL that breaks
// across rows only becomes clickable on its first row. This provider joins
// lines into a single logical string in two cases:
//   1. the next line has isWrapped === true (terminal soft-wrap),
//   2. the previous line ends with a URL character and the next line starts
//      with one (CLI inserted an explicit newline mid-URL — common with
//      `claude /login` OAuth URLs).
// Then it maps regex matches back to multi-row (x,y) ranges so the entire URL
// is clickable, even when it spans 2+ rows.

const URL_REGEX = /https?:\/\/[^\s'"`<>()[\]{}]+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}>'"`]+$/;
const URL_CHAR = /[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]/;

function endsMidUrl(text: string): boolean {
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed.length === 0) return false;
  if (!URL_CHAR.test(trimmed.slice(-1))) return false;
  return /https?:\/\/\S*$/.test(trimmed);
}

function lineStartsWithUrlChar(text: string): boolean {
  const m = text.match(/\S/);
  return !!m && URL_CHAR.test(m[0]);
}

interface Segment { row: number; col: number; len: number; }

function buildLogicalText(term: Terminal, anchor: number): { text: string; segments: Segment[] } {
  const buffer = term.buffer.active;
  const total = buffer.length;

  let start = anchor;
  while (start > 0) {
    const cur = buffer.getLine(start);
    const prev = buffer.getLine(start - 1);
    if (!cur || !prev) break;
    if (cur.isWrapped) { start--; continue; }
    const curText = cur.translateToString(true);
    if (!lineStartsWithUrlChar(curText)) break;
    let probe = start - 1;
    let accum = '';
    while (probe >= 0) {
      const pl = buffer.getLine(probe);
      if (!pl) break;
      accum = pl.translateToString(true).replace(/^\s+/, '') + accum;
      if (/https?:\/\//.test(accum)) break;
      if (probe > 0 && buffer.getLine(probe)?.isWrapped) { probe--; continue; }
      probe--;
    }
    const prevTrimmedRight = prev.translateToString(true);
    const merged = accum.replace(/\s+$/, '');
    if (endsMidUrl(prevTrimmedRight) || /https?:\/\/\S*$/.test(merged)) { start--; continue; }
    break;
  }

  const segments: Segment[] = [];
  let text = '';
  let row = start;
  while (row < total) {
    const line = buffer.getLine(row);
    if (!line) break;
    const isContinuation = row !== start;
    if (isContinuation) {
      const curTextTrimmed = line.translateToString(true);
      if (line.isWrapped) {
        const piece = line.translateToString(false);
        segments.push({ row, col: 1, len: piece.length });
        text += piece;
      } else if (lineStartsWithUrlChar(curTextTrimmed) && /https?:\/\/\S*$/.test(text.replace(/\s+$/, ''))) {
        const raw = line.translateToString(false);
        const leadingSpaces = raw.match(/^\s*/)?.[0].length ?? 0;
        const piece = raw.slice(leadingSpaces).replace(/\s+$/, '');
        segments.push({ row, col: leadingSpaces + 1, len: piece.length });
        text += piece;
      } else {
        break;
      }
    } else {
      const piece = line.translateToString(false);
      segments.push({ row, col: 1, len: piece.length });
      text += piece;
    }
    row++;
  }
  return { text, segments };
}

function indexToCoord(segments: Segment[], idx: number): { row: number; col: number } | null {
  let acc = 0;
  for (const seg of segments) {
    if (idx < acc + seg.len) {
      return { row: seg.row + 1, col: seg.col + (idx - acc) };
    }
    acc += seg.len;
  }
  if (segments.length > 0 && idx === acc) {
    const last = segments[segments.length - 1];
    return { row: last.row + 1, col: last.col + last.len - 1 };
  }
  return null;
}

export function registerWrappedLinkProvider(
  term: Terminal,
  handler: (uri: string, e: MouseEvent) => void,
): IDisposable {
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const buffer = term.buffer.active;
      const rowIndex = y - 1;
      if (rowIndex < 0 || rowIndex >= buffer.length) {
        callback(undefined);
        return;
      }

      const { text, segments } = buildLogicalText(term, rowIndex);
      if (!text) { callback(undefined); return; }

      const links: ILink[] = [];
      URL_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = URL_REGEX.exec(text)) !== null) {
        const uri = match[0].replace(TRAILING_PUNCT, '');
        if (!uri) continue;
        const startIdx = match.index;
        const endIdx = startIdx + uri.length - 1;
        const startCoord = indexToCoord(segments, startIdx);
        const endCoord = indexToCoord(segments, endIdx);
        if (!startCoord || !endCoord) continue;
        if (startCoord.row <= y && endCoord.row >= y) {
          links.push({
            range: {
              start: { x: startCoord.col, y: startCoord.row },
              end: { x: endCoord.col, y: endCoord.row },
            },
            text: uri,
            activate: (e, u) => handler(u, e),
          });
        }
      }
      callback(links.length ? links : undefined);
    },
  };
  return term.registerLinkProvider(provider);
}

/**
 * A URL clicked in a terminal opens as a TAB of the Topics browser, beside the
 * terminal that printed it (`nearPaneId`), instead of throwing the user out to
 * the system browser. Cmd/Ctrl-click and the middle button still leave the app.
 *
 * `paneId` is optional because the provider is also registered by surfaces that
 * do not know their pane; without it the tab still opens, just wherever the
 * window's browser strip already is.
 */
export function openTerminalLink(uri: string, paneId?: string, e?: MouseEvent): void {
  openLink(uri, {
    external: e ? isExternalLinkGesture(e) : false,
    nearPaneId: paneId,
    origin: e?.target ?? null,
  });
}
