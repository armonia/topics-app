import { useState, useEffect, type ReactNode } from 'react';

/**
 * ProjectFavicon — shows a project's real icon when its folder ships one
 * (favicon.*, public/icon.*, a web manifest's icons[], or an index.html
 * <link rel="icon">), resolved + served by GET /api/projects/icon. Projects
 * without an icon (most non-web folders) render `fallback` (default: nothing),
 * preserving the app's "no fake folder glyph" convention.
 *
 * The 404 for icon-less projects is cached by the server, so re-opening the
 * palette / re-rendering the sidebar doesn't re-probe disk.
 */
export function ProjectFavicon({
  path,
  size = 14,
  className = '',
  fallback = null,
}: {
  path: string;
  size?: number;
  className?: string;
  fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  // A row can be recycled for a different project (virtualised lists, memo
  // reuse) — reset the error state when the path changes.
  useEffect(() => { setFailed(false); }, [path]);

  if (failed || !path) return <>{fallback}</>;
  return (
    <img
      src={`/api/projects/icon?path=${encodeURIComponent(path)}`}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={`rounded-[3px] object-contain flex-shrink-0 ${className}`}
      onError={() => setFailed(true)}
    />
  );
}
