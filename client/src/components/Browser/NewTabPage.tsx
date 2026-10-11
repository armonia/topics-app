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
 *
 * NEWTAB-ARC. The field above is also the page's command line, Arc-style: it
 * takes the focus when the tab opens, and typing filters four suggestion lists
 * (open browser tabs, recent pages, top sites, commands) drawn with the same
 * row the tab sheet uses. Submitting classifies (`lib/newtabClassify`): a url
 * navigates, a `/command` fills itself back for the chat to run, a long or
 * multiline text offers a note in the topic's project folder.
 *
 * THE FOCUS RACE, AND WHO WINS IT. A fresh pane also auto-opens its tab sheet
 * on the address (TOPIC-BROWSER-02, still required), which focuses the sheet's
 * own input ~50ms after this field focused itself. The field retakes a focus
 * that lands inside the sheet — only the sheet, never a focus the person
 * moved — until the first key or pointer press retires the guard, with a wide
 * time backstop. Event-driven, no timer duel: whichever frame the sheet steals
 * on, the guard takes it back on that same `focusin`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Search, X, Compass, Clock, Globe, FilePlus } from 'lucide-react';
import { BrowserFavicon } from './BrowserFavicon';
import { toNavigableUrl } from '../../lib/browserNavUrl';
import { classifyNewTabSubmit, slugNewTabNoteName } from '../../lib/newtabClassify';
import { buildNewTabSuggestions, type NewTabSectionId, type NewTabSuggestionRow } from '../../lib/newtabSuggest';
import { forgetSite, pagesSnapshot, rankSites, sitesSnapshot, subscribeSites } from '../../state/browserSiteHistory';
import { usePaneStore } from '../../state/pane/store';
import { createPaneId } from '../../state/pane/adapters';
import { closeTabSheet } from '../../state/tabSheet';
import { SLASH_COMMANDS } from '../Chat/slashCommands';
import { Suggestion, SuggestionSectionLabel } from '../Shared/Suggestion';
import { POPOVER_SURFACE } from '../../lib/popoverStyles';
import { useExitGhost } from '../../lib/exitGhost';
import { ApiError, filesApi } from '../../lib/api';
import { useT } from '../../hooks/useT';
import { useToast } from '../Shared/Toast';

/** Due righe da quattro. Oltre, la griglia diventa un elenco e i riquadri
 *  smettono di essere riconoscibili a colpo d'occhio. */
const TILES = 8;

const COMMAND_NAMES = SLASH_COMMANDS.map((c) => c.cmd);

/**
 * How long after mount the field retakes a focus the tab sheet stole. The
 * real guard is the first user gesture (below); this is the backstop for a
 * sheet that opens late — a cold chunk, a native view handing the keyboard
 * back seconds later — and it only ever fires without a gesture in between.
 */
const SHEET_STEAL_WINDOW_MS = 15_000;

/** One selectable row: the note action first, then the section rows in order. */
type FlatItem = NewTabSuggestionRow | 'file';

export function NewTabPage({ onNavigate, projectPath }: { onNavigate: (url: string) => void; projectPath?: string }) {
  const tr = useT();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const suggestRef = useRef<HTMLDivElement>(null);
  const creatingRef = useRef(false);

  // THE FIELD TAKES THE FOCUS, AND KEEPS IT AGAINST THE SHEET. See the header:
  // the only focus this retakes is one that lands inside the tab sheet, and
  // only until the person presses anything. An explicit sheet (Cmd+L, the
  // dots, a click on the tab) always arrives behind a gesture, so it is never
  // robbed; the auto-opened one is never preceded by one, so it never wins.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const bornAt = Date.now();
    let mine = false;
    let retired = false;
    inputRef.current?.focus({ preventScroll: true });
    const retire = () => { retired = true; };
    const retake = (e: FocusEvent) => {
      if (retired || mine) return;
      if (Date.now() - bornAt > SHEET_STEAL_WINDOW_MS) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (rootRef.current?.contains(target)) return;
      if (!target.closest('[data-testid="tab-sheet"]')) return;
      mine = true;
      try {
        inputRef.current?.focus({ preventScroll: true });
      } finally {
        mine = false;
      }
    };
    document.addEventListener('pointerdown', retire, true);
    document.addEventListener('keydown', retire, true);
    document.addEventListener('focusin', retake);
    return () => {
      document.removeEventListener('pointerdown', retire, true);
      document.removeEventListener('keydown', retire, true);
      document.removeEventListener('focusin', retake);
    };
  }, []);

  const panes = usePaneStore((s) => s.panes);
  const dispatch = usePaneStore((s) => s.dispatch);
  const stored = useSyncExternalStore(subscribeSites, sitesSnapshot, sitesSnapshot);
  // The pages ride the same subscription: one write notifies both lists.
  const storedPages = useSyncExternalStore(subscribeSites, pagesSnapshot, pagesSnapshot);
  // `stored` è l'identità che cambia a ogni scrittura: il riordino per frecency
  // si rifà solo allora, non a ogni tasto battuto nel campo.
  const sites = useMemo(() => rankSites(stored, TILES), [stored]);

  const sections = useMemo(
    () => buildNewTabSuggestions({ query, panes, sites: stored, pages: storedPages, commands: SLASH_COMMANDS }),
    [query, panes, stored, storedPages],
  );
  const classification = useMemo(() => classifyNewTabSubmit(query, COMMAND_NAMES), [query]);
  const showFileRow = classification?.kind === 'file' && !!projectPath;
  const noteName = useMemo(
    () => (showFileRow ? `${slugNewTabNoteName(query.trim())}.md` : ''),
    [showFileRow, query],
  );

  const flatRows: { key: string; item: FlatItem }[] = useMemo(() => {
    const out: { key: string; item: FlatItem }[] = [];
    if (showFileRow) out.push({ key: 'file', item: 'file' });
    for (const section of sections) {
      for (const row of section.rows) out.push({ key: row.key, item: row });
    }
    return out;
  }, [showFileRow, sections]);
  const indexByKey = useMemo(() => new Map(flatRows.map((f, i) => [f.key, i])), [flatRows]);
  // The shared exit for the entering surface above (MOTION-04): the dropdown
  // leaves like every other popover instead of just vanishing.
  const dropOpen = flatRows.length > 0 && !dismissed;
  useExitGhost(suggestRef, dropOpen, 'popover');

  // A selection never survives a text change: the rows it pointed at are gone.
  useEffect(() => { setActiveIndex(-1); setDismissed(false); }, [query]);

  // The field grows with a note being written, up to four rows, then scrolls.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [query]);

  const fillCommand = useCallback((cmd: string) => {
    const entry = SLASH_COMMANDS.find((c) => c.cmd === cmd);
    setQuery(entry?.takesArgs ? `${cmd} ` : cmd);
    // Picking consumes the selection: without this an Enter right after the
    // click would re-activate the row instead of submitting the field.
    setActiveIndex(-1);
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const createNote = useCallback(async () => {
    const text = query.trim();
    if (!projectPath || !text || creatingRef.current) return;
    creatingRef.current = true;
    try {
      // `create` first, so an existing note with the same slug is never
      // overwritten: it answers 409 and the name grows a suffix. `save`
      // alone would clobber it in silence.
      const base = slugNewTabNoteName(text);
      let name = `${base}.md`;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await filesApi.create(`${projectPath}/${name}`);
          break;
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            name = `${base}-${attempt + 2}.md`;
            continue;
          }
          throw e;
        }
      }
      const path = `${projectPath}/${name}`;
      await filesApi.save(path, text);
      // A navigation closes the sheet; a note does too — the editor it opens
      // is the surface in front now.
      closeTabSheet();
      setQuery('');
      window.dispatchEvent(new CustomEvent('open-file', {
        detail: { path, topicId: createPaneId('project', projectPath) },
      }));
    } catch {
      toast.error(tr('browser.newTab.createFailed'));
    } finally {
      creatingRef.current = false;
    }
  }, [query, projectPath, toast, tr]);

  const activate = useCallback((item: FlatItem) => {
    if (item === 'file') {
      void createNote();
      return;
    }
    if (item.kind === 'tab' && item.paneId) {
      closeTabSheet();
      dispatch({ type: 'FOCUS_PANE', payload: { id: item.paneId } });
      return;
    }
    if (item.kind === 'command' && item.cmd) {
      fillCommand(item.cmd);
      return;
    }
    if (item.url) {
      closeTabSheet();
      setQuery('');
      // `toNavigableUrl` and not `normalizeUrl`: the same door as the bar above,
      // which is what the header claims. With `normalizeUrl` a path typed here
      // (`/Users/x/doc.pdf`) became a 404 on our own origin and `file://…` hit
      // the scheme refusal, two centimetres from a bar that opens both.
      onNavigate(item.url);
    }
  }, [createNote, fillCommand, dispatch, onNavigate]);

  const doSubmit = useCallback(() => {
    const picked = activeIndex >= 0 ? flatRows[activeIndex] : undefined;
    if (picked) {
      activate(picked.item);
      return;
    }
    const text = query.trim();
    if (!text) return;
    const decided = classifyNewTabSubmit(text, COMMAND_NAMES);
    if (!decided) return;
    if (decided.kind === 'url') {
      closeTabSheet();
      setQuery('');
      onNavigate(decided.value);
    } else if (decided.kind === 'file') {
      // Without a project there is no folder to write to: the text travels as
      // an address instead, under the same rule as everything else typed here.
      if (projectPath) void createNote();
      else {
        closeTabSheet();
        setQuery('');
        onNavigate(toNavigableUrl(text));
      }
    } else {
      fillCommand(decided.value);
    }
  }, [activeIndex, flatRows, query, projectPath, activate, createNote, fillCommand, onNavigate]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSubmit();
    } else if (e.key === 'ArrowDown' && dropOpen) {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flatRows.length);
    } else if (e.key === 'ArrowUp' && dropOpen) {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + flatRows.length) % flatRows.length);
    } else if (e.key === 'Escape') {
      // The capture wrapper above this pane (BrowserKeyboardCapture) stops
      // every key before the document, so Esc never reaches the sheet's own
      // closer while the caret sits here: this field forwards it by hand.
      // Both at once, like the sheet's own field (TabSheetBody), whose Esc
      // closes the sheet WITH its suggestions in one press: dismissing only
      // the dropdown would eat the press three pinned specs spend on the
      // sheet (LAYOUT-40, TABSHEET-02, motion), and the two are sibling
      // chrome of one interaction, not nested levels.
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
      setActiveIndex(-1);
      closeTabSheet();
    }
  }, [doSubmit, dropOpen, flatRows.length]);

  const sectionTitle = useCallback((id: NewTabSectionId): string => {
    switch (id) {
      case 'tabs': return tr('browser.newTab.openTabs');
      case 'recent': return tr('browser.newTab.recent');
      case 'top': return tr('browser.newTab.topSites');
      case 'commands': return tr('browser.newTab.commands');
    }
  }, [tr]);

  const rowIcon = useCallback((row: NewTabSuggestionRow): React.ReactNode => {
    switch (row.kind) {
      case 'recent':
        return row.favicon
          ? <BrowserFavicon url={row.url ?? ''} faviconUrl={row.favicon} size={13} />
          : <Clock size={13} />;
      case 'tab': return <Globe size={13} />;
      case 'top':
        return row.favicon
          ? <BrowserFavicon url={row.url ?? ''} faviconUrl={row.favicon} size={13} />
          : <Compass size={13} />;
      case 'command': {
        const entry = SLASH_COMMANDS.find((c) => c.cmd === row.cmd);
        const Icon = entry?.icon ?? Compass;
        return <Icon size={13} />;
      }
    }
  }, []);

  const rowSecondary = useCallback((row: NewTabSuggestionRow): string | undefined => {
    if (row.kind !== 'command' || !row.cmd) return row.secondary;
    const entry = SLASH_COMMANDS.find((c) => c.cmd === row.cmd);
    return entry ? tr(entry.descriptionKey) : undefined;
  }, [tr]);

  const filtering = query.trim() !== '';

  return (
    <div
      ref={rootRef}
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
            <h1 className="text-title font-medium text-app-text-heading">{tr('browser.newTab.title')}</h1>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); doSubmit(); }} className="relative" data-testid="browser-new-tab-form">
            <Search
              size={15}
              className="absolute left-4 top-[22px] -translate-y-1/2 text-app-text-faint pointer-events-none"
              aria-hidden
            />
            <textarea
              ref={inputRef}
              rows={1}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={tr('browser.newTab.searchPlaceholder')}
              aria-label={tr('browser.newTab.searchPlaceholder')}
              enterKeyHint="go"
              spellCheck={false}
              autoComplete="off"
              data-testid="browser-new-tab-input"
              className="w-full min-h-11 max-h-48 py-2.5 pl-10 pr-4 rounded-2xl bg-app-input border border-app-border-input text-prose text-app-text placeholder:text-app-placeholder shadow-sm outline-none resize-none overflow-y-auto focus:border-primary focus:ring-2 focus:ring-primary/20 transition-colors"
            />
          </form>

          {dropOpen && (
            <div
              // The sheet's own surface: same rows, same tokens. (`bg-app-panel`
              // is deliberately dark in the light theme — not a shortcut to a
              // light background — and would plant a dark box on a white page.)
              ref={suggestRef}
              className={`mt-3 ${POPOVER_SURFACE} overflow-hidden`}
              data-testid="browser-new-tab-suggestions"
            >
              {showFileRow && (
                <Suggestion
                  icon={<FilePlus size={13} />}
                  primary={tr('browser.newTab.createFile')}
                  secondary={noteName}
                  title={noteName}
                  onClick={() => activate('file')}
                  testId="browser-new-tab-create-file"
                  active={activeIndex === 0}
                  dataKind="file"
                  dataValue={noteName}
                  onHover={() => setActiveIndex(indexByKey.get('file') ?? -1)}
                />
              )}
              {sections.map((section) => (
                <div key={section.id} data-testid="browser-new-tab-section" data-section={section.id}>
                  <SuggestionSectionLabel>{sectionTitle(section.id)}</SuggestionSectionLabel>
                  {section.rows.map((row) => (
                    <Suggestion
                      key={row.key}
                      icon={rowIcon(row)}
                      primary={row.primary}
                      secondary={rowSecondary(row)}
                      title={row.title}
                      onClick={() => activate(row)}
                      testId="browser-new-tab-suggestion"
                      active={indexByKey.get(row.key) === activeIndex}
                      dataKind={row.kind}
                      dataValue={row.kind === 'command' ? row.cmd : row.url}
                      onHover={() => setActiveIndex(indexByKey.get(row.key) ?? -1)}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* While typing, the lists above replace the grid: unfiltered, the
              top section would say what the grid already says. */}
          {!filtering && (sites.length > 0 ? (
            <div className="mt-8" data-testid="browser-new-tab-sites">
              <p className="text-mini font-semibold uppercase tracking-wider text-app-text-faint mb-2 px-1">
                {tr('browser.newTab.topSites')}
              </p>
              <div className="grid grid-cols-4 gap-1.5">
                {sites.map((site) => (
                  <div key={site.host} className="relative group">
                    <button
                      type="button"
                      onClick={() => { closeTabSheet(); onNavigate(site.url); }}
                      title={site.title || site.url}
                      data-testid="browser-new-tab-site"
                      className="w-full flex flex-col items-center gap-2 px-2 py-3 rounded-xl border border-transparent hover:border-app-border-subtle hover:bg-app-hover transition-colors"
                    >
                      <BrowserFavicon url={site.url} faviconUrl={site.favicon} size={22} />
                      <span className="w-full text-mini text-app-text-secondary truncate text-center">
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
            <p className="mt-8 text-center text-mini text-app-text-faint" data-testid="browser-new-tab-empty">
              {tr('browser.newTab.empty')}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
