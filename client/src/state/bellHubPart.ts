/**
 * THE HUB'S PART OF THE BELL'S LEDGER, handed from a lazy chunk to the window.
 *
 * The Dock counts the hub's rows too (one ledger), and reading them takes the
 * hub's parsers: the waiting items, the services, the quotas, the automations,
 * about 30 KB that the first download does not need, since the hub's data
 * arrives after boot anyway. So `BellHubSource` (lazy, mounted by the
 * notifications provider) runs `useBellHub` and publishes here; the provider
 * reads it and, until it lands, counts the Topics rows alone, as it does
 * while the hub has not answered yet.
 */
import { useSyncExternalStore } from 'react';
import type { BellHub } from '../lib/bellGroups';
import type { JarvisLinks } from '../lib/hubSystem';
import type { HubLiveTopic } from './hubLive';

export interface BellHubPart {
  hub: BellHub;
  /** The hub was read in this window: it is part of the installation. */
  present: boolean;
  /** It answers now: some live topic carries data. */
  answering: boolean;
  /** Since when it has not answered, while it does not. */
  downSince: number | null;
  /** The bell's topics that failed while the hub answers on others. */
  unread: HubLiveTopic[];
  jarvis: JarvisLinks | null;
}

let part: BellHubPart | null = null;
const listeners = new Set<() => void>();

/** The source's latest reading; null when it unmounts. */
export function publishBellHubPart(next: BellHubPart | null): void {
  if (next === part) return;
  part = next;
  for (const l of listeners) l();
}

/** What the hub adds to the ledger, null until the source's chunk has run. */
export function useBellHubPart(): BellHubPart | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => part,
  );
}
