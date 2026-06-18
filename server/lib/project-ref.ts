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
 * Return the path of the first candidate matching `ref`, or null.
 *
 * @param ref      bare project reference (not an absolute/`~` path)
 * @param candidates ordered by preference — earlier wins on a tie
 * @param slugify  the same slugify the store uses, so "My App" === "my-app"
 */
export function matchProjectRef(
  ref: string,
  candidates: ProjectRefCandidate[],
  slugify: (s: string) => string,
): string | null {
  const raw = (ref || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const slug = slugify(raw);

  // Three passes, strongest signal first, so a real slug match always beats a
  // coincidental basename match further down the candidate list.
  const bySlug = candidates.find((c) => c.slug && c.slug === slug);
  if (bySlug) return bySlug.path;

  const byName = candidates.find((c) => c.name && c.name.toLowerCase() === lower);
  if (byName) return byName.path;

  const byBase = candidates.find((c) => basename(c.path) === lower);
  if (byBase) return byBase.path;

  return null;
}
