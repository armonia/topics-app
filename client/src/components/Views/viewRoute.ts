/**
 * Addresses of generative views (GENUI-01), on the client side.
 *
 * Kept free of React and of the app's stores: `main.tsx` imports it before it
 * decides whether to boot the app at all.
 */
import { VIEW_ID_RE, viewPath } from '../../../../shared/views';
import { serverHttpBase } from '../../lib/shell/net';
import { getMediaUrl } from '../../lib/api';

/** The id when this page IS a standalone view (`/v/<id>`), else null. */
export function standaloneViewId(pathname: string): string | null {
  const m = /^\/v\/([^/]+)\/?$/.exec(pathname);
  return m && VIEW_ID_RE.test(m[1]) ? m[1] : null;
}

/**
 * The absolute address of a view's page, on the origin that SERVES this app's
 * paths: the desktop shell's cleartext proxy (13333) under Tauri, the page's
 * own origin on the web. Same rule as `getMediaUrl`.
 */
export function viewPageUrl(id: string): string {
  const base = serverHttpBase() || (typeof window === 'undefined' ? '' : window.location.origin);
  return `${base}${viewPath(id)}`;
}

/** What an `<img src>` loads for a view image: remote as is, local through `/api/media`. */
export function viewImageUrl(src: string): string {
  return /^https?:\/\//i.test(src) ? src : getMediaUrl(src);
}
