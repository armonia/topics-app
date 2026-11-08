/**
 * The real icon of a job's project, in front of its name (hub-smistamento,
 * HUBBR-13), as the hub's own list drew it.
 *
 * A Topics chat names its project's folder: the icon is Topics' own
 * (`ProjectFavicon`, the same probe as the sidebar). A job the hub sees names
 * its project by the hub's name: the icon is the hub's, read through the
 * bridge (`/api/hub/project-icon?name=`) with the app's own fetch, so it
 * loads on a phone too, once per project and kept for the window's life.
 * Without a real icon nothing is drawn: no letters, no generic glyph.
 */
import { useEffect, useState } from 'react';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { apiFetch } from '../../lib/shell/net';

/** One read per icon path, shared by every row: the blob's URL, or null when there is none. */
const hubIcons = new Map<string, Promise<string | null>>();

function readHubIcon(path: string): Promise<string | null> {
  let p = hubIcons.get(path);
  if (!p) {
    p = apiFetch(path)
      .then(async (r) => {
        const type = r.headers.get('content-type') ?? '';
        if (!r.ok || !type.startsWith('image/')) return null;
        return URL.createObjectURL(await r.blob());
      })
      .catch(() => null);
    hubIcons.set(path, p);
  }
  return p;
}

function HubIcon({ path, size }: { path: string; size: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void readHubIcon(path).then((s) => { if (alive) setSrc(s); });
    return () => { alive = false; };
  }, [path]);
  if (!src) return null;
  return <img data-testid="agents-jobs-project-icon" src={src} alt="" width={size} height={size} className="flex-none rounded-[2px] object-contain" />;
}

export function JobProjectIcon({ iconPath, hubIcon, size = 12 }: { iconPath?: string | null; hubIcon?: string | null; size?: number }) {
  if (iconPath) return <ProjectFavicon path={iconPath} size={size} className="flex-none" />;
  if (hubIcon) return <HubIcon path={hubIcon} size={size} />;
  return null;
}
