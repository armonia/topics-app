/**
 * The layers of what an agent reads before the first word, with their weight.
 * Pure: `SystemHarness` feeds it what the routes answered.
 *
 * Base, rules and profile are the same for every agent, so they are read off
 * the first persona; the agent layer (identity and own additions) is one
 * weight per agent. Tools and memory come from their own routes, and the turn
 * has no weight of its own: it grows with the conversation.
 */
export interface PersonaWeights {
  agent: string;
  name: string;
  layers: { name: string; tokens: number }[];
}

export interface HarnessLayers {
  base: number;
  /** The user's rules and the profile: both are read from the user's own home. */
  rules: number;
  agents: { id: string; name: string; tokens: number }[];
  tools: { alwaysOn: number; onDemand: number } | null;
  memory: number | null;
}

const layerTokens = (p: PersonaWeights | undefined, names: string[]): number =>
  (p?.layers ?? []).filter((l) => names.includes(l.name)).reduce((sum, l) => sum + l.tokens, 0);

export function harnessLayers(
  personas: PersonaWeights[],
  tools: { alwaysOn: number; onDemand: number } | null,
  memory: number | null,
): HarnessLayers {
  return {
    base: layerTokens(personas[0], ['base']),
    rules: layerTokens(personas[0], ['rules', 'profile']),
    agents: personas.map((p) => ({ id: p.agent, name: p.name, tokens: layerTokens(p, ['identity', 'agent']) })),
    tools,
    memory,
  };
}

/** The indexes that reach a turn on their own: about four characters to a token, like the rest of the app. */
export function memoryIndexTokens(stores: { index: { chars: number } | null; receivedBy: string[] }[]): number {
  return Math.round(stores.filter((s) => s.receivedBy.length > 0).reduce((sum, s) => sum + (s.index?.chars ?? 0), 0) / 4);
}
