/** Shared formatting for the reading surfaces. Small on purpose. */

export const FORMAT_LABEL: Record<string, string> = {
  'deep-dive': 'Deep dive',
  'field-notes': 'Field notes',
  recipe: 'Recipe',
  migration: 'Migration',
  narrative: 'Notebook',
  comparison: 'Comparison',
};

export const PILLAR_LABEL: Record<string, string> = {
  'parallel-agents': 'Several agents, one repository',
  worktrees: 'Worktrees and landing',
  cost: 'What agents cost',
  substrate: 'The substrate',
  performance: 'What the shell costs to run',
  protocols: 'Protocols and the toolchain',
};

/** en-GB with a spelled month: unambiguous for both sides of the Atlantic. */
export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * 220 words a minute, which is the low end of adult silent reading and about
 * right for prose carrying code and numbers. Rounded up, never zero.
 */
export function readingTime(words: number): string {
  return `${Math.max(1, Math.ceil(words / 220))} min read`;
}
