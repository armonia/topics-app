/**
 * The changelog, read at build time.
 *
 * It used to be fetched by a script in `public/` and written into the page with
 * `innerHTML`, which cost three things worth having: 127 versions of release
 * notes that no crawler ever saw, a `dateModified` signal that existed only
 * after JavaScript ran, and a visible "Loading…" on the one page whose entire
 * job is to show a list. None of it needs to be dynamic — the data is generated
 * by `bun run changelog` and committed.
 *
 * The shape is validated on read rather than trusted. This file is produced by
 * a script in another part of the repo, and a build that renders `undefined`
 * into 127 list items is worse than one that stops.
 */
import raw from '../data/changelog.json';

export interface ChangelogEntry {
  text: string;
  scope?: string;
}
export interface ChangelogVersion {
  version: string;
  date?: string;
  sections: {
    new: ChangelogEntry[];
    fixes: ChangelogEntry[];
    perf: ChangelogEntry[];
  };
}

/** Render order, and the label each bucket gets. */
export const SECTIONS = [
  ['new', 'New'],
  ['fixes', 'Fixes'],
  ['perf', 'Performance'],
] as const;

function assertShape(data: unknown): asserts data is ChangelogVersion[] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('changelog.json: expected a non-empty array');
  }
  const first = data[0] as Partial<ChangelogVersion>;
  if (typeof first?.version !== 'string' || typeof first?.sections !== 'object') {
    throw new Error('changelog.json: first entry has no version or sections — has the generator changed shape?');
  }
}

assertShape(raw);
const all: ChangelogVersion[] = raw;

/** Newest first, optionally capped. `limit` of 0 or undefined means all of it. */
export function versions(limit?: number): ChangelogVersion[] {
  const list = all.filter(
    (v) => v.sections.new.length + v.sections.fixes.length + v.sections.perf.length > 0,
  );
  return limit ? list.slice(0, limit) : list;
}

/** The date of the newest release, for `dateModified` and the page furniture. */
export function latestDate(): string | undefined {
  return all.find((v) => v.date)?.date;
}
