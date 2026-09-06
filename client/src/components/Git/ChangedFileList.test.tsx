/**
 * THE ONE LIST, AS IT RENDERS.
 *
 * Four surfaces used to draw this list, and the drift between them was not
 * cosmetic: the delivery chip showed `+/-` for a file it never said had been
 * DELETED, and the chat strip cut the path from the right, eating the file
 * name -- the only part of a path anybody is looking for.
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo): what is asserted
 * is the markup, which is what the e2e locators (`changed-file-row`) look for
 * on both surfaces.
 *
 * @covers GIT-FILELIST-01
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChangedFileEntry, ChangedFileList } from './ChangedFileList';
import type { ChangedFileRow } from './changedFiles';

const row = (over: Partial<ChangedFileRow> = {}): ChangedFileRow => ({
  path: 'client/src/components/Board/Card.tsx',
  status: 'modified',
  added: 12,
  removed: 3,
  ...over,
});

describe('a row', () => {
  test('says WHAT happened with a letter, before saying how much', () => {
    expect(renderToStaticMarkup(<ChangedFileEntry row={row({ status: 'added' })} />)).toContain('data-changed-file-mark="A"');
    expect(renderToStaticMarkup(<ChangedFileEntry row={row({ status: 'deleted' })} />)).toContain('data-changed-file-mark="D"');
    expect(renderToStaticMarkup(<ChangedFileEntry row={row({ status: 'untracked' })} />)).toContain('data-changed-file-mark="U"');
  });

  test('a conflict shows its raw code, so one letter never stands for two states', () => {
    const html = renderToStaticMarkup(<ChangedFileEntry row={row({ status: 'conflicted', code: 'UU' })} />);
    expect(html).toContain('data-changed-file-mark="UU"');
  });

  test('the NAME is whole and the folder is what elides, from the left', () => {
    const html = renderToStaticMarkup(<ChangedFileEntry row={row()} />);
    expect(html).toContain('Card.tsx');
    // The folder loses its trailing slash and gets the marker that makes an
    // rtl-elided run read left to right.
    expect(html).toContain('client/src/components/Board');
    expect(html).toContain('path-elide-left');
    // The cut is the folder's, never the name's: nothing wraps the two in a
    // single `truncate`.
    expect(html).not.toContain('client/src/components/Board/Card.tsx<');
  });

  test('a rename says where it came from', () => {
    const html = renderToStaticMarkup(<ChangedFileEntry row={row({ status: 'renamed', origPath: 'old/Name.tsx' })} />);
    expect(html).toContain('line-through');
    expect(html).toContain('Name.tsx');
  });

  test('a binary file says so instead of claiming lines', () => {
    const html = renderToStaticMarkup(<ChangedFileEntry row={row({ binary: true, added: undefined, removed: undefined })} />);
    expect(html).toContain('bin');
    expect(html).not.toContain('+0');
  });

  test('no counts means SILENCE, not "+0 -0"', () => {
    const html = renderToStaticMarkup(<ChangedFileEntry row={row({ added: undefined, removed: undefined })} />);
    // The counts cell is not rendered at all: no number, not a zero.
    expect(html).not.toContain('tabular-nums');
    expect(html).not.toContain('>+');
  });
});

describe('the list', () => {
  const many = Array.from({ length: 15 }, (_, i) => row({ path: `src/file-${i}.ts` }));

  test('rows are buttons when there is a diff to open, and carry their path', () => {
    const html = renderToStaticMarkup(<ChangedFileList rows={[row()]} onOpen={() => {}} />);
    expect(html).toContain('data-testid="changed-file-row"');
    expect(html).toContain('data-path="client/src/components/Board/Card.tsx"');
    expect(html).toContain('<button');
  });

  test('without a handler the rows stop being buttons', () => {
    const html = renderToStaticMarkup(<ChangedFileList rows={[row()]} />);
    expect(html).toContain('data-testid="changed-file-row"');
    expect(html).not.toContain('<button');
  });

  test('the tail is DECLARED: a list cut in silence looks complete', () => {
    const html = renderToStaticMarkup(<ChangedFileList rows={many} />);
    expect(html.match(/data-testid="changed-file-row"/g)).toHaveLength(12);
    expect(html).toContain('3');
  });

  test('loading, error and empty are three different sentences', () => {
    expect(renderToStaticMarkup(<ChangedFileList rows={null} loading />)).not.toContain('changed-file-row');
    expect(renderToStaticMarkup(<ChangedFileList rows={null} error />)).toContain('text-red-600');
    // Not read yet is NOT "nothing changed": with no rows and no state, the
    // list says nothing at all.
    expect(renderToStaticMarkup(<ChangedFileList rows={null} />)).toBe('<div data-testid="changed-file-list"></div>');
    expect(renderToStaticMarkup(<ChangedFileList rows={[]} emptyLabel="niente qui" />)).toContain('niente qui');
  });

  test('the test id follows the surface, so two lists on screen stay apart', () => {
    expect(renderToStaticMarkup(<ChangedFileList rows={[]} testId="chat-changes-list" />)).toContain('data-testid="chat-changes-list"');
  });
});
