/**
 * The `content` of the stream-json user message written to the CLI's stdin.
 *
 * A plain string for every ordinary message, exactly as before. When the
 * message is a bare skill invocation (`slashContext` defined, see
 * `ProviderPayload.slashContext`), whatever Topics would have put IN FRONT of it
 * (the `<context>` block, the recap prologue of a respawned session) goes in a
 * text block of its own, BEFORE the message block. The CLI parses the last text
 * block as the input, so `/recap …` still starts the input and the skill expands
 * with only the user's own arguments; the blocks before it travel with the
 * expanded skill (`precedingInputBlocks`, CLI 2.1.288).
 */
export type UserTurnContent = string | Array<{ type: "text"; text: string }>;

export function buildUserTurnContent(
  message: string,
  opts: { prologue?: string; slashContext?: string } = {},
): UserTurnContent {
  if (opts.slashContext === undefined) {
    return opts.prologue ? `${opts.prologue}\n${message}` : message;
  }
  const preceding = [opts.prologue, opts.slashContext].filter((s): s is string => !!s).join("\n\n");
  if (!preceding) return message;
  return [
    { type: "text", text: preceding },
    { type: "text", text: message },
  ];
}
