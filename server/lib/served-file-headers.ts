// served-file-headers.ts — how a file that SOMEONE ELSE wrote goes out over the
// app's own origin.
//
// WHY IT IS A MODULE AND NOT THREE LINES IN THE ROUTE. `/uploads/` decided
// inline-vs-attachment with `/^(image|video|audio)\//.test(mime)`, and
// `image/svg+xml` passes that test. An SVG is a document: navigated to
// directly, its inline `<script>` runs on the app origin with the session. The
// comment above that line already named `.svg` as the payload it defended
// against, and the correct pattern already existed 40 lines below for the
// browser-pane downloads — the two copies had simply drifted. One function, one
// list, and a test that can execute the decision.
//
// `X-Content-Type-Options: nosniff` is not a defence here and never was: it
// forbids the browser from GUESSING a type, and the declared type IS the
// executable one. The only things that work are refusing to declare it
// (`application/octet-stream`), refusing to render it in place (`attachment`)
// and refusing it an origin (`Content-Security-Policy: sandbox`).

/**
 * Strip parameters and case from a MIME so a comparison means something.
 *
 * `getMimeType` is a static table today, but Bun's `formData()` hands back
 * `text/html;charset=utf-8`, and any list compared against the raw string is a
 * list with a hole in it exactly where the dangerous types are.
 */
export function normalizeMime(raw: string): string {
  return (raw.split(";", 1)[0] || "").trim().toLowerCase();
}

/**
 * Types a browser will EXECUTE on the origin that served them.
 *
 * A deny list and not an allow list on purpose: an unknown extension arrives as
 * `application/octet-stream`, which is already inert, so the list only has to
 * name what is dangerous, and an attachment nobody anticipated still downloads
 * instead of being refused.
 */
export const ACTIVE_CONTENT_MIMES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "application/xslt+xml",
  "text/vtt",
]);

/** True when serving this type inline would hand the origin to its author. */
export function isActiveContent(mime: string): boolean {
  return ACTIVE_CONTENT_MIMES.has(normalizeMime(mime));
}

/**
 * Only media is worth rendering in place; everything else downloads.
 *
 * Active content is subtracted FIRST, so the media test can never re-admit an
 * SVG the way it used to.
 */
export function isInlineSafe(mime: string): boolean {
  const m = normalizeMime(mime);
  if (isActiveContent(m)) return false;
  return /^(image|video|audio)\//.test(m) || m === "application/pdf";
}

/** A filename that cannot break out of the `filename="…"` quotes. */
export function sanitizeDispositionName(name: string): string {
  return (name || "file").replace(/["\\\r\n]/g, "_");
}

/**
 * The full header set for a stored file served from the app's own origin.
 *
 * Active content loses its declared type as well as its `inline`: a
 * `Content-Disposition: attachment` alone still lets a `fetch()` from a
 * same-origin page read it, and leaves the door open for the next reader of
 * this code to "fix" the type back.
 */
export function servedFileHeaders(args: {
  mime: string;
  filename: string;
  cacheControl: string;
}): Record<string, string> {
  const mime = normalizeMime(args.mime);
  const active = isActiveContent(mime);
  const name = sanitizeDispositionName(args.filename);
  const headers: Record<string, string> = {
    "Content-Type": active ? "application/octet-stream" : mime,
    "Cache-Control": args.cacheControl,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": isInlineSafe(mime) ? "inline" : `attachment; filename="${name}"`,
  };
  if (active) headers["Content-Security-Policy"] = "sandbox";
  return headers;
}
