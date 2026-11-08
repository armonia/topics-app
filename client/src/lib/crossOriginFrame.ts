/** Returns the visible host for an unrecorded frame from another web origin. */
export function crossOriginFrameHost(rrSrc: unknown, pageUrl: unknown): string | null {
  if (typeof rrSrc !== 'string' || typeof pageUrl !== 'string' || !rrSrc.trim() || !pageUrl.trim()) return null;
  try {
    const frame = new URL(rrSrc, pageUrl);
    const page = new URL(pageUrl);
    if (!['http:', 'https:'].includes(frame.protocol) || !['http:', 'https:'].includes(page.protocol)) return null;
    return frame.origin === page.origin ? null : frame.host;
  } catch {
    return null;
  }
}
