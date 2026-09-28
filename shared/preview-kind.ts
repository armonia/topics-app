/**
 * What the diff panel can SHOW of a changed file, decided by its extension.
 *
 * One map for both sides, because they answer the same question: the server's
 * byte route (`server/services/task-diff-file.ts`) serves only these
 * extensions, with this Content-Type, and the panel (`Board/UnifiedDiff.tsx`)
 * draws only these as a picture or a rendered page. Two copies would drift, and
 * the drift reads as a broken image: the panel asking for bytes the route
 * refuses.
 *
 * Anything else stays what it was: a text diff, or the "binary" notice for a
 * PDF, a font, an archive. `Editor/fileMedia.tsx` keeps its own list on
 * purpose: it serves `FilePane`, which reads the disk and plays video too.
 */

export type PreviewKind = "image" | "svg" | "markdown";

export interface PreviewType {
  kind: PreviewKind;
  mime: string;
}

const BY_EXTENSION: Record<string, PreviewType> = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  avif: { kind: "image", mime: "image/avif" },
  bmp: { kind: "image", mime: "image/bmp" },
  ico: { kind: "image", mime: "image/x-icon" },
  svg: { kind: "svg", mime: "image/svg+xml" },
  md: { kind: "markdown", mime: "text/markdown; charset=utf-8" },
  markdown: { kind: "markdown", mime: "text/markdown; charset=utf-8" },
};

/** The preview a path gets, or `null` when the panel only has its diff. */
export function previewTypeOf(path: string): PreviewType | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  // `.png` alone is a hidden file with no extension, not a picture.
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}
