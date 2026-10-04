/**
 * MSEL-02, revision 2026-10-04 §3.2: the company that makes a model, read from
 * its id. There is no catch-all: every model has a company, and a model whose
 * company cannot be read is named by the provider that offers it (OpenClaw).
 *
 * Tables of PREFIXES and vendor names, not a catalog of models: a new model of
 * a known company needs no change here, and a new company almost always comes
 * with a `vendor/` prefix, which names it on its own.
 */

export interface ModelMakerInfo {
  /** A company id (`anthropic`), `vendor:<v>` for an unknown vendor prefix,
   *  or `provider:<name>` when only the offering provider is known. */
  id: string;
  label: string;
}

/** Anthropic, OpenAI and Google: the three fixed columns, in this order. */
export const FIXED_MAKERS = ['anthropic', 'openai', 'google'] as const;

export const MAKER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', meta: 'Meta', mistral: 'Mistral', qwen: 'Qwen',
  deepseek: 'DeepSeek', nvidia: 'NVIDIA', zai: 'Z.ai', moonshot: 'Moonshot', ibm: 'IBM', microsoft: 'Microsoft',
  xai: 'xAI', cohere: 'Cohere', writer: 'Writer', '01ai': '01.AI', ai21: 'AI21 Labs', aisingapore: 'AI Singapore',
  bigcode: 'BigCode',
};

/** `vendor/` prefixes and the company they name. */
const VENDORS: Record<string, string> = {
  anthropic: 'anthropic', openai: 'openai', google: 'google', meta: 'meta', 'meta-llama': 'meta', mistralai: 'mistral',
  'nv-mistralai': 'mistral', 'deepseek-ai': 'deepseek', deepseek: 'deepseek', moonshotai: 'moonshot', 'z-ai': 'zai',
  zai: 'zai', thudm: 'zai', 'x-ai': 'xai', '01-ai': '01ai', ai21labs: 'ai21', aisingapore: 'aisingapore',
  bigcode: 'bigcode', qwen: 'qwen', nvidia: 'nvidia', ibm: 'ibm', microsoft: 'microsoft', writer: 'writer',
  cohere: 'cohere',
};

/** Model families on the bare id, first match wins. */
const FAMILY_PREFIXES: Array<[RegExp, string]> = [
  [/^claude-/, 'anthropic'],
  [/^(gpt-|o\d|codex)/, 'openai'],
  [/^(gemini|gemma|codegemma|recurrentgemma|diffusiongemma)/, 'google'],
  [/^(llama|codellama)/, 'meta'],
  [/^(mistral|mixtral|codestral|devstral|magistral|ministral)/, 'mistral'],
  [/^(qwen|qwq)/, 'qwen'],
  [/^deepseek/, 'deepseek'],
  [/^(nemotron|nvidia$)/, 'nvidia'],
  [/^(glm|zai-)/, 'zai'],
  [/^kimi/, 'moonshot'],
  [/^granite/, 'ibm'],
  [/^phi/, 'microsoft'],
  [/^grok/, 'xai'],
  [/^command/, 'cohere'],
  [/^palmyra/, 'writer'],
];

/** Runtime prefixes of a stored `provider:model` value. Only these are peeled:
 *  in `gpt-oss:20b` the part before the colon is the model, not a runtime. */
const RUNTIME_PREFIXES = new Set(['topics', 'claude-code', 'codex', 'jcode', 'claude', 'openai', 'gemini']);

/** The company of a provider that lists no model (a subscription not signed
 *  in, a key not set). Agents and endpoints run many companies' models, so
 *  they have none. */
const ENGINE_MAKERS: Record<string, string> = {
  'claude-code': 'anthropic', topics: 'anthropic', claude: 'anthropic', codex: 'openai', openai: 'openai', gemini: 'google',
};

/** The id without a runtime prefix, lower-case. */
export function bareModelId(id: string): string {
  let m = id.trim().toLowerCase();
  const colon = m.indexOf(':');
  if (colon > 0 && RUNTIME_PREFIXES.has(m.slice(0, colon))) m = m.slice(colon + 1);
  return m;
}

export function makerLabel(maker: string): string {
  if (Object.prototype.hasOwnProperty.call(MAKER_LABELS, maker)) return MAKER_LABELS[maker]!;
  const vendor = maker.startsWith('vendor:') ? maker.slice('vendor:'.length) : maker;
  return vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

/**
 * 1. peel the runtime prefix; 2. a `vendor/` prefix wins over the family;
 * 3. the family on the bare id; 4. the provider that offers it.
 */
export function modelMaker(id: string, offeredBy: { name: string; label?: string }): ModelMakerInfo {
  const m = bareModelId(id);
  const slash = m.indexOf('/');
  if (slash > 0) {
    const vendor = m.slice(0, slash);
    const known = Object.prototype.hasOwnProperty.call(VENDORS, vendor) ? VENDORS[vendor]! : null;
    return known ? { id: known, label: MAKER_LABELS[known]! } : { id: `vendor:${vendor}`, label: makerLabel(vendor) };
  }
  const bare = m.split(':')[0]!;
  for (const [pattern, maker] of FAMILY_PREFIXES) {
    if (pattern.test(bare)) return { id: maker, label: MAKER_LABELS[maker]! };
  }
  return { id: `provider:${offeredBy.name}`, label: offeredBy.label ?? offeredBy.name };
}

/** The company of a provider from the static table, or null. */
export function engineMaker(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(ENGINE_MAKERS, name) ? ENGINE_MAKERS[name]! : null;
}
