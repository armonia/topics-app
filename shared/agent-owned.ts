/**
 * A chat Attilio did not open: a sub-agent (`subagentOf`), a conversation
 * Jarvis opened under one of its roots (`parentId`, e.g. the channels and
 * scheduled-jobs roots), a dispatched card session (`mcpPolicy:
 * 'bridge-only'`, set only by the dispatcher).
 *
 * Shared because two sides ask it (10/11): the client keeps such chats off
 * the tab bar, the server keeps their browsers out of the workspace layout.
 */
export interface AgentOwnershipFields {
  subagentOf?: string | null;
  parentId?: string | null;
  mcpPolicy?: string | null;
}

export function isAgentOwnedTopic(topic: AgentOwnershipFields | null | undefined): boolean {
  if (!topic) return false;
  return !!topic.subagentOf || !!topic.parentId || topic.mcpPolicy === 'bridge-only';
}
