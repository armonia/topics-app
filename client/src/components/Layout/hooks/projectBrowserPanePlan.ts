import type { PaneGroup } from '../../../types';
import { openInTopicWindow } from '../../../lib/topicWindowDoor';

/**
 * Which group of a project window takes a new browser pane: an explicit target
 * first, then the group holding the chat or terminal that asked for it. Focus
 * is only the fallback: with two chats of one project opening pages, focus sits
 * on whichever pane opened last, and one agent's page landed in the other's.
 */
export function resolveProjectBrowserTargetGroup(
  groups: PaneGroup[],
  targetGroupId: string | undefined,
  focusedGroupId: string | null,
  spawnerKey?: string,
): string | undefined {
  const explicitTarget = groups.find(group => group.id === targetGroupId)?.id;
  // The spawner key is a topic id or a terminal's pane id. Inside a project
  // window a chat's pane id is `chat:<topicId>`, so both spellings are looked
  // for: matching the bare id only, the requesting chat was never found there
  // and focus decided anyway (11/10).
  const spawnerTarget = spawnerKey
    ? groups.find(group => group.paneIds.includes(spawnerKey) || group.paneIds.includes(`chat:${spawnerKey}`))?.id
    : undefined;
  return explicitTarget
    ?? spawnerTarget
    ?? groups.find(group => group.id === focusedGroupId)?.id
    ?? groups[0]?.id;
}

/** Give a new agent page to the topic window before the project layout claims it. */
export function claimProjectAgentNavigate(args: {
  topicId: string | undefined;
  contextId: string | undefined;
  url: string;
  hasExistingPane: boolean;
}): boolean {
  if (args.hasExistingPane || !args.contextId) return false;
  return openInTopicWindow(args.topicId, {
    contextId: args.contextId,
    url: args.url,
    openedBy: 'agent',
  });
}
