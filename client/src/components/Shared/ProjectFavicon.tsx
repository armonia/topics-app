import { useState, useEffect, type ReactNode } from 'react';

/**
 * ProjectFavicon — shows a project's real icon when its folder ships one
 * (favicon.*, public/icon.*, a web manifest's icons[], or an index.html
 * <link rel="icon">), resolved + served by GET /api/projects/icon.
 *
 * Projects WITHOUT a real icon render `fallback` (default: NOTHING — no
 * element, no reserved width, zero horizontal footprint). This is a hard
 * product decision (Attilio, 2026-07-16, reconfirmed after a monogram-tile
 * experiment was rejected): only a REAL shipped icon earns the space; no
 * letters, no generated tiles, no generic glyphs. Don't reintroduce synthetic
 * placeholders here.
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
//
// INVARIANT — 'none' is NEVER persisted to localStorage, only kept in memory
// for the current page lifetime. Four cache-key bumps (v1→v4) were spent
// flushing 'none' entries latched by transient failures (server restarts,
// allowlist warm-up 403s, dev-bundle reload storms): any code path that writes
// 'none' to disk eventually poisons the cache for the whole TTL and real icons
// vanish. Persisting only 'has' makes that class of bug impossible — the worst
// transient failure now costs one zero-width re-probe per icon-less project on
// the next reload (the server caches its 404 for 120s, so this is free).
// Entries with s:'none' still found under the key (written by older bundles)
// are dropped on load.
const CACHE_KEY = 'topics-project-icon-cache-v4';
const NONE_TTL_MS = 12 * 60 * 60 * 1000;
type IconStatus = 'has' | 'none';
interface CacheEntry { s: IconStatus; t: number }

let memCache: Record<string, CacheEntry> | null = null;
function cache(): Record<string, CacheEntry> {
  if (memCache) return memCache;
  try { memCache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch { memCache = {}; }
  // Migration + belt-and-braces: an older bundle (or a concurrent window still
  // running one) may have persisted 'none' — drop those so they can't hide a
  // real icon; they'll re-probe once.
  for (const k of Object.keys(memCache!)) {
    if (memCache![k].s === 'none') delete memCache![k];
  }
  return memCache!;
}
function persist(): void {
  const hasOnly: Record<string, CacheEntry> = {};
  for (const [k, e] of Object.entries(cache())) {
    if (e.s === 'has') hasOnly[k] = e;
  }
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(hasOnly)); } catch {}
}
function resolveStatus(path: string): IconStatus | 'unknown' {
  const e = cache()[path];
  if (!e) return 'unknown';
  // 'none' self-heals after the TTL so a newly-added favicon eventually shows
  // even in a long-lived window (the entry is memory-only, so a reload also
  // clears it).
  if (e.s === 'none' && Date.now() - e.t > NONE_TTL_MS) return 'unknown';
  return e.s;
}
function remember(path: string, s: IconStatus): void {
  const c = cache();
  if (c[path]?.s === s) return; // only write on a real status change
  c[path] = { s, t: Date.now() };
  // 'has' → persist; 'none' → memory-only, but still persist to SHED a stale
  // 'has' entry for a project whose icon was since removed (persist() filters
  // the 'none' itself out).
  persist();
}

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
  const [status, setStatus] = useState<IconStatus | 'unknown'>(() => (path ? resolveStatus(path) : 'none'));
  const [loaded, setLoaded] = useState(false);
  // A row can be recycled for a different project (virtualised lists, memo
  // reuse) — re-resolve from cache when the path changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot re-resolve when a recycled row points at a new project path; converges immediately (deps = [path])
  useEffect(() => { setStatus(path ? resolveStatus(path) : 'none'); setLoaded(false); }, [path]);

  // Known icon-less (or no path) → render the fallback (default: nothing at
  // all — no element, so no reserved width and no margin next to the name).
  if (!path || status === 'none') return <>{fallback}</>;

  // 'has' (cached) → reserve the slot immediately so a cached icon decodes with
  // no layout shift. 'unknown' → zero width so an as-yet-unprobed folder that
  // turns out icon-less never flashes a gap; it widens to `size` only once the
  // image actually loads. opacity:0-until-load also hides the broken glyph that
  // an erroring <img> would paint for a frame.
  const reserve = status === 'has' || loaded;
  return (
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
  );
}
