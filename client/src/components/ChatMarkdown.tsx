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
import { memo, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';
import { openLink, isExternalLinkGesture } from '../lib/openLink';
import { openTaskInApp } from '../lib/openTaskLink';
import { deepLinkClickRoute, openTabInApp } from '../lib/tabLink';
import { openDeepLinkFromClick } from '../lib/deepLinkClick';
import { completePartialMarkdown, createTailGate, openFenceStart, splitMarkdownBlocks } from '../lib/markdownBlocks';
import { MarkdownBlockContext } from './Chat/markdownBlockContext';
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
 *   3. `openLink`, che apre una TAB del browser di Topics (e il browser di
 *      sistema solo su gesto esplicito).
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
export function DeepLinkAnchor({ href, children }: { href?: string; children?: ReactNode }) {
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
        // The last branch of the router used to hand the link to the SYSTEM
        // browser, which in an app that has a browser of its own meant leaving
        // it. It now opens a tab here; Cmd/Ctrl-click and the middle button
        // still mean "out of the app", as they do in every browser.
        const external = isExternalLinkGesture(e);
        openDeepLinkFromClick(href, {
          route: deepLinkClickRoute,
          openTask: openTaskInApp,
          openTab: openTabInApp,
          openExternal: (u) => openLink(u, { external, origin: e.target }),
          warn: (message) => toast.warning(message),
        });
      }}
      onAuxClick={(e) => {
        // Middle click: the anchor's own `target="_blank"` would ask the shell
        // for a detached window, which is the thing this whole change removes.
        if (!href || e.button !== 1) return;
        e.preventDefault();
        openLink(href, { external: true, origin: e.target });
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

interface MarkdownBlockProps {
  source: string;
  offset: number;
  openFenceFrom: number | null;
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
  components: Components;
}

/**
 * One block of a message (see `lib/markdownBlocks.ts`). Memoized, so a block
 * that is already complete is not parsed again while a later one grows: that is
 * the whole point of cutting a message into blocks.
 */
const MarkdownBlock = memo(function MarkdownBlock({ source, offset, openFenceFrom, remarkPlugins, rehypePlugins, components }: MarkdownBlockProps) {
  const place = useMemo(() => ({ offset, openFenceFrom }), [offset, openFenceFrom]);
  return (
    <MarkdownBlockContext.Provider value={place}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {source}
      </ReactMarkdown>
    </MarkdownBlockContext.Provider>
  );
});

/**
 * `streaming`: the text is the end of a message that is still being written, so
 * its last block gets the marks a half-typed token leaves open closed for the
 * draw (`**bo` shows bold, not a stray asterisk).
 */
export const ChatMarkdown = memo(function ChatMarkdown({ components, children, streaming = false }: { components: Components; children: string; streaming?: boolean }) {
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

  // react-markdown re-parses its input from scratch on EVERY render (no internal
  // memoization), so a message that streams used to be parsed in full for every
  // token: O(n²) over a reply. The message is cut into blocks and each block is
  // memoized (`MarkdownBlock`), so only the tail is parsed again. The chat hot
  // path passes the module-const `markdownComponents` (stable ref), so a render
  // where the text has not changed costs a shallow compare per block. (Board
  // call sites pass a fresh `{}` and simply never hit: they are not a hot path.)
  const mods = needsMath ? mathMods : null;
  const extensions = useMemo(
    () => ({
      remark: mods ? [remarkGfm, mods.remark] : BASE_REMARK,
      rehype: mods ? [mods.rehype] : BASE_REHYPE,
    }),
    [mods],
  );
  const merged = useMemo(() => ({ ...DEFAULT_COMPONENTS, ...components }), [components]);
  const blocks = useMemo(() => {
    const placed: Array<{ source: string; at: number }> = [];
    let at = 0;
    for (const source of splitMarkdownBlocks(children)) {
      placed.push({ source, at });
      at += source.length;
    }
    return placed;
  }, [children]);

  // A tail that cannot be cut is parsed less often as it grows (see createTailGate).
  const gate = useRef<ReturnType<typeof createTailGate> | undefined>(undefined);
  gate.current ??= createTailGate();
  const [, catchUp] = useReducer((n: number) => n + 1, 0);
  const lastSource = blocks[blocks.length - 1]?.source ?? '';
  const tailSource = streaming ? gate.current.pick(lastSource, true) : lastSource;
  const behind = streaming && gate.current.behind(lastSource);
  useEffect(() => {
    if (!behind) return;
    // The stream may pause on a stale frame: come back and draw the real text.
    const timer = setTimeout(() => {
      gate.current?.release();
      catchUp();
    }, 120);
    return () => clearTimeout(timer);
  }, [behind, children]);

  return (
    <>
      {blocks.map((block, i) => {
        const tail = streaming && i === blocks.length - 1;
        const source = tail ? tailSource : block.source;
        return (
          <MarkdownBlock
            key={i}
            source={tail ? completePartialMarkdown(source) : block.source}
            offset={block.at}
            openFenceFrom={tail ? openFenceStart(source) : null}
            remarkPlugins={extensions.remark}
            rehypePlugins={extensions.rehype}
            components={merged}
          />
        );
      })}
    </>
  );
});
