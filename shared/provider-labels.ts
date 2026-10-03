/**
 * The name a provider is shown by. The server puts it in the providers
 * snapshot (`server/providers/snapshot-manager.ts`); the client needs it too
 * for a provider the snapshot does not list (not connected here, yet declared
 * by a topic), or it shows the bare id: «codex non compatta» (CMDUI-06).
 *
 * Names not in the table come from the ACP agents (`ACP_AGENTS`): (a) the
 * lookup goes through `hasOwnProperty`, or an agent called `toString` would
 * give back a FUNCTION instead of a string, and (b) `gemini` shows as `Gemini`
 * instead of all lower-case among proper names.
 */
const PROVIDER_LABELS: Record<string, string> = {
  openclaw: "OpenClaw",
  claude: "Claude (API)",
  "claude-code": "Claude Code",
  codex: "Codex",
  openai: "OpenAI",
};

export function providerLabel(name: string): string {
  if (Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, name)) {
    return PROVIDER_LABELS[name]!;
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}
