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
import { openTaskInApp } from '../lib/openTaskLink';
import { deepLinkClickRoute, openTabInApp } from '../lib/tabLink';

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
 * Niente toast sul fallimento: il valore del context dei toast NON è memoizzato
 * (ToastProvider ricrea l'oggetto a ogni render di App), quindi bastava un
 * `useToast()` qui dentro per rendere OGNI link di OGNI messaggio un consumatore
 * che si ri-renderizza a ogni giro — proprio ciò che il `useMemo` di questo file
 * esiste per evitare.
 *
 * Ma un click che non fa e non dice NULLA è il peggiore dei tre esiti, e per un
 * anno è stato quello che succedeva: nessun call-site passava `notify`, quindi
 * ogni rifiuto era un no-op silenzioso. Qui il canale giusto non è il toast, è
 * il RIPIEGO: se non riusciamo ad aprirlo in casa, `openExternalOnce` lo apre
 * fuori — cioè esattamente ciò che questo link faceva PRIMA che i self-origin
 * venissero intercettati. L'utente vede il contenuto, che è il punto; e se
 * davvero quel target non esiste più, glielo dirà la copia web.
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
        const route = deepLinkClickRoute(href);
        if (route.via === 'task') { openTaskInApp(route.target); return; }
        if (route.via === 'tab') {
          // `notify` = il ripiego, non un messaggio: `openTabInApp` lo chiama
          // UNA volta sola e solo su vicolo cieco (vedi `deadEnd`), e
          // `openExternalOnce` dedupa comunque il doppio click.
          //
          // Ma il ripiego vale SOLO se in casa non si è aperto niente. Un
          // `/tab/file/…` apre prima la finestra di progetto e poi insegue il
          // file: se quel secondo hop si arrende, il vicolo cieco arriva a cose
          // già aperte, e ripiegare lì significherebbe lasciare l'utente con la
          // finestra di progetto in-app PIÙ una seconda copia completa di Topics
          // nel browser di sistema. `onRouted` disarma il ripiego appena
          // qualcosa è partito davvero.
          let openedInApp = false;
          openTabInApp(route.target, {
            onRouted: () => { openedInApp = true; },
            notify: () => { if (!openedInApp) openExternalOnce(href); },
          });
          return;
        }
        openExternalOnce(href);
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
