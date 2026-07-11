/**
 * chat-rendering-parity CHAT-RND-01 — syntax highlighting for chat code blocks.
 *
 * Lazy facade over `syntaxHighlightLangs.ts` (hljs core + curated languages).
 * The tokenizers are ~100KB min and were shipping in the boot-path main chunk;
 * now they load on the FIRST code block with a fence language — the same
 * pattern ChatMarkdown.tsx uses for katex. Until the module lands,
 * `highlightCode` returns null (plain render) and components re-render via
 * `subscribeHighlighter`/`highlighterReady` (useSyncExternalStore-shaped).
 */
type Hljs = typeof import('./syntaxHighlightLangs').default;

let hljs: Hljs | null = null;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function ensureHljsLoaded(): void {
  if (hljs || loadPromise) return;
  loadPromise = import('./syntaxHighlightLangs')
    .then((m) => {
      hljs = m.default;
      listeners.forEach((l) => l());
    })
    .catch(() => {
      loadPromise = null; // chunk fetch failed (offline?) — retry on next block
    });
}

/** useSyncExternalStore subscribe — fires once when the tokenizers land. */
export function subscribeHighlighter(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** useSyncExternalStore snapshot. */
export function highlighterReady(): boolean {
  return hljs !== null;
}

/** Common fence aliases → registered language names. */
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  yml: 'yaml',
  html: 'xml', svg: 'xml', vue: 'xml',
  rs: 'rust',
  golang: 'go',
  md: 'markdown',
  'c++': 'cpp', h: 'c', hpp: 'cpp',
  rb: 'ruby',
  patch: 'diff',
};

// Blocks beyond this stay plain: tokenizing hundreds of KB on every streaming
// re-render would jank the pane, and such payloads are dumps, not code to read.
const MAX_HIGHLIGHT_CHARS = 50_000;

/**
 * Highlighted HTML for `code`, or null when the block must stay plain
 * (unknown language, oversize, tokenizer failure, or tokenizers still
 * loading — in which case the load is kicked off). hljs escapes the source
 * while tokenizing, so the returned HTML is safe to inject.
 */
export function highlightCode(code: string, lang: string): string | null {
  if (!lang || code.length > MAX_HIGHLIGHT_CHARS) return null;
  if (!hljs) {
    ensureHljsLoaded();
    return null;
  }
  const resolved = LANG_ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  if (!hljs.getLanguage(resolved)) return null;
  try {
    return hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
