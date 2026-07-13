import { useState, useEffect, type ReactNode } from 'react';
import { hashToColor, getProjectName } from '../Layout/projectColors';

/**
 * ProjectFavicon — shows a project's real icon when its folder ships one
 * (favicon.*, public/icon.*, a web manifest's icons[], or an index.html
 * <link rel="icon">), resolved + served by GET /api/projects/icon. Projects
 * without an icon (most non-web folders) render `fallback` (default: nothing),
 * preserving the app's "no fake folder glyph" convention.
 */

// Client-side cache of which project paths actually ship an icon. Without it,
// every fresh load (e.g. an Electron app update / reload) re-discovers "this
// folder has no icon" from scratch: the <img> mounts, reserves its width (and
// briefly paints the broken-image glyph), then the 404 collapses it — a useless
// empty-slot flash to the left of every icon-less folder. The server already
// caches the 404; this cache is purely so the CLIENT doesn't re-flash on reload.
//   - 'has'    → render the <img> and reserve its slot up-front (no shift when
//                the cached icon decodes).
//   - 'none'   → render nothing — no element, no width, no margin. Re-probed
//                after NONE_TTL_MS so a folder that later gains a favicon shows
//                it within a day.
//   - unknown  → probe with a ZERO-width <img> (no reserved gap); promote to
//                'has' on load or 'none' on error.
// v2: the v1 cache was poisoned by transient server failures (a restart /
// unreachable window made every favicon <img> error → cached 'none' for the
// 12h TTL, so real icons vanished). Bumping the key drops those stale 'none'
// entries so every project re-probes once against a healthy server. The
// onError handler below now also refuses to persist 'none' on a non-404, so
// this can't recur.
// v3: the /api/projects/icon allowlist was widened (open-but-unregistered
// projects used to 403, and a 403/404 during the server restarts that shipped
// that fix could still latch a stale 'none' for the 12h TTL — a project whose
// favicon is now served would stay blank, e.g. a Next.js `app/icon.svg`). One
// more key bump flushes those so every project re-probes once against the
// now-fixed endpoint.
const CACHE_KEY = 'topics-project-icon-cache-v3';
const NONE_TTL_MS = 12 * 60 * 60 * 1000;
type IconStatus = 'has' | 'none';
interface CacheEntry { s: IconStatus; t: number }

let memCache: Record<string, CacheEntry> | null = null;
function cache(): Record<string, CacheEntry> {
  if (memCache) return memCache;
  try { memCache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch { memCache = {}; }
  return memCache!;
}
function resolveStatus(path: string): IconStatus | 'unknown' {
  const e = cache()[path];
  if (!e) return 'unknown';
  // 'none' self-heals after the TTL so a newly-added favicon eventually shows.
  if (e.s === 'none' && Date.now() - e.t > NONE_TTL_MS) return 'unknown';
  return e.s;
}
function remember(path: string, s: IconStatus): void {
  const c = cache();
  if (c[path]?.s === s) return; // only write on a real status change
  c[path] = { s, t: Date.now() };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
}

/**
 * Deterministic letter avatar (project initial + hue hashed from the path) —
 * the "standard icon" for projects whose folder ships no favicon/manifest.
 * Opt-in via `monogram`: surfaces that want EVERY project to show an icon
 * (project tabs, kanban chips) use it; plain lists keep the no-glyph default.
 */
function Monogram({ path, size, className }: { path: string; size: number; className?: string }) {
  const name = getProjectName(path) || path;
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span
      aria-hidden
      className={`flex flex-shrink-0 select-none items-center justify-center rounded-[3px] font-semibold text-white/90 ${className ?? ''}`}
      style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.62)), lineHeight: 1, background: hashToColor(path) }}
    >{letter}</span>
  );
}

export function ProjectFavicon({
  path,
  size = 14,
  className = '',
  fallback = null,
  monogram = false,
}: {
  path: string;
  size?: number;
  className?: string;
  fallback?: ReactNode;
  /** Icon-less project → letter monogram instead of `fallback`/nothing. */
  monogram?: boolean;
}) {
  const [status, setStatus] = useState<IconStatus | 'unknown'>(() => (path ? resolveStatus(path) : 'none'));
  const [loaded, setLoaded] = useState(false);
  // A row can be recycled for a different project (virtualised lists, memo
  // reuse) — re-resolve from cache when the path changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot re-resolve when a recycled row points at a new project path; converges immediately (deps = [path])
  useEffect(() => { setStatus(path ? resolveStatus(path) : 'none'); setLoaded(false); }, [path]);

  // Known icon-less (or no path) → monogram when requested, else the caller's
  // fallback (default: nothing at all — no element, no reserved width).
  if (!path || status === 'none') {
    return monogram && path ? <Monogram path={path} size={size} className={className} /> : <>{fallback}</>;
  }

  // 'has' (cached) → reserve the slot immediately so a cached icon decodes with
  // no layout shift. 'unknown' → zero width so an as-yet-unprobed folder that
  // turns out icon-less never flashes a gap; it widens to `size` only once the
  // image actually loads. opacity:0-until-load also hides the broken glyph that
  // an erroring <img> would paint for a frame. With `monogram` the letter
  // avatar holds the slot until the real icon decodes (then they swap), so the
  // width never jumps.
  const reserve = monogram ? loaded : status === 'has' || loaded;
  return (
    <>
    {monogram && !loaded && <Monogram path={path} size={size} className={className} />}
    <img
      src={`/api/projects/icon?path=${encodeURIComponent(path)}`}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={`rounded-[3px] object-contain flex-shrink-0 ${className}`}
      style={{
        opacity: loaded ? 1 : 0,
        width: reserve ? size : 0,
        // Suppress any caller margin (e.g. mr-0.5) while the slot is collapsed,
        // so an unknown/icon-less folder takes ZERO horizontal footprint.
        marginLeft: reserve ? undefined : 0,
        marginRight: reserve ? undefined : 0,
      }}
      onLoad={() => { setLoaded(true); setStatus('has'); remember(path, 'has'); }}
      onError={() => {
        // Hide this slot now, but DON'T blindly persist 'none': an <img> error
        // can't distinguish a real 404 ("no icon") from a transient failure
        // (server restarting / unreachable, or a 403 during a momentarily-empty
        // allowlist). Persisting 'none' for a transient failure poisoned the
        // cache and hid real favicons for the whole TTL. Verify with a fetch and
        // remember 'none' ONLY on a definitive 404; anything else stays
        // un-cached so the next mount re-probes once the server is healthy.
        setStatus('none');
        fetch(`/api/projects/icon?path=${encodeURIComponent(path)}`)
          .then((r) => { if (r.status === 404) remember(path, 'none'); })
          .catch(() => { /* unreachable → transient, leave the cache clean */ });
      }}
    />
    </>
  );
}
