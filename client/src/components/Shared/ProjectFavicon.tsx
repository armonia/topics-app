import { useState, useEffect } from 'react';
import { getProjectName, hashToColor } from '../Layout/projectColors';

/**
 * ProjectFavicon — a project's icon, resolved with a fixed priority:
 *   1. the REAL icon the folder ships (favicon.*, public/icon.*, a web
 *      manifest's icons[], or an index.html <link rel="icon">), served by
 *      GET /api/projects/icon;
 *   2. otherwise a MONOGRAM — the project's initial on a deterministic tint
 *      (hashToColor(path), the same hue the project tab/window uses). This is
 *      the "standard" every project falls back to, so a project is NEVER
 *      icon-less. (Earlier the fallback was nothing, which left most non-web
 *      folders blank — the user wants an icon on every project.)
 *
 * The monogram is NOT a generic folder glyph — it's a per-project identity mark
 * (initial + stable colour), the GitHub/Slack convention for entities without a
 * shipped avatar.
 */

// Client-side cache of which project paths actually ship a real icon, so a
// reload doesn't re-probe "this folder has no icon" from scratch (and doesn't
// flash the monogram over a project that DOES have a favicon while the 404
// round-trips). The server also caches its 404; this cache is purely so the
// CLIENT skips the probe.
//   - 'has'   → the folder ships an icon; render the <img>, reserve its slot.
//   - 'none'  → no icon; render the monogram. Re-probed after NONE_TTL_MS so a
//               folder that later gains a favicon shows it within a day.
//   - unknown → probe: monogram now, swap to the real icon if it decodes.
const CACHE_KEY = 'topics-project-icon-cache-v2';
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

/** Per-project initial on a deterministic tint — the standard shown when a
 *  project ships no real favicon/manifest icon. */
function ProjectMonogram({ path, size, className = '' }: { path: string; size: number; className?: string }) {
  const initial = (getProjectName(path).match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded-[3px] flex-shrink-0 font-semibold text-white select-none ${className}`}
      style={{
        width: size,
        height: size,
        background: hashToColor(path),
        // A hair under the tile so a wide letter (M/W) never clips.
        fontSize: Math.round(size * 0.6),
        lineHeight: 1,
        // hashToColor sits at 50% lightness — light for yellow/green hues — so a
        // faint shadow keeps the white initial legible on every tint.
        textShadow: '0 1px 1px rgba(0,0,0,0.35)',
      }}
    >
      {initial}
    </span>
  );
}

export function ProjectFavicon({
  path,
  size = 14,
  className = '',
}: {
  path: string;
  size?: number;
  className?: string;
}) {
  const [status, setStatus] = useState<IconStatus | 'unknown'>(() => (path ? resolveStatus(path) : 'none'));
  const [loaded, setLoaded] = useState(false);
  // A row can be recycled for a different project (virtualised lists, memo
  // reuse) — re-resolve from cache when the path changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot re-resolve when a recycled row points at a new project path; converges immediately (deps = [path])
  useEffect(() => { setStatus(path ? resolveStatus(path) : 'none'); setLoaded(false); }, [path]);

  if (!path) return null;

  // No real icon → the standard monogram. No <img>, no probe.
  if (status === 'none') return <ProjectMonogram path={path} size={size} className={className} />;

  // 'has' or 'unknown': probe the real icon. The monogram shows underneath until
  // the favicon decodes (so there's never a blank slot), then the <img> fades in
  // over it; on a definitive 404 we drop to the monogram-only branch above. The
  // wrapper carries an explicit size so it never collapses when the absolute
  // <img> is the only remaining child.
  return (
    <span
      className={`relative inline-flex flex-shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      {!loaded && <ProjectMonogram path={path} size={size} />}
      <img
        src={`/api/projects/icon?path=${encodeURIComponent(path)}`}
        width={size}
        height={size}
        alt=""
        draggable={false}
        className="rounded-[3px] object-contain absolute inset-0"
        style={{ width: size, height: size, opacity: loaded ? 1 : 0 }}
        onLoad={() => { setLoaded(true); setStatus('has'); remember(path, 'has'); }}
        onError={() => {
          // Drop to the monogram now, but DON'T blindly persist 'none': an <img>
          // error can't tell a real 404 ("no icon") from a transient failure
          // (server restarting / a momentarily-empty allowlist → 403). Persisting
          // 'none' for a transient failure poisoned the cache and hid real
          // favicons for the whole TTL. Verify with a fetch and remember 'none'
          // ONLY on a definitive 404; anything else stays un-cached so the next
          // mount re-probes once the server is healthy. Either way the monogram
          // shows meanwhile, so the slot is never blank.
          setStatus('none');
          fetch(`/api/projects/icon?path=${encodeURIComponent(path)}`)
            .then((r) => { if (r.status === 404) remember(path, 'none'); })
            .catch(() => { /* unreachable → transient, leave the cache clean */ });
        }}
      />
    </span>
  );
}
