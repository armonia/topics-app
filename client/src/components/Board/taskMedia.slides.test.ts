import { describe, expect, test } from 'bun:test';
import { buildEvidenceSlides } from './taskMedia';

describe('buildEvidenceSlides', () => {
  test('a before file and an after file become one pair slide', () => {
    const s = buildEvidenceSlides(['/m/board-prima.png', '/m/other.png', '/m/board-dopo.png']);
    expect(s).toEqual([
      { kind: 'pair', before: '/m/board-prima.png', after: '/m/board-dopo.png' },
      { kind: 'single', path: '/m/other.png' },
    ]);
  });
  test('a composite file is a side-by-side slide', () => {
    expect(buildEvidenceSlides(['/m/reference-dopo.png'])).toEqual([{ kind: 'sideBySide', path: '/m/reference-dopo.png' }]);
    expect(buildEvidenceSlides(['/m/affianca.png'])[0]!.kind).toBe('sideBySide');
  });
  test('plain files and videos stay single', () => {
    expect(buildEvidenceSlides(['/m/a.png', '/m/b.webm']).map((x) => x.kind)).toEqual(['single', 'single']);
  });
  test('only a before file does not pair', () => {
    expect(buildEvidenceSlides(['/m/prima.png'])[0]!.kind).toBe('single');
  });
});
