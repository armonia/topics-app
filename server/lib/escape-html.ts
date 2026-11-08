/**
 * The one HTML/XML text escape. Escapes the five characters that break a
 * document or an attribute. `&` goes first, or the entities just written would
 * be escaped again. The apostrophe is `&#39;`, valid in HTML and in XML (SVG)
 * alike, so no caller needs its own variant.
 */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
