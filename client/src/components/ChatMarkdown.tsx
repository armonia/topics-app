/**
 * chat-rendering-parity CHAT-RND-02 — the ONE markdown renderer every
 * chat-surface shares (MessageContent's five call sites + PlanView), so plugin
 * config and math support can't drift between them. Replaces the old
 * lib/markdownPlugins.ts static plugin lists.
 *
 * Math (remark-math + rehype-katex + katex CSS, ~80-100KB gz combined) is
 * LAZY: statically importing it forced katex into the boot-path bundle even
 * though most messages contain no math — the exact cost the neighbouring
 * mermaid handling already avoids with `await import('mermaid')`. We only
 * fetch the math stack when a rendered content actually contains `$$`
 * (`singleDollarTextMath: false` means `$$…$$` is the only math syntax, so the
 * `$$` probe is exact — plain "$5" / "$HOME" never trigger a load). Until the
 * chunk lands the raw `$$…$$` text shows for a frame, same progressive
 * behaviour as mermaid's code-block placeholder; once loaded, the modules are
 * cached and every subsequent mount renders math synchronously.
 */
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';
import { openExternalOnce } from '../lib/openExternal';
import { selfTaskLinkTarget, openTaskInApp } from '../lib/openTaskLink';

/**
 * Il renderer `a` di DEFAULT, per OGNI superficie markdown.
 *
 * remark-gfm autolinka gli URL scritti in chiaro, ma un `<a target="_blank">`
 * nudo è morto nella WKWebView del guscio Tauri, e altrove porta via la SPA.
 * Solo MessageContent passava il suo `a`: i link in un commento della board, in
 * una descrizione di task, in un piano o in un divisore di compattazione non
 * erano cliccabili. Ora la regola sta QUI, dove sta già il resto della config
 * dei plugin, così non può più divergere per superficie.
 *
 * Un link alla PROPRIA origine che punta a un task (l'URL di "copia link"
 * incollato in un commento) apre il drawer in-app invece di far partire un
 * browser esterno; tutto il resto passa da `openExternalOnce`, che dedupa il
 * doppio-click e sceglie il canale giusto per host.
 *
 * Chi passa un proprio `a` nei `components` lo sovrascrive comunque (lo spread
 * più sotto mette i components del chiamante DOPO).
 */
const DEFAULT_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-500 hover:text-blue-600 underline"
      onClick={(e) => {
        if (!href) return;
        e.preventDefault();
        const selfTask = selfTaskLinkTarget(href);
        if (selfTask) openTaskInApp(selfTask);
        else openExternalOnce(href);
      }}
    >{children}</a>
  ),
};

interface MathMods {
  remark: PluggableList[number];
  rehype: PluggableList[number];
}

let mathModsCache: MathMods | null = null;
let mathModsPromise: Promise<MathMods> | null = null;

function loadMathMods(): Promise<MathMods> {
  mathModsPromise ??= Promise.all([
    import('remark-math'),
    import('rehype-katex'),
    // Vite turns this into a lazy-injected CSS chunk alongside the JS.
    import('katex/dist/katex.min.css'),
  ]).then(([remarkMath, rehypeKatex]) => {
    mathModsCache = {
      // `singleDollarTextMath: false`: chat text is full of prices and shell
      // strings ("costs $5", "$HOME") — only `$$…$$` math is intentional.
      remark: [remarkMath.default, { singleDollarTextMath: false }],
      rehype: rehypeKatex.default,
    };
    return mathModsCache;
  });
  return mathModsPromise;
}

const BASE_REMARK: PluggableList = [remarkGfm];
const BASE_REHYPE: PluggableList = [];

export function ChatMarkdown({ components, children }: { components: Components; children: string }) {
  const needsMath = children.includes('$$');
  const [mathMods, setMathMods] = useState<MathMods | null>(mathModsCache);
  useEffect(() => {
    if (!needsMath || mathMods) return;
    let alive = true;
    loadMathMods().then((mods) => { if (alive) setMathMods(mods); });
    return () => { alive = false; };
  }, [needsMath, mathMods]);

  // react-markdown re-parses `children` from scratch on EVERY render (no internal
  // memoization). A completed message re-renders whenever a sibling/parent updates,
  // so without this memo every such render re-runs the full remark/rehype AST build
  // — O(messages × content) on any unrelated state change, and O(n²) as a message
  // streams. Memoize on the real inputs: the chat hot path passes the module-const
  // `markdownComponents` (stable ref), so this hits on every render where the text
  // hasn't changed. (Board call sites pass a fresh `{}` and simply never hit — no
  // regression, they're not a hot path.)
  const withMath = needsMath && mathMods;
  return useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={withMath ? [remarkGfm, mathMods!.remark] : BASE_REMARK}
        rehypePlugins={withMath ? [mathMods!.rehype] : BASE_REHYPE}
        components={{ ...DEFAULT_COMPONENTS, ...components }}
      >
        {children}
      </ReactMarkdown>
    ),
    [children, components, withMath, mathMods],
  );
}
