/** Whether a scroll event may change the reader's explicit follow choice. */
export function shouldReevaluateTaskConversationFollow(input: {
  wasFollowing: boolean;
  viewportResized: boolean;
  contentGrew: boolean;
  movedUp: boolean;
}): boolean {
  if (input.wasFollowing && input.viewportResized) return false;
  return !(input.contentGrew && !input.movedUp);
}
