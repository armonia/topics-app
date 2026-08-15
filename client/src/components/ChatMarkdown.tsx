/**
 * chat-rendering-parity CHAT-RND-02 — the ONE markdown renderer every
 * chat-surface shares (MessageContent's five call sites + PlanCard), so plugin
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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';
import { openExternalOnce } from '../lib/openExternal';
import { openTaskInApp } from '../lib/openTaskLink';
import { deepLinkClickRoute, openTabInApp } from '../lib/tabLink';
import { openDeepLinkFromClick } from '../lib/deepLinkClick';
import { useToast } from './Shared/Toast';

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
 * Un link alla PROPRIA origine si apre IN-APP, mai in un browser esterno. Erano
 * riconosciuti solo i `/task/<id>`, e l'asimmetria si vedeva: un `/topic/<id>`
 * incollato in un commento della board — che è il link che l'app stessa manda
 * nelle notifiche di fine turno — faceva partire il browser di sistema su una
 * COPIA web dell'app, con la chat aperta lì e non qui. Adesso l'ordine è:
 *   1. `selfTaskLinkTarget` — il drawer del task, che ha già il suo proprietario
 *      (openTaskLink riflette `/task/<id>` nella history: non gli togliamo il
 *      volante);
 *   2. `selfTabLinkTarget` — TUTTO il resto della grammatica `/tab/…`, alias
 *      `/topic/<id>` compreso, instradato dall'unica porta (`openTabInApp`);
 *   3. `openExternalOnce`, che dedupa il doppio-click e sceglie il canale giusto
 *      per host.
 *
 * La decisione sta tutta in `deepLinkClickRoute`, che è anche l'unico posto che
 * sa dire «questa FINESTRA non può instradare». Serve per le pop-out STACCATE
 * (`?topics=`): lì App.tsx si rifiuta di risolvere deep-link e la persistenza
 * del pane-store è spenta, quindi intercettare il link avrebbe reso il click
 * MUTO — nessuna tab che si apre, nessun avviso, e per chat/progetto un
 * OPEN_PANE dispatchato in uno store che nessuno salva. Prima
 * dell'intercettazione quello stesso link apriva il browser di sistema e il
 * contenuto si vedeva: nelle staccate si torna esattamente lì.
 *
 * L'esito del vicolo cieco sta in `lib/deepLinkClick`, insieme al perché delle
 * sue due facce (aprire fuori quando in casa non è partito niente, DIRLO quando
 * è partito a metà) e al test che le esegue entrambe. Qui resta l'ancora.
 *
 * Il toast non c'era, ed era motivato: il valore del context dei toast si
 * ricostruiva a ogni render di App, quindi bastava un `useToast()` qui dentro
 * per rendere OGNI link di OGNI messaggio un consumatore che si ri-renderizza a
 * ogni giro. Quella premessa è caduta — l'API dei toast vive in
 * `ToastApiContext`, che dopo il mount non cambia MAI identità (Toast.tsx, più
 * il test che lo tiene) — e con lei l'ultima ragione per cui un click poteva non
 * fare e non dire niente.
 *
 * Chi passa un proprio `a` nei `components` lo sovrascrive comunque (lo spread
 * più sotto mette i components del chiamante DOPO).
 */
function DeepLinkAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const toast = useToast();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-500 hover:text-blue-600 underline"
      onClick={(e) => {
        if (!href) return;
        e.preventDefault();
        openDeepLinkFromClick(href, {
          route: deepLinkClickRoute,
          openTask: openTaskInApp,
          openTab: openTabInApp,
          openExternal: openExternalOnce,
          warn: (message) => toast.warning(message),
        });
      }}
    >{children}</a>
  );
}

const DEFAULT_COMPONENTS: Components = {
  a: ({ href, children }) => <DeepLinkAnchor href={href}>{children}</DeepLinkAnchor>,
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
  }).catch((err) => {
    // Drop the rejected promise so a transient chunk failure is retried by the
    // next message rather than poisoning the cache for the rest of the session.
    mathModsPromise = null;
    throw err;
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
    // The catch is not decoration: these are three lazy chunks over the network,
    // and a failed chunk load rejects. Without it the rejection is unhandled and
    // the message renders nothing rather than falling back to its own source —
    // which for a maths block is still perfectly readable text.
    loadMathMods()
      .then((mods) => { if (alive) setMathMods(mods); })
      .catch(() => { /* keep the plain remark pipeline; `$$…$$` stays literal */ });
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
