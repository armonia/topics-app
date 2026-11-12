import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The drawer lives in `TaskDetail.tsx` and the sibling modules it was split
 * into. Source-scanning tests read it as one text, in this order, so a check
 * written against "the drawer" keeps working wherever a piece sits.
 */
const DRAWER_FILES = [
  'TaskDetail.tsx', 'TaskHeader.tsx', 'TaskMetadata.tsx', 'TaskComments.tsx', 'TaskThread.tsx',
  'TaskChecks.tsx', 'TaskFiles.tsx', 'TaskDeliveryBand.tsx',
];

export function readDrawerSource(boardDir: string): string {
  return DRAWER_FILES.map((f) => readFileSync(join(boardDir, f), 'utf8')).join('\n');
}

describe('readDrawerSource', () => {
  test('reads the whole drawer: the shell and every module split out of it', () => {
    const src = readDrawerSource(import.meta.dir);
    for (const name of ['TaskDetail', 'IdentityCard', 'MetadataCard', 'ThreadRows', 'TaskComposer', 'ChecksSection', 'TaskChangesSection', 'DeliveryPanel']) {
      expect(src).toContain(`function ${name}`);
    }
  });
});
