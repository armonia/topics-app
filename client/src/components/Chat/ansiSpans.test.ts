/**
 * THE OUTPUT OF A COMMAND, READ AS A TERMINAL SHOWS IT.
 *
 * SGR colours and styles become spans the renderer draws as text; every other
 * escape sequence is dropped; of a line redrawn with `\r` the last redraw is
 * kept; and the text stays text, never markup.
 * @covers CHAT-RUN-03
 */
import { describe, expect, test } from 'bun:test';
import { ansiLines, plainLines, ANSI_PALETTE } from './ansiSpans';

const ESC = '\u001b';

describe('ansiLines', () => {
  test('plain text is one span per line, with no style', () => {
    expect(ansiLines('a\nb')).toEqual([[{ text: 'a' }], [{ text: 'b' }]]);
  });

  test('the empty line after a final newline is not a line', () => {
    expect(ansiLines('a\n')).toEqual([[{ text: 'a' }]]);
    expect(ansiLines('')).toEqual([]);
  });

  test('SGR 31 colours the text up to the reset, and the rest stays plain', () => {
    expect(ansiLines(`${ESC}[31mrosso${ESC}[0m ok`)).toEqual([[{ text: 'rosso', fg: ANSI_PALETTE[1] }, { text: ' ok' }]]);
  });

  test('bright, background, bold, dim, italic and underline', () => {
    expect(ansiLines(`${ESC}[1;92;44mx${ESC}[22;2;3;4my`)).toEqual([[
      { text: 'x', fg: ANSI_PALETTE[10], bg: ANSI_PALETTE[4], bold: true },
      { text: 'y', fg: ANSI_PALETTE[10], bg: ANSI_PALETTE[4], dim: true, italic: true, underline: true },
    ]]);
  });

  test('256 colours: the palette, the cube and the grey ramp', () => {
    expect(ansiLines(`${ESC}[38;5;9ma`)[0]![0]!.fg).toBe(ANSI_PALETTE[9]);
    expect(ansiLines(`${ESC}[38;5;196ma`)[0]![0]!.fg).toBe('rgb(255,0,0)');
    expect(ansiLines(`${ESC}[48;5;232ma`)[0]![0]!.bg).toBe('rgb(8,8,8)');
  });

  test('truecolor', () => {
    expect(ansiLines(`${ESC}[38;2;10;20;30ma`)[0]![0]!.fg).toBe('rgb(10,20,30)');
  });

  test('39 and 49 put the default colours back', () => {
    expect(ansiLines(`${ESC}[31;42ma${ESC}[39mb${ESC}[49mc`)).toEqual([[
      { text: 'a', fg: ANSI_PALETTE[1], bg: ANSI_PALETTE[2] },
      { text: 'b', bg: ANSI_PALETTE[2] },
      { text: 'c' },
    ]]);
  });

  test('a style carries over to the next line, as in a terminal', () => {
    expect(ansiLines(`${ESC}[33mone\ntwo${ESC}[m`)).toEqual([[{ text: 'one', fg: ANSI_PALETTE[3] }], [{ text: 'two', fg: ANSI_PALETTE[3] }]]);
  });

  test('other CSI sequences and OSC are dropped, and no SGR fragment is left in the text', () => {
    const out = ansiLines(`${ESC}[2K${ESC}[1Gdone${ESC}]0;title${ESC}\\ ${ESC}]8;;https://x${ESC}\\link${ESC}]8;;${ESC}\\ ${ESC}[?25h`);
    expect(out).toEqual([[{ text: 'done link ' }]]);
  });

  test('of a line redrawn with \\r the last redraw is kept, and CRLF does not blank it', () => {
    expect(ansiLines('10%\r50%\r100%\nnext')).toEqual([[{ text: '100%' }], [{ text: 'next' }]]);
    expect(ansiLines('a\r\nb\r\n')).toEqual([[{ text: 'a' }], [{ text: 'b' }]]);
  });

  test('markup in the output stays text', () => {
    expect(ansiLines('<img src=x onerror=alert(1)>')).toEqual([[{ text: '<img src=x onerror=alert(1)>' }]]);
  });

  test('stray control bytes are dropped, a tab is kept', () => {
    expect(ansiLines('a\u0007b\tc')).toEqual([[{ text: 'ab\tc' }]]);
  });
});

describe('plainLines', () => {
  test('the text of each line, without any escape', () => {
    expect(plainLines(`${ESC}[31mrosso${ESC}[0m ok\n50%\r100%\n`)).toEqual(['rosso ok', '100%']);
  });
});
