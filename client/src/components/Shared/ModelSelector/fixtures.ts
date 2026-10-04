/**
 * The catalogs measured on 2026-10-02, as a snapshot the selector's tests
 * share: Claude Code's 11 ids, the engine's 14, Codex's 8 visible models with
 * the windows and metadata of its cache. No model call behind any of it.
 */
import type { ProvidersSnapshot, ProviderSnapshotEntry } from '../../../types';

export const CLAUDE_CODE_IDS = [
  'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]', 'claude-haiku-4-5',
  'claude-fable-5-1', 'claude-opus-4-8', 'claude-opus-4-8[1m]', 'claude-sonnet-4-6', 'claude-sonnet-4-6[1m]', 'claude-haiku-3-5',
];
export const ENGINE_IDS = [
  'claude-opus-5-5[1m]', 'claude-opus-5-5', 'claude-opus-5[1m]', 'claude-opus-5', 'claude-sonnet-5-5[1m]', 'claude-sonnet-5-5',
  'claude-sonnet-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-4-8[1m]', 'claude-opus-4-8', 'claude-opus-4-6',
  'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
];
const CODEX = [
  ['gpt-6.1-sol', 'GPT-6.1-Sol', 'current', 'Latest workhorse model for coding and everyday work.'],
  ['gpt-6-astra', 'GPT-6-Astra', 'current', 'Frontier intelligence for the most demanding work.'],
  ['gpt-6-sol', 'GPT-6-Sol', 'current', 'Previous generation workhorse model.'],
  ['gpt-6-luna', 'GPT-6-Luna', 'current', 'Fast and affordable model for easier tasks.'],
  ['gpt-5.6-sol', 'GPT-5.6-Sol', 'older', 'Older generation workhorse model.'],
  ['gpt-5.6-terra', 'GPT-5.6-Terra', 'older', 'Older balanced model for straightforward work.'],
  ['gpt-5.6-luna', 'GPT-5.6-Luna', 'older', 'Older fast and efficient model.'],
  ['gpt-5.5', 'GPT-5.5', 'older', 'Legacy coding model.'],
] as const;
export const CODEX_IDS = CODEX.map(([id]) => id);

const CLAUDE_OLDER = new Set(['claude-opus-4-8', 'claude-opus-4-8[1m]', 'claude-sonnet-4-6', 'claude-sonnet-4-6[1m]', 'claude-haiku-3-5']);
const at = '2026-10-02T00:00:00Z';

export function entry(name: string, label: string, models: string[], extra: Partial<ProviderSnapshotEntry> = {}): ProviderSnapshotEntry {
  return { name, label, status: 'ready', isDefault: false, models, capabilities: ['coding-tasks'], requirements: [], fetchedAt: at, ...extra };
}

export const CLAUDE_CODE = entry('claude-code', 'Claude Code', CLAUDE_CODE_IDS, {
  modelInfo: Object.fromEntries(CLAUDE_CODE_IDS.map((id) => [id, { generation: CLAUDE_OLDER.has(id) ? 'older' as const : 'current' as const }])),
});
export const ENGINE = entry('topics', 'Topics', ENGINE_IDS);
export const CODEX_ENTRY = entry('codex', 'Codex', CODEX_IDS, {
  modelContextWindows: Object.fromEntries(CODEX_IDS.map((id) => [id, 272000])),
  modelInfo: Object.fromEntries(CODEX.map(([id, label, generation, description]) => [id, {
    label, generation, description, ...(id === 'gpt-5.5' ? { retiresAt: '2026-10-14T19:00:00Z', replacement: 'gpt-6.1-sol' } : {}),
  }])),
});

export function snapshotOf(providers: ProviderSnapshotEntry[], defaultProvider = 'claude-code'): ProvidersSnapshot {
  return { providers, defaultProvider, generatedAt: at };
}

/** Claude Code, the engine and Codex, ready: the fleet of this Mac. */
export const MEASURED = snapshotOf([CLAUDE_CODE, CODEX_ENTRY, ENGINE]);

/**
 * The audit fleet of revision 2026-10-04 (§11), «with keys»: the Claude API,
 * the OpenAI API, Gemini CLI, jcode, an Ollama and an OpenRouter endpoint, and
 * goose in error. The Topics engine serves five Claude ids.
 */
const AUDIT_ENGINE = entry('topics', 'Topics', ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1']);
export const AUDIT_KEYS = snapshotOf([
  { ...CLAUDE_CODE, isDefault: true },
  entry('claude', 'Claude API', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-6'], {
    capabilities: ['streaming'], modelInfo: { 'claude-opus-4-8': { generation: 'older' }, 'claude-sonnet-4-6': { generation: 'older' } },
  }),
  CODEX_ENTRY,
  entry('openai', 'OpenAI API', ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.5', 'o4-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'], { capabilities: ['streaming'] }),
  entry('gemini', 'Gemini CLI', ['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-pro']),
  entry('jcode', 'jcode', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']),
  entry('direct-ollama', 'Ollama (Mac mini)', ['gpt-oss:20b', 'qwen3-coder:30b', 'llama3.3:70b', 'deepseek-r1:32b', 'gemma3:27b'], { capabilities: ['streaming'] }),
  entry('direct-openrouter', 'OpenRouter', [
    'anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro', 'meta-llama/llama-4-maverick', 'mistralai/devstral-medium', 'x-ai/grok-4',
  ], { capabilities: ['streaming'] }),
  entry('goose', 'goose', [], { status: 'error', lastError: 'goose acp: exited with code 1' }),
  AUDIT_ENGINE,
]);

/** «Without keys»: Claude Code on a Pro plan, Codex not signed in, Gemini CLI
 *  without its key, an LM Studio endpoint that refuses connections. */
export const AUDIT_NO_KEYS = snapshotOf([
  CLAUDE_CODE,
  entry('codex', 'Codex', [], { status: 'unavailable', requirements: [{ key: 'codex-login', label: 'Codex login', present: false, hint: 'codex login' }] }),
  entry('gemini', 'Gemini CLI', [], { status: 'unavailable', requirements: [{ key: 'GEMINI_API_KEY', label: 'Gemini key', present: false, hint: 'export GEMINI_API_KEY=...' }] }),
  entry('direct-lmstudio', 'LM Studio', [], { status: 'error', capabilities: ['streaming'], lastError: 'connect ECONNREFUSED 127.0.0.1:1234' }),
  AUDIT_ENGINE,
]);
