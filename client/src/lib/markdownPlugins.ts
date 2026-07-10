/**
 * chat-rendering-parity CHAT-RND-02 — the ONE plugin config every chat-surface
 * ReactMarkdown shares (MessageContent's four call sites + PlanView), so math
 * support can't drift between them.
 *
 * `singleDollarTextMath: false`: chat text is full of prices and shell strings
 * ("costs $5", "$HOME") — only `$$…$$` display/inline math is intentional.
 */
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { PluggableList } from 'unified';

export const chatRemarkPlugins: PluggableList = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
];

export const chatRehypePlugins: PluggableList = [rehypeKatex];
