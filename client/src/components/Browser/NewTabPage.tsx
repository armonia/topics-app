/**
 * La pagina di una scheda VUOTA del browser.
 *
 * Prima qui c'erano tre righe in inglese («Browser ready / Enter a URL above»)
 * su fondo grigio, e nel ramo nativo nemmeno quelle: la WKWebView su
 * `about:blank` è una superficie bianca e basta. Una scheda nuova è il posto in
 * cui si passa più spesso di qualunque altro, e non aveva né una destinazione
 * né un modo per ripartire senza rileggere l'indirizzo a memoria.
 *
 * Cosa c'è adesso, e nient'altro: un campo grande al centro (indirizzo o
 * ricerca, stessa regola della barra in alto, `toNavigableUrl`) e la griglia dei
 * siti più visitati, che viene dallo storico globale — vedi
 * `state/browserSiteHistory`. Niente meteo, niente notizie, niente sfondo del
 * giorno: il fondo è quello dell'app, i riquadri sono quelli dell'app.
 *
 * DOVE VIVE. La monta il pannello al posto del placeholder nativo, come già fa
 * per la scheda parcheggiata: montarla SOPRA non servirebbe a niente, perché
 * una view nativa composita sempre sopra il DOM. Senza placeholder nessuno
 * spinge un rettangolo alla view, che resta dov'è nata, fuori schermo.
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Search, X, Compass } from 'lucide-react';
import { BrowserFavicon } from './BrowserFavicon';
import { toNavigableUrl } from '../../lib/browserNavUrl';
import { forgetSite, rankSites, sitesSnapshot, subscribeSites } from '../../state/browserSiteHistory';
import { useT } from '../../hooks/useT';

/** Due righe da quattro. Oltre, la griglia diventa un elenco e i riquadri
 *  smettono di essere riconoscibili a colpo d'occhio. */
const TILES = 8;

export function NewTabPage({ onNavigate }: { onNavigate: (url: string) => void }) {
  const tr = useT();
  const [query, setQuery] = useState('');
  const stored = useSyncExternalStore(subscribeSites, sitesSnapshot, sitesSnapshot);
  // `stored` è l'identità che cambia a ogni scrittura: il riordino per frecency
  // si rifà solo allora, non a ogni tasto battuto nel campo.
  const sites = useMemo(() => rankSites(stored, TILES), [stored]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const target = query.trim();
    if (!target) return;
    setQuery('');
    // `toNavigableUrl` and not `normalizeUrl`: the same door as the bar above,
    // which is what the header claims. With `normalizeUrl` a path typed here
    // (`/Users/x/doc.pdf`) became a 404 on our own origin and `file://…` hit
    // the scheme refusal, two centimetres from a bar that opens both.
    onNavigate(toNavigableUrl(target));
  };

  return (
    <div
      className="flex-1 min-h-0 overflow-auto bg-app-bg relative"
      data-testid="browser-new-tab"
    >
      {/* Il fondo: un alone della tinta primaria in alto, molto diluito. Serve a
          togliere alla scheda vuota l'aria di pannello non ancora caricato. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-64 opacity-[0.13]"
        style={{ background: 'radial-gradient(60% 100% at 50% 0%, var(--primary), transparent 70%)' }}
      />

      <div className="relative min-h-full flex flex-col items-center justify-center px-6 py-10">
        <div className="w-full max-w-[560px]">
          <div className="flex flex-col items-center gap-3 mb-6">
            <span className="flex items-center justify-center w-11 h-11 rounded-2xl bg-app-panel border border-app-border-subtle text-primary shadow-sm">
              <Compass size={20} strokeWidth={1.75} />
            </span>
            <h1 className="text-[15px] font-medium text-app-text-heading">{tr('browser.newTab.title')}</h1>
          </div>

          <form onSubmit={submit} className="relative" data-testid="browser-new-tab-form">
            <Search
              size={15}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-faint pointer-events-none"
              aria-hidden
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr('browser.newTab.searchPlaceholder')}
              aria-label={tr('browser.newTab.searchPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              data-testid="browser-new-tab-input"
              className="w-full h-11 pl-10 pr-4 rounded-full bg-app-input border border-app-border-input text-[13px] text-app-text placeholder:text-app-placeholder shadow-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-colors"
            />
          </form>

          {sites.length > 0 ? (
            <div className="mt-8" data-testid="browser-new-tab-sites">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-app-text-faint mb-2 px-1">
                {tr('browser.newTab.topSites')}
              </p>
              <div className="grid grid-cols-4 gap-1.5">
                {sites.map((site) => (
                  <div key={site.host} className="relative group">
                    <button
                      type="button"
                      onClick={() => onNavigate(site.url)}
                      title={site.title || site.url}
                      data-testid="browser-new-tab-site"
                      className="w-full flex flex-col items-center gap-2 px-2 py-3 rounded-xl border border-transparent hover:border-app-border-subtle hover:bg-app-hover transition-colors"
                    >
                      <BrowserFavicon url={site.url} faviconUrl={site.favicon} size={22} />
                      <span className="w-full text-[11px] text-app-text-secondary truncate text-center">
                        {site.host}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => forgetSite(site.host)}
                      aria-label={tr('browser.newTab.forget', { host: site.host })}
                      title={tr('browser.newTab.forget', { host: site.host })}
                      data-testid="browser-new-tab-forget"
                      className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-app-panel border border-app-border-subtle text-app-text-faint opacity-0 group-hover:opacity-100 hover:text-app-text focus:opacity-100 transition-opacity"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-8 text-center text-[11px] text-app-text-faint" data-testid="browser-new-tab-empty">
              {tr('browser.newTab.empty')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
