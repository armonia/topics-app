/**
 * A long chat message with every markdown construct a block cut must not break,
 * and enough text between them to be cut. Shared by the tests of the block
 * splitter and of the renderer that draws the blocks.
 */
export const paragraph = (n: number) =>
  `Paragraph ${n}: ${'lorem ipsum dolor sit amet, '.repeat(14).trim()} **bold ${n}** and \`code ${n}\` with a [link](https://example.com/${n}).`;

export const LONG_MESSAGE = [
  '# Title',
  paragraph(1), paragraph(2), paragraph(3),
  '## Steps',
  '1. first\n2. second\n\n3. third (a loose ordered list)',
  paragraph(4), paragraph(5),
  '```bash\necho one\n\nnot a heading\n# a comment in the fence\n```',
  '> quote line one\n> quote line two',
  '| a | b |\n| - | - |\n| 1 | 2 |',
  paragraph(6), paragraph(7), paragraph(8),
  '- [ ] todo\n- [x] done',
  '    indented code\n    more of it',
  'Setext\n======',
  '---',
  '~~~python\nprint(1)\n\nprint(2)\n~~~',
  paragraph(9), paragraph(10), paragraph(11),
  '```mermaid\ngraph TD\n  A-->B\n```',
  '1. item\n\n   continued paragraph\n\n2. second item',
  paragraph(12), paragraph(13), paragraph(14),
  '```bash\necho two\n```',
  paragraph(15),
].join('\n\n') + '\n';
