/**
 * Escapes the five characters that break HTML text, attribute values and XML
 * (SVG) alike. `&` goes first, or the entities just written would be escaped
 * again. The apostrophe becomes `&#39;`: a numeric reference is valid in both
 * HTML and XML, while `&apos;` is not an HTML 4 entity.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
