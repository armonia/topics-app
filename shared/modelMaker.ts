/**
 * MSEL-02 / design §3.1: the company that makes a model, read from its id.
 *
 * A table of PREFIXES, not a catalog of models: a new model of the same
 * company needs no change here. Anything else belongs to the Others section, named
 * by the provider that offers it (OpenClaw, an endpoint).
 */
export type ModelMaker = 'anthropic' | 'openai' | 'google' | 'other';

/** The order the selector shows the sections in, after the stored value's own. */
export const MODEL_MAKER_ORDER: readonly ModelMaker[] = ['anthropic', 'openai', 'google', 'other'];

export function modelMaker(id: string): ModelMaker {
  // `provider:model` values carry the runtime first: the model is after the colon.
  const bare = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  const m = bare.trim().toLowerCase();
  if (m.startsWith('claude-')) return 'anthropic';
  if (m.startsWith('gpt-') || /^o\d/.test(m) || m.startsWith('codex')) return 'openai';
  if (m.startsWith('gemini-')) return 'google';
  return 'other';
}
