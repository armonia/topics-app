/**
 * A web page, reduced to the part a model can actually read.
 *
 * WHY THIS EXISTS AT ALL. `web_fetch` without it hands the model 300 kB of
 * minified markup: the answer is in there, but it costs a fortune to find and
 * the useful text is a rounding error of the payload. The page fetched for this
 * file's own test suite is a fair sample of the ratio: markup in, a page of
 * prose out.
 *
 * IT IS NOT A BROWSER, and the boundary matters more than the feature list. No
 * DOM, no CSS, no scripts: a page that paints its content from JavaScript comes
 * back nearly empty here, and that is honest rather than fixable at this level
 * (whoever needs the rendered DOM has the browser pane, which runs a real
 * engine). What this does is the flat 90%: static pages, documentation, READMEs,
 * API responses, RFCs.
 *
 * WHAT IT KEEPS, and why each one earns its regex. Headings, because they are
 * the map of the document and a model navigates by them. Lists, because a
 * stripped list becomes one run-on paragraph where every item reads like a
 * clause of the previous one. Links WITH their target, because the next move
 * after fetching a page is usually fetching one it points to, and a bare label
 * cannot be followed. Code blocks, protected before any whitespace is touched,
 * because indentation is the content in a code sample.
 *
 * There is already a smaller `htmlToText` in `scripts/mcp-cap-bench`. It is
 * deliberately left alone: that corpus is cached and hashed in a manifest, so
 * changing how it extracts would silently invalidate a benchmark's inputs.
 */

/** Named entities worth decoding by hand. The numeric ones cover the rest. */
const NAMED: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  hellip: "...", mdash: "-", ndash: "-", minus: "-",
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"',
  laquo: "<<", raquo: ">>", middot: "\u00b7", bull: "\u00b7",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", deg: "\u00b0", euro: "\u20ac",
  agrave: "\u00e0", egrave: "\u00e8", eacute: "\u00e9", igrave: "\u00ec",
  ograve: "\u00f2", ugrave: "\u00f9",
};

/**
 * `&amp;` and friends, back to the characters they stand for.
 *
 * An unknown entity is returned UNTOUCHED instead of being dropped: `&foo;` in
 * the source is far more likely to be literal text (a query string, a shell
 * snippet) than a real entity we failed to list.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Tags to text: no structure kept, whitespace collapsed. For inline runs. */
function plain(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** A relative href, made followable. An unresolvable one is left as it stands. */
function absolutize(href: string, baseUrl?: string): string {
  if (!baseUrl) return href;
  try { return new URL(href, baseUrl).toString(); } catch { return href; }
}

export interface ExtractedPage {
  /** The `<title>`, when the page has one. */
  title?: string;
  markdown: string;
}

/**
 * The whole conversion, in the order the steps have to happen.
 *
 * The ORDER is the design here, and every swap of two lines breaks something:
 * comments and dead sections go before anything reads text (a `<script>` full
 * of markup strings would otherwise become prose), `<pre>` is parked before
 * whitespace is normalized, and links are rewritten while they are still tags,
 * because after the generic strip the href is gone.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): ExtractedPage {
  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = rawTitle ? plain(rawTitle) : undefined;

  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // Code blocks are parked whole. They come back at the end, after the passes
  // that collapse runs of spaces and blank lines have finished doing to the
  // prose exactly what must never happen to a code sample.
  const fences: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_whole, inner: string) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
    if (!code) return " ";
    fences.push(code);
    return `\n\n%%TOPICS-FENCE-${fences.length - 1}%%\n\n`;
  });

  s = s
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_whole, level: string, inner: string) => {
      const text = plain(inner);
      return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "\n\n";
    })
    // The label carries the address with it: a link the model cannot follow is
    // a link it might as well not have been told about.
    .replace(/<a\b[^>]*\shref=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
      (whole, dq: string | undefined, sq: string | undefined, bare: string | undefined, inner: string) => {
        const href = (dq ?? sq ?? bare ?? "").trim();
        const text = plain(inner);
        if (!text) return " ";
        if (!href || /^javascript:/i.test(href) || href.startsWith("#")) return ` ${text} `;
        const url = absolutize(decodeEntities(href), baseUrl);
        return text === url ? ` ${url} ` : ` [${text}](${url}) `;
      })
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<\/(p|div|section|article|ul|ol|dl|tr|table|blockquote|h[1-6])>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");

  s = decodeEntities(s)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    // A bullet left empty by a list item that held only an icon or a link we
    // dropped: the dash without its line is noise the model has to read.
    .replace(/^-\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  s = s.replace(/%%TOPICS-FENCE-(\d+)%%/g, (whole, i: string) => {
    const code = fences[Number(i)];
    return code === undefined ? whole : `\`\`\`\n${code}\n\`\`\``;
  });

  return { ...(title ? { title } : {}), markdown: s };
}
