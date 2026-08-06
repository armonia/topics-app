import { useEffect, useState, type ReactNode } from 'react';
import { reportImgError, useProjectIcon } from './projectIconStore';

/**
 * ProjectFavicon — shows a project's real icon when its folder ships one
 * (favicon.*, public/icon.*, a web manifest's icons[], an index.html
 * <link rel="icon"> — file or inline data: URI — or a loosely-named logo),
 * resolved + served by GET /api/projects/icon.
 *
 * Projects WITHOUT a real icon render `fallback` (default: NOTHING — no
 * element, no reserved width, zero horizontal footprint). This is a hard
 * product decision (Attilio, 2026-07-16, reconfirmed after a monogram-tile
 * experiment was rejected): only a REAL shipped icon earns the space; no
 * letters, no generated tiles, no generic glyphs. Don't reintroduce synthetic
 * placeholders here.
 *
 * La risoluzione (cache, sonda single-flight, recupero via blob) vive in
 * `projectIconStore.ts`: una sola sonda per path, condivisa da ogni superficie.
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
  /** Rendered when the project has no icon file. Default null = nothing at
   *  all (zero footprint); pass a custom node (e.g. a status dot) to opt in. */
  fallback?: ReactNode;
}) {
  const { status, src } = useProjectIcon(path);
  const [loaded, setLoaded] = useState(false);
  // Reset the decode gate whenever the effective src changes (endpoint → blob
  // recovery, or a recycled row pointing at a new project), so a stale
  // opacity:1 never paints a half-loaded frame.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot gate reset per src change; converges immediately (deps = [src])
  useEffect(() => { setLoaded(false); }, [src]);

  // No path, icon-less, or still probing → render the fallback (or, while
  // probing, nothing): no element, no reserved width, zero footprint. The
  // store flips every subscribed surface to 'has' the moment the probe lands.
  if (!path || status === 'none') return <>{fallback}</>;
  if (status === 'probing' || !src) return null;

  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={`rounded-[3px] object-contain flex-shrink-0 ${className}`}
      style={{
        // The probe already confirmed the icon exists, so the slot is
        // reserved up-front (no layout shift); opacity-until-decode hides the
        // broken-glyph frame an erroring <img> would paint.
        opacity: loaded ? 1 : 0,
      }}
      onLoad={() => setLoaded(true)}
      onError={() => { setLoaded(false); reportImgError(path, src); }}
    />
  );
}
