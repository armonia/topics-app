/**
 * The gestures that turn a clipboard or a drag into board attachments.
 *
 * They are one module because the SAME two gestures now exist on two surfaces
 * (the composer that creates a task, the thread of a card): the point of these
 * tests is what each gesture LETS THROUGH, because letting too much through is
 * how the board would lose its own drag and drop under this one.
 * @covers KANBAN-05
 */
import { test, expect, describe } from 'bun:test';
import { dragCarriesFiles, filesFromDrop, imagesFromClipboard } from './attachments';

/** A DataTransfer as the browser hands it to a paste/drop handler. */
function transfer(opts: {
  items?: Array<{ kind: string; type: string; file?: File }>;
  files?: File[];
  types?: string[];
}): DataTransfer {
  return {
    items: (opts.items ?? []).map((i) => ({ kind: i.kind, type: i.type, getAsFile: () => i.file ?? null })),
    files: opts.files ?? [],
    types: opts.types ?? [],
  } as unknown as DataTransfer;
}

const png = new File(['x'], 'shot.png', { type: 'image/png' });
const pdf = new File(['x'], 'spec.pdf', { type: 'application/pdf' });

describe('composer attachments', () => {
  test('a pasted screenshot is an image; pasted text is not', () => {
    const data = transfer({
      items: [
        { kind: 'string', type: 'text/plain' },
        { kind: 'file', type: 'image/png', file: png },
      ],
    });
    expect(imagesFromClipboard(data).map((f) => f.name)).toEqual(['shot.png']);
  });

  test('a paste of plain text alone yields nothing, so the paste stays a paste', () => {
    const data = transfer({ items: [{ kind: 'string', type: 'text/plain' }] });
    expect(imagesFromClipboard(data)).toEqual([]);
    expect(imagesFromClipboard(null)).toEqual([]);
  });

  test('a dropped file is taken whatever its type: a PDF is an attachment too', () => {
    expect(filesFromDrop(transfer({ files: [png, pdf] })).map((f) => f.name)).toEqual(['shot.png', 'spec.pdf']);
    expect(filesFromDrop(null)).toEqual([]);
  });

  test('only a drag carrying files wakes the drop zone (a pane being moved does not)', () => {
    expect(dragCarriesFiles(transfer({ types: ['Files'] }))).toBe(true);
    expect(dragCarriesFiles(transfer({ types: ['application/x-topics-panel'] }))).toBe(false);
    expect(dragCarriesFiles(transfer({ types: [] }))).toBe(false);
    expect(dragCarriesFiles(null)).toBe(false);
  });
});
