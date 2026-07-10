/**
 * chat-rendering-parity CHAT-RND-01 — syntax highlighting for chat code blocks.
 *
 * highlight.js CORE + a curated language set (not the 190-language full build):
 * the chat renders arbitrary assistant output, so we register the languages that
 * actually appear in coding sessions and degrade to plain text for the rest.
 * No auto-detection: it's slow on every streaming delta and unreliable on the
 * short snippets chat produces — an explicit fence language or nothing.
 */
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import swift from 'highlight.js/lib/languages/swift';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('php', php);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('swift', swift);

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
 * (unknown language, oversize, or tokenizer failure). hljs escapes the source
 * while tokenizing, so the returned HTML is safe to inject.
 */
export function highlightCode(code: string, lang: string): string | null {
  if (!lang || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const resolved = LANG_ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  if (!hljs.getLanguage(resolved)) return null;
  try {
    return hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
