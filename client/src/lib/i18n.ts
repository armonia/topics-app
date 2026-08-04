/**
 * Le stringhe dell'interfaccia, in più lingue.
 *
 * ── Perché un dizionario e non una traduzione a tappeto ──────────────────────
 * Oggi l'interfaccia è mescolata: ~98 stringhe in italiano e ~91 in inglese
 * (misurate il 04/08). Tradurle tutte in un colpo solo significherebbe cambiare
 * ~190 testi visibili in una volta — e la suite e2e ANCORA quei testi («Chiudi
 * ora», «Dividi a destra», «Rimuovi dai Fissati»). Il risultato sarebbe decine
 * di rossi tutti insieme, in cui un errore vero è indistinguibile da una stringa
 * spostata. Quindi: prima il meccanismo, poi una superficie alla volta, con i
 * suoi test aggiornati insieme. Chi arriva dopo aggiunge chiavi, non riscrive.
 *
 * ── Perché non una libreria ──────────────────────────────────────────────────
 * Serve questo: una chiave, due lingue, l'interpolazione di qualche valore. Una
 * libreria porterebbe plurali per lingue slave, caricamento asincrono dei
 * bundle, contesti e namespace — e un peso e una configurazione che non
 * ripagano finché le lingue sono due.
 *
 * ── Il ripiego è deliberato ──────────────────────────────────────────────────
 * Una chiave mancante nella lingua scelta cade sull'ALTRA lingua, non sulla
 * chiave nuda: un testo nella lingua sbagliata è brutto, `board.night.title` in
 * mezzo alla pagina è rotto. In sviluppo la mancanza si vede comunque, perché
 * `missingKeys()` la elenca e un test la può leggere.
 */

export type Locale = 'it' | 'en';

/** La preferenza dell'utente: `auto` segue il browser. */
export type LocalePreference = Locale | 'auto';

type Dict = Record<string, string>;

/**
 * Le stringhe. Le chiavi sono `superficie.cosa`, e la superficie è quella
 * dell'interfaccia (non del file): chi cerca «dov'è questo testo» parte da ciò
 * che vede.
 */
const IT: Dict = {
  'board.night.title': 'Modalità notturna',
  'board.night.blurb':
    "Mentre sei via, la coda parte solo a macchina libera — e si spegne da sola all'orario di fine, invece di restare armata addosso a chi lavora.",
  'board.night.until': 'Si ferma alle',
  'board.night.state.off': 'Spenta',
  'board.night.state.off.detail': 'La board dispaccia come sempre, senza guardare il carico.',
  'board.night.state.go': 'Sta dispacciando',
  'board.night.state.go.detail': 'Macchina libera: i task in coda partono.',
  'board.night.state.wait': 'In attesa',
  'board.night.state.expired': 'Scaduta',
  'board.night.state.expired.detail': "Orario di fine raggiunto: si spegne al prossimo giro.",
  'board.night.state.checking': 'Controllo…',
  'board.night.state.unknown': 'Stato non disponibile',
  'board.night.state.unknown.detail': 'Il server non ha risposto: riprovo fra poco.',
  'board.night.load': 'Carico',
  'board.night.cores': '{n} core',
  'board.night.nobodyAttached': 'Nessuno attaccato a una sessione',
  'board.night.sessions.one': '1 sessione attiva',
  'board.night.sessions.many': '{n} sessioni attive',
  'board.night.endsIn': 'Si spegne fra {t}',
  'time.lessThanAMinute': 'meno di un minuto',
  'time.minutes': '{n} min',
  'time.hours': '{n}h',
  'time.hoursMinutes': '{h}h {m}min',
  'tab.menu.rename': 'Rinomina',
  'tab.menu.copyUrl': 'Copia URL della pagina',
  'tab.menu.closeNow': 'Chiudi ora',
  'tab.menu.closeCountdown': 'Chiudi (con conto alla rovescia)',
  'tab.menu.closeOthers': 'Chiudi le altre',
  'tab.menu.splitRight': 'Dividi a destra',
  'tab.menu.splitDown': 'Dividi in basso',
  'tab.menu.pin': 'Fissa',
  'tab.menu.unpin': 'Rimuovi dai Fissati',
  'settings.language': 'Lingua',
  'settings.language.auto': 'Automatica (come il browser)',
  'settings.language.it': 'Italiano',
  'settings.language.en': 'English',
};

const EN: Dict = {
  'board.night.title': 'Night mode',
  'board.night.blurb':
    'While you are away, the queue only starts on an idle machine — and it switches itself off at the end time instead of staying armed over whoever is working.',
  'board.night.until': 'Stops at',
  'board.night.state.off': 'Off',
  'board.night.state.off.detail': 'The board dispatches as usual, ignoring machine load.',
  'board.night.state.go': 'Dispatching',
  'board.night.state.go.detail': 'Machine is idle: queued tasks start.',
  'board.night.state.wait': 'Waiting',
  'board.night.state.expired': 'Expired',
  'board.night.state.expired.detail': 'End time reached: it switches off on the next pass.',
  'board.night.state.checking': 'Checking…',
  'board.night.state.unknown': 'Status unavailable',
  'board.night.state.unknown.detail': 'The server did not answer: retrying shortly.',
  'board.night.load': 'Load',
  'board.night.cores': '{n} cores',
  'board.night.nobodyAttached': 'Nobody attached to a session',
  'board.night.sessions.one': '1 active session',
  'board.night.sessions.many': '{n} active sessions',
  'board.night.endsIn': 'Switches off in {t}',
  'time.lessThanAMinute': 'less than a minute',
  'time.minutes': '{n} min',
  'time.hours': '{n}h',
  'time.hoursMinutes': '{h}h {m}min',
  'tab.menu.rename': 'Rename',
  'tab.menu.copyUrl': 'Copy page URL',
  'tab.menu.closeNow': 'Close now',
  'tab.menu.closeCountdown': 'Close (with countdown)',
  'tab.menu.closeOthers': 'Close the others',
  'tab.menu.splitRight': 'Split right',
  'tab.menu.splitDown': 'Split down',
  'tab.menu.pin': 'Pin',
  'tab.menu.unpin': 'Unpin',
  'settings.language': 'Language',
  'settings.language.auto': 'Automatic (follow the browser)',
  'settings.language.it': 'Italiano',
  'settings.language.en': 'English',
};

const DICTS: Record<Locale, Dict> = { it: IT, en: EN };

/** La lingua di ripiego: quella in cui le chiavi esistono per prime. */
export const FALLBACK_LOCALE: Locale = 'it';

/**
 * Risolve la preferenza in una lingua vera. `auto` guarda il browser e ricade
 * sull'italiano — che è la lingua di questa casa, non un default universale.
 */
export function resolveLocale(pref: LocalePreference | undefined, navigatorLanguage?: string): Locale {
  if (pref === 'it' || pref === 'en') return pref;
  const lang = (navigatorLanguage ?? '').toLowerCase();
  if (lang.startsWith('en')) return 'en';
  return FALLBACK_LOCALE;
}

/** Sostituisce `{nome}` con i valori passati. Un segnaposto senza valore resta com'è. */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * La stringa per una chiave. Ripiega sull'altra lingua prima che sulla chiave:
 * un testo nella lingua sbagliata è brutto, una chiave a schermo è rotta.
 */
export function t(key: string, locale: Locale, vars?: Record<string, string | number>): string {
  const raw = DICTS[locale]?.[key] ?? DICTS[FALLBACK_LOCALE]?.[key] ?? key;
  return interpolate(raw, vars);
}

/**
 * Le chiavi che una lingua non ha. Serve a un test: una lingua incompleta è un
 * fatto che si scopre in fretta, non guardando l'interfaccia a caso.
 */
export function missingKeys(locale: Locale): string[] {
  const all = new Set([...Object.keys(IT), ...Object.keys(EN)]);
  return [...all].filter((k) => !(k in (DICTS[locale] ?? {}))).sort();
}
