/**
 * A command's output as a terminal shows it, as data the renderer draws as
 * text spans (CHAT-RUN-03). Never markup: the output is somebody else's bytes.
 *
 * SGR becomes style (16, 256 and truecolor, bold, dim, italic, underline);
 * every other escape sequence is dropped (cursor moves, line erases, titles,
 * hyperlinks), and so is any stray control byte but the tab. Of a line redrawn
 * with `\r` (a progress bar, `curl`) the last non-empty redraw is kept, which
 * is what a terminal leaves on screen, and a CRLF line does not turn blank.
 */

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
}
export interface AnsiSpan extends AnsiStyle { text: string }

/** The 16 base colours, tuned for the dark code background the output sits on. */
export const ANSI_PALETTE: readonly string[] = [
  '#3b3f4a', '#f2777a', '#99cc99', '#ffcc66', '#6699cc', '#cc99cc', '#66cccc', '#d3d0c8',
  '#747369', '#ff8f8f', '#b5e0a0', '#ffe08a', '#8fb8e8', '#e0b3e0', '#8ce0e0', '#f2f0ec',
];

// The escape byte is what these patterns exist to find and remove: control
// characters are their subject, not a mistake (same reason as ProcessLogPane).
// CSI (`ESC [ params intermediates final`), OSC up to BEL or ST, charset
// selections, and any other two-byte escape; a lone ESC goes too.
// eslint-disable-next-line no-control-regex -- matching ESC is the point: these sequences are removed or turned into style
const ESCAPE = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][\s\S]*?(?:\u0007|\u001b\\)|[()#][\w]|[@-Z\\-_])?/g;
// eslint-disable-next-line no-control-regex -- stray C0 control bytes (all but tab) are dropped from the visible text
const STRAY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function color256(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return ANSI_PALETTE[n];
  if (n < 232) {
    const c = n - 16;
    const level = (v: number) => (v ? 55 + v * 40 : 0);
    return `rgb(${level(Math.floor(c / 36))},${level(Math.floor(c / 6) % 6)},${level(c % 6)})`;
  }
  const grey = 8 + (n - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
}

/** An extended colour (`38;5;n` or `38;2;r;g;b`) starting at `codes[i]`; returns the colour and how many codes it used. */
function extendedColor(codes: number[], i: number): [string | undefined, number] {
  if (codes[i] === 5) return [color256(codes[i + 1] ?? -1), 2];
  if (codes[i] === 2) {
    const [r, g, b] = [codes[i + 1], codes[i + 2], codes[i + 3]].map((v) => Math.max(0, Math.min(255, v ?? 0)));
    return [`rgb(${r},${g},${b})`, 4];
  }
  return [undefined, 1];
}

function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)));
  let s: AnsiStyle = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) s = {};
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 22) { delete s.bold; delete s.dim; }
    else if (c === 23) delete s.italic;
    else if (c === 24) delete s.underline;
    else if (c >= 30 && c <= 37) s.fg = ANSI_PALETTE[c - 30];
    else if (c >= 90 && c <= 97) s.fg = ANSI_PALETTE[c - 90 + 8];
    else if (c === 39) delete s.fg;
    else if (c >= 40 && c <= 47) s.bg = ANSI_PALETTE[c - 40];
    else if (c >= 100 && c <= 107) s.bg = ANSI_PALETTE[c - 100 + 8];
    else if (c === 49) delete s.bg;
    else if (c === 38 || c === 48) {
      const [color, used] = extendedColor(codes, i + 1);
      if (color) s[c === 38 ? 'fg' : 'bg'] = color;
      i += used;
    }
  }
  return s;
}

const sameStyle = (a: AnsiStyle, b: AnsiStyle) =>
  a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline;

/**
 * Walk one `\r` segment: SGR updates `state.style`; when `emit` is given, the
 * visible text goes into it as spans.
 */
function walk(segment: string, state: { style: AnsiStyle }, emit?: AnsiSpan[]): void {
  const push = (raw: string) => {
    const text = raw.replace(STRAY_CONTROL, '');
    if (!text || !emit) return;
    const last = emit[emit.length - 1];
    if (last && sameStyle(last, state.style)) last.text += text;
    else emit.push({ ...state.style, text });
  };
  let at = 0;
  for (const m of segment.matchAll(ESCAPE)) {
    push(segment.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[2] === 'm' && !/[<=>?]/.test(m[1] ?? '')) state.style = applySgr(state.style, m[1] ?? '');
  }
  push(segment.slice(at));
}

const visible = (segment: string) => segment.replace(ESCAPE, '').replace(STRAY_CONTROL, '') !== '';

/** The output as lines of styled spans. */
export function ansiLines(text: string): AnsiSpan[][] {
  if (!text) return [];
  const raw = text.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  const state = { style: {} as AnsiStyle };
  return raw.map((line) => {
    const segments = line.split('\r');
    let shown = segments.length - 1;
    while (shown > 0 && !visible(segments[shown]!)) shown--;
    const spans: AnsiSpan[] = [];
    segments.forEach((seg, i) => walk(seg, state, i === shown ? spans : undefined));
    return spans;
  });
}

/** The output's lines as plain text, without any escape: what goes to the agent. */
export function plainLines(text: string): string[] {
  return ansiLines(text).map((spans) => spans.map((s) => s.text).join(''));
}
