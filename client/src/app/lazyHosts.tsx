import { lazy, Suspense, useState, type ComponentProps } from 'react';
import { getLoadedCommandPalette, importCommandPalette } from './commandPaletteChunk';
import { lazyWarm } from '../lib/lazyWarm';
import { retryingChunk } from '../lib/chunkReloadGuard';
import { loadTopicTree } from '../state/pane/panePreload';

// Lazy-load components that are only shown on demand
export const NewTopicModal = lazy(() => import('../components/Modals/NewTopicModal').then(m => ({ default: m.NewTopicModal })));
// Shown once, to whoever opens Topics for the first time: its forms (the API key one comes from
// Settings) stay out of the entry every start downloads.
export const FirstRunHost = lazy(async () => {
  const { FirstRunHost: F } = await import('../components/FirstRun/FirstRunHost');
  return { default: F };
});
export const ChangelogModal = lazy(async () => {
  const { ChangelogModal: C } = await import('../components/ChangelogModal');
  return { default: C };
});
const CommandPalette = lazy(importCommandPalette);
// THE FIRST ⌘K TOOK 320ms EVEN WITH THE CHUNK WARM. `lazy()` suspends on its
// first render no matter what: the module promise settles a few microtasks
// later, so React commits the `null` fallback, and React 19 holds the reveal
// of a boundary that just showed a fallback for 300ms (FALLBACK_THROTTLE_MS).
// Measured in WebKit, 4s after boot: 319/326ms from keydown to the palette in
// the DOM, against 34-42ms when the same chunk was fetched on the keypress
// itself. Once the idle warm-up has loaded the module, the palette renders it
// directly: no Suspense, no fallback, no throttle.
//
// The branch is chosen ONCE, at mount. Read on every render, a palette opened
// before the warm-up (Suspense path) switched to the direct path on the first
// App re-render after the chunk landed: a different element type, so React
// unmounted and remounted it and the query, the selection and the focus were
// lost mid-typing. The host mounts only while the palette is open, so the
// next open takes the direct path anyway.
export function CommandPaletteHost(props: ComponentProps<typeof CommandPalette>) {
  const [Loaded] = useState(getLoadedCommandPalette);
  if (Loaded) return <Loaded {...props} />;
  return (
    <Suspense fallback={null}>
      <CommandPalette {...props} />
    </Suspense>
  );
}
export const KeyboardShortcuts = lazy(() => import('../components/Shared/KeyboardShortcuts').then(m => ({ default: m.KeyboardShortcuts })));
export const FileSearch = lazy(() => import('../components/Project/FileSearch').then(m => ({ default: m.FileSearch })));
export const TopicTree = lazyWarm(loadTopicTree, (m) => m.TopicTree);
export const Inbox = lazy(retryingChunk('Inbox', async () => {
  const { Inbox: Component } = await import('../components/Sidebar/Inbox');
  return { default: Component };
}));
export const PairingApproval = lazy(retryingChunk('PairingApproval', async () => {
  const { PairingApproval: Component } = await import('../components/Auth/PairingApproval');
  return { default: Component };
}));
export const InAppBanners = lazy(retryingChunk('InAppBanners', async () => {
  const { InAppBanners: Component } = await import('../components/Notifications/InAppBanners');
  return { default: Component };
}));
export const PushEnrollPrompt = lazy(retryingChunk('PushEnrollPrompt', async () => {
  const { PushEnrollPrompt: Component } = await import('../components/Notifications/PushEnrollPrompt');
  return { default: Component };
}));
export const TopicContextMenu = lazy(retryingChunk('ContextMenu', async () => {
  const { ContextMenu: Component } = await import('../components/Modals/ContextMenu');
  return { default: Component };
}));
