/**
 * A MultiEdit as ONE unified-diff-shaped text, every edit in it.
 *
 * The edit card has two shapes: before/after for one replacement, and a
 * line-coloured `unifiedDiff`. A MultiEdit used to squeeze into the first
 * shape with only its FIRST edit and a «… and N more edit(s)» tail: the other
 * edits were in the arguments and never on screen. Each edit becomes a hunk
 * here (`@@ edit i/N @@`, then its old lines as `-`, its new lines as `+`),
 * which the card already draws. Not a real `git diff` (there are no line
 * numbers to give), only its shape.
 *
 * Shared because the server boundary and the client fallback both derive the
 * detail (`server/providers/claude/tool-detail.ts`, `Chat/toolDetail.ts`).
 */
export function multiEditUnifiedDiff(edits: ReadonlyArray<Record<string, unknown>>): string {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const lines = (text: string, sign: "-" | "+"): string[] =>
    text ? text.split("\n").map((l) => `${sign}${l}`) : [];
  const out: string[] = [];
  edits.forEach((edit, i) => {
    out.push(`@@ edit ${i + 1}/${edits.length} @@`);
    out.push(...lines(str(edit.old_string ?? edit.old), "-"));
    out.push(...lines(str(edit.new_string ?? edit.new), "+"));
  });
  return out.join("\n");
}
