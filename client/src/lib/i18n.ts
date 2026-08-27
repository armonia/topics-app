/**
 * Le stringhe dell'interfaccia, in più lingue.
 *
 * ── Perché un dizionario e non una traduzione a tappeto ──────────────────────
 * Oggi l'interfaccia è mescolata: ~98 stringhe in italiano e ~91 in inglese
 * (misurate il 04/08). Tradurle tutte in un colpo solo significherebbe cambiare
 * ~190 testi visibili in una volta, e la suite e2e ANCORA quei testi («Chiudi
 * ora», «Dividi a destra», «Rimuovi dai Fissati»). Il risultato sarebbe decine
 * di rossi tutti insieme, in cui un errore vero è indistinguibile da una stringa
 * spostata. Quindi: prima il meccanismo, poi una superficie alla volta, con i
 * suoi test aggiornati insieme. Chi arriva dopo aggiunge chiavi, non riscrive.
 *
 * ── Perché non una libreria ──────────────────────────────────────────────────
 * Serve questo: una chiave, due lingue, l'interpolazione di qualche valore. Una
 * libreria porterebbe plurali per lingue slave, caricamento asincrono dei
 * bundle, contesti e namespace, oltre a un peso e una configurazione che non
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

import type { Dict } from './i18n-types';

import IT from './i18n-it';

/**
 * Only Italian is here. English is fetched on demand by `ensureLocaleLoaded`
 * (see `i18n-en.ts` for why), so this map starts with one entry and grows to
 * two the first time somebody asks for English.
 */
const DICTS: Partial<Record<Locale, Dict>> = { it: IT };

let enPending: Promise<void> | null = null;

const catalogueListeners = new Set<() => void>();

/**
 * Le lingue gia' in memoria, come stringa stabile ("it" oppure "it,en").
 *
 * E' una STRINGA e non un array perche' `useSyncExternalStore` confronta gli
 * snapshot per identita': un array nuovo a ogni lettura sarebbe un ciclo di
 * render infinito, una stringa uguale a se stessa non lo e'.
 */
export function loadedLocales(): string {
  return DICTS.en ? 'it,en' : 'it';
}

/** Avvisa quando un catalogo atterra. */
export function subscribeCatalogues(cb: () => void): () => void {
  catalogueListeners.add(cb);
  return () => { catalogueListeners.delete(cb); };
}

/**
 * Makes sure `locale`'s catalogue is in memory, and resolves when it is.
 *
 * Idempotent and safe to call on every render: the second caller gets the first
 * caller's promise. A failed load is NOT cached as a failure, because the next
 * attempt may well be online; it just leaves the app in Italian, which is the
 * same state it is in for a key English does not have.
 */
export function ensureLocaleLoaded(locale: Locale): Promise<void> {
  if (locale !== 'en' || DICTS.en) return Promise.resolve();
  if (!enPending) {
    // `const { default: … } = await import(…)` e non `import(…).then((m) => m.default)`.
    // Non è stile: è la differenza fra un modulo che knip sa leggere e uno che
    // diventa un punto cieco. Con la forma `.then((m) => …)` il risolutore perde
    // il legame fra il modulo e i nomi che ne escono, e da lì dentro `i18n-en.ts`
    // un export morto non lo vedrebbe più nessuno — `check:deadcode-blindspots`
    // l'ha colto come REGRESSIONE il giorno stesso in cui il catalogo inglese è
    // stato spostato nel suo chunk. La destrutturazione ridà la vista.
    enPending = (async () => {
      try {
        const { default: EN } = await import('./i18n-en');
        DICTS.en = EN;
        catalogueListeners.forEach((cb) => cb());
      } catch (err) {
        enPending = null;
        console.warn('[i18n] English catalogue failed to load, staying in Italian:', err);
      }
    })();
  }
  return enPending;
}

/** La lingua di ripiego: quella in cui le chiavi esistono per prime. */
export const FALLBACK_LOCALE: Locale = 'it';

/**
 * Risolve la preferenza in una lingua vera.
 *
 * `auto` NON guarda più il browser, e la ragione è misurata. La migrazione
 * delle stringhe è PER SUPERFICIE (lo dice il pannello Aspetto), e tutto ciò
 * che NON è chrome del client — i chip che arrivano dal server, il testo che
 * scrivono gli agenti, i blocchi domanda, il contenuto delle card — è italiano
 * comunque. Quindi scegliere `en` da soli, perché il Mac è in inglese, non
 * produce una app inglese: produce una schermata METÀ inglese e metà italiana.
 *
 * Visto il 13/08 sulla board di questa casa: preferenza salvata `"auto"`,
 * sistema in inglese, e sulla stessa card «consegnato» accanto a «Land on
 * main», «Send it back», «I take it». Nessuna delle due lingue era quella
 * giusta, e chi guardava non aveva scelto niente.
 *
 * L'inglese resta raggiungibile, ma va CHIESTO: `pref === 'en'`. Una scelta
 * esplicita accetta il misto; un'inferenza dal sistema operativo lo impone a
 * chi non sapeva nemmeno di aver deciso.
 */
export function resolveLocale(pref: LocalePreference | undefined, _navigatorLanguage?: string): Locale {
  if (pref === 'it' || pref === 'en') return pref;
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
 *
 * ASINCRONA da quando l'inglese si carica su richiesta: senza l'attesa
 * risponderebbe «mancano tutte», che è vero e inutile. Chiedere il catalogo è
 * l'unico modo di distinguere «questa lingua è incompleta» da «questa lingua
 * non è ancora arrivata», e sono due difetti diversi.
 */
/**
 * Every key in the catalogue, for whoever has to check them one by one.
 *
 * It exists instead of exporting `IT`: the whole dictionary, made public,
 * invites reading a value straight out of it rather than going through `t()`,
 * and that is the road by which a string stops following the chosen language.
 */
export function chiaviDelCatalogo(): string[] {
  return Object.keys(IT);
}

export async function missingKeys(locale: Locale): Promise<string[]> {
  await ensureLocaleLoaded(locale);
  await ensureLocaleLoaded(FALLBACK_LOCALE);
  const en = DICTS.en ?? {};
  const all = new Set([...Object.keys(IT), ...Object.keys(en)]);
  return [...all].filter((k) => !(k in (DICTS[locale] ?? {}))).sort();
}

// ───────────────────────────────────────────────────────────────────────────
// La stessa scelta, dall'altra parte del filo
// ───────────────────────────────────────────────────────────────────────────

/**
 * «Lingua» è UNA preferenza sola: governa le stringhe qui sopra E la lingua in
 * cui il modello risponde. Ma i due lati hanno bisogni incompatibili. `t()` è
 * SINCRONA e deve dipingere il primo frame senza aspettare la rete, quindi la
 * copia dell'interfaccia vive in localStorage; il server invece deve poterla
 * leggere quando costruisce un prompt, e localStorage non ce l'ha.
 *
 * Da qui le due scritture: `AppSettings.language` (localStorage + `ui_state`,
 * per la UI) e la riga `app_settings.output_language` (migration 087, per il
 * modello). La verità è la seconda: è quella che chat, terminale, kanban e
 * contesto assemblato leggono.
 *
 * Non passa da `appSettingsApi` per una ragione sola e temporanea: quel modulo
 * non è nella proprietà di questa modifica, quindi il tipo `AppBehaviorSettings`
 * non conosce ancora `outputLanguage`. La chiamata è identica a quella che
 * farebbe `request()` (stessa base `/api`, stesso verbo, stesso corpo), quando
 * il campo entrerà nel tipo, queste due funzioni diventano due righe che
 * chiamano `appSettingsApi`.
 */
/**
 * Cosa dice il server sulla lingua. TRE stati e non due, perché due non
 * bastano: «la riga è vuota» e «non sono riuscito a leggerla» portano a
 * decisioni opposte. Chi riallinea i due depositi scrive la preferenza locale
 * SOLO sul primo. Trattare un errore di rete come «vuoto» significherebbe
 * sovrascrivere con il localStorage di questa finestra una scelta appena fatta
 * da un'altra, proprio nel momento in cui non se ne sa niente.
 */
export type ServerLanguage =
  | { known: true; value: LocalePreference | null }
  | { known: false };

export async function fetchOutputLanguage(): Promise<ServerLanguage> {
  try {
    const res = await fetch('/api/app-settings');
    if (!res.ok) return { known: false };
    const body = (await res.json()) as { settings?: { outputLanguage?: string | null } };
    const raw = body.settings?.outputLanguage;
    if (raw === 'it' || raw === 'en' || raw === 'auto') return { known: true, value: raw };
    if (raw == null) return { known: true, value: null };
    // Valore fuori scala (riga scritta a mano, DB di un'altra versione): il
    // server c'è e ha risposto, ma quello che dice non si sa leggere.
    return { known: false };
  } catch {
    return { known: false };
  }
}

/** Scrive la scelta nella riga `app_settings`. Best-effort: un fallimento non
 *  deve poter bloccare il selettore, che ha già aggiornato la UI. */
export async function pushOutputLanguage(pref: LocalePreference): Promise<void> {
  try {
    await fetch('/api/app-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputLanguage: pref }),
    });
  } catch {
    /* la UI resta com'è: la prossima scelta riprova */
  }
}
