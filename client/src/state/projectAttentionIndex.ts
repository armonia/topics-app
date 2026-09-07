import type { Topic } from '../types';

/**
 * The children of ONE project, without walking the whole topic map.
 *
 * The two project rollups in `signals.ts` (`projectAttentionTier` and
 * `projectAttentionSubjects`, and through it `rollupProjectAttention`) used to
 * scan `Object.values(topics)` on every call, and the map is mostly archive: on the workspace this was measured on,
 * 1,588 topics for 17 live ones. The sidebar and the tab bar call them once per
 * project on every activity tick of any session, so the cost is paid again for
 * children that are never even candidates.
 *
 * The index is keyed by the IDENTITY of the topics map, which is what makes it
 * safe: that map is a `useMemo` over the buckets (`useTopics`, mergeBuckets),
 * so a new topic, an archive, a rename all produce a NEW object and therefore a
 * new index. A WeakMap so an old map takes its index away with it when it is
 * collected. It holds only while nobody MUTATES a topics map in place - the app
 * never does, and the parity test pins the archived/unarchived case.
 *
 * Archived children are filtered here because both callers filter them, for the
 * same documented reason. `standalone` is NOT filtered here: it is out of the
 * tier and IN the subjects, so it stays where that asymmetry is written.
 */
const projectChildrenIndex = new WeakMap<Record<string, Topic>, Map<string, Topic[]>>();
const EMPTY_TOPICS: readonly Topic[] = [];

export function liveTopicsOfProject(topics: Record<string, Topic>, projectPath: string): readonly Topic[] {
  let index = projectChildrenIndex.get(topics);
  if (!index) {
    index = new Map<string, Topic[]>();
    for (const t of Object.values(topics)) {
      if (t.archived) continue;
      if (t.projectPath == null) continue;
      const bucket = index.get(t.projectPath);
      if (bucket) bucket.push(t);
      else index.set(t.projectPath, [t]);
    }
    projectChildrenIndex.set(topics, index);
  }
  return index.get(projectPath) ?? EMPTY_TOPICS;
}
