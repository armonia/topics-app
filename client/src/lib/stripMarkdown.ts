/**
 * stripMarkdown — turn markdown into clean plain text for COMPACT PREVIEWS
 * (board card last-comment/question, live stream preview). These surfaces are
 * line-clamped one/few-liners where rendering block markdown (headings, lists,
 * code fences) would break the clamp, but showing the RAW syntax (`**Piano**`,
 * `# Piano`) reads as broken formatting. So we drop the syntax markers and keep
 * the words. NOT a full renderer — the drawer thread / plan panel still use
 * ChatMarkdown for real rendering.
 */
export function stripMarkdown(input: string): string {
  if (!input) return "";
  let s = input;

  // Fenced code blocks: drop the ``` lines but keep the code text inside.
  s = s.replace(/```[^\n]*\n?/g, "");
  s = s.replace(/```/g, "");

  // Images before links (image syntax is a superset): ![alt](url) → alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links: [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Process line by line so we can strip leading block markers per line.
  const lines = s.split("\n").map((line) => {
    let l = line;
    l = l.replace(/^\s{0,3}#{1,6}\s+/, "");        // # heading
    l = l.replace(/^\s{0,3}>\s?/, "");             // > blockquote
    l = l.replace(/^\s*[-*+]\s+/, "");             // - / * / + bullet
    l = l.replace(/^\s*\d+[.)]\s+/, "");           // 1. / 1) ordered
    l = l.replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/, ""); // --- horizontal rule → empty
    return l;
  });
  s = lines.join("\n");

  // Inline emphasis / code / strikethrough — remove the markers, keep content.
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");        // bold
  s = s.replace(/(\*|_)(.*?)\1/g, "$2");           // italic
  s = s.replace(/~~(.*?)~~/g, "$1");               // strikethrough
  s = s.replace(/`([^`]+)`/g, "$1");               // inline code

  // Tidy: collapse 3+ newlines, trim trailing spaces per line, trim ends.
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
