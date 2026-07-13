/**
 * Pure project-reference matcher.
 *
 * Resolves a human reference to a project ("Pix", "topics-app", a workspace
 * name) against a set of candidate projects, WITHOUT touching the filesystem.
 * The fs-aware wrapper (resolveProjectRef in routes/topics.ts) builds the
 * candidate list from the real Topics projectStore, topic-bound projectPaths,
 * and the OpenClaw workspace, then validates the winning path on disk.
 *
 * Matching is case-insensitive and tries, in order: exact slug, exact name,
 * folder basename. Absolute and `~/` paths are handled by the caller — this
 * function only deals with bare name/slug references.
 */

export interface ProjectRefCandidate {
  /** Absolute directory of the project. */
  path: string;
  /** Display name, when known (e.g. a Topics project name). */
  name?: string;
  /** Stable slug, when known. */
  slug?: string;
}

/** Lowercased final path segment, e.g. "/a/b/Pix" -> "pix". */
function basename(p: string): string {
  const segs = p.split("/").filter(Boolean);
  return (segs[segs.length - 1] || "").toLowerCase();
}

/**
 * Return EVERY candidate path matching `ref`, strongest tier first (exact slug,
 * then exact name, then folder basename; candidate order within a tier),
 * deduped. Ambiguous references — two projects sharing a basename, e.g. a real
 * repo and a stale workspace husk both called "topics-app" — return ALL of
 * them so the fs-aware caller can pick the one that actually looks like a
 * project instead of whichever happened to iterate first.
 *
 * @param ref      bare project reference (not an absolute/`~` path)
 * @param candidates ordered by preference — earlier wins on a tie
 * @param slugify  the same slugify the store uses, so "My App" === "my-app"
 */
export function matchProjectRefAll(
  ref: string,
  candidates: ProjectRefCandidate[],
  slugify: (s: string) => string,
): string[] {
  const raw = (ref || "").trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const slug = slugify(raw);

  const out: string[] = [];
  const push = (p: string) => { if (!out.includes(p)) out.push(p); };

  // Three passes, strongest signal first, so a real slug match always beats a
  // coincidental basename match further down the candidate list.
  for (const c of candidates) if (c.slug && c.slug === slug) push(c.path);
  for (const c of candidates) if (c.name && c.name.toLowerCase() === lower) push(c.path);
  for (const c of candidates) if (basename(c.path) === lower) push(c.path);

  return out;
}

/** First match of `matchProjectRefAll`, or null. */
export function matchProjectRef(
  ref: string,
  candidates: ProjectRefCandidate[],
  slugify: (s: string) => string,
): string | null {
  return matchProjectRefAll(ref, candidates, slugify)[0] ?? null;
}
