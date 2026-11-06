/**
 * The links to write to Jarvis, from the hub's `hub-config`: read once per
 * window and shared, since they come from a local config file that does not
 * change while Topics runs. Null while unread or when the hub has none.
 */
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/shell/net';
import { jarvisLinks, type JarvisLinks } from '../lib/hubSystem';

let pending: Promise<JarvisLinks | null> | null = null;

function readLinks(): Promise<JarvisLinks | null> {
  pending ??= apiFetch('/api/hub/hub-config')
    .then(async (resp) => (resp.ok ? jarvisLinks(await resp.json()) : null))
    .catch(() => null)
    .then((links) => {
      // A miss is read again next time: the hub may have been down.
      if (!links) pending = null;
      return links;
    });
  return pending;
}

export function useJarvisLinks(enabled = true): JarvisLinks | null {
  const [links, setLinks] = useState<JarvisLinks | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void readLinks().then((l) => { if (alive) setLinks(l); });
    return () => { alive = false; };
  }, [enabled]);
  return links;
}
