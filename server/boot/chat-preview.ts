// Wiring of the live preview for chats that work in their own worktree.
import { late } from "./late";
import { chatSourceId } from "../services/preview-manager";
import { stopTopicCommandProcesses } from "../routes/processes";

/** The chat preview button: same flow as the end-of-turn start, minus the interface-files gate. */
export function ensureChatPreview(topicId: string): Promise<void> {
  return late.previewManager?.ensureForChat(topicId) ?? Promise.resolve();
}

/**
 * End of a chat turn: restarts the idle clock of a live preview and, when the
 * turn ended cleanly, starts one if the worktree diff touches interface files.
 */
export function onChatTurnEnd(topicId: string, opts: { clean: boolean }): void {
  const pm = late.previewManager;
  if (!pm) return;
  pm.noteChatTurn(topicId);
  if (opts.clean) void pm.ensureForChat(topicId, { auto: true });
}

/** Closing or archiving a topic stops its command processes AND its chat preview. */
export function stopTopicProcessesAndPreview(topicId: string): void {
  stopTopicCommandProcesses(topicId);
  void late.previewManager?.teardown(chatSourceId(topicId));
}
