/**
 * The chat body and the project window, as lazy pane bodies.
 *
 * They used to be STATIC imports of `StandaloneChatGroup`, which kept them, and
 * the 195 modules behind them, in the eager entry chunk (see `loadChatPanel` in
 * `state/pane/panePreload`). Here they are `lazyWarm` like the other pane
 * bodies: on the first frame through the gate when they are on screen, and
 * rendered in the same pass as their parent once warm.
 *
 * Each one carries its OWN suspense boundary, because their call sites had
 * none: a cold chunk would otherwise suspend up to whatever boundary sits
 * above, and for the coordinator chat in the board's drawer that is the
 * board's own `LazyPane`, so the whole board would fall back to its skeleton.
 */
import type { ComponentProps, ComponentType } from 'react';
import { lazyWarm } from '../../lib/lazyWarm';
// Type-only: erased at build time, so they do not pull the modules back in.
import type { ChatPanel as ChatPanelBody } from './ChatPanel';
import type { ProjectWindowPane as ProjectWindowBody } from './ProjectWindow';
import { loadChatPanel, loadProjectWindow } from '../../state/pane/panePreload';
import { LazyPane } from './LazyPane';

function withOwnBoundary<P extends object>(Body: ComponentType<P>): ComponentType<P> {
  return function Bounded(props: P) {
    return <LazyPane><Body {...props} /></LazyPane>;
  };
}

export const ChatPanel: ComponentType<ComponentProps<typeof ChatPanelBody>> =
  withOwnBoundary(lazyWarm(loadChatPanel, (m) => m.ChatPanel));
export const ProjectWindowPane: ComponentType<ComponentProps<typeof ProjectWindowBody>> =
  withOwnBoundary(lazyWarm(loadProjectWindow, (m) => m.ProjectWindowPane));
