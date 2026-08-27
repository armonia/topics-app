import type { AppSettings } from '../types';

export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  messageDensity: 'comfortable',
  sidebarWidth: 256,
  sidebarCollapsed: false,
  // La larghezza a cui riaprire la sidebar. `undefined` di serie — ma la chiave
  // deve ESSERCI: `loadSettings`, `sanitizeSettingsPayload` e `syncableSettings`
  // scorrono `Object.keys(DEFAULT_SETTINGS)`, quindi una chiave assente qui non
  // sopravviverebbe nemmeno a un giro di localStorage.
  sidebarWidthExpanded: undefined,
  // Notifications default to on with sound; users disable from Settings.
  // `notifyEvenWhenFocused` defaults to ON: with several topics open in
  // parallel the user wants the completion cue even on the visible one. The
  // toggle stays in Settings → Notifications for anyone who prefers it quiet.
  notificationsEnabled: true,
  notificationsSound: true,
  notifyEvenWhenFocused: true,
  // Per-project notification mute — empty by default. Holds project paths whose
  // topics' completion banners are silenced; the completions still count toward
  // the app badge. Round-trips through the server `settings` key like every
  // other AppSettings field (sanitizeSettingsPayload keeps keys present here).
  mutedProjects: [],
  // Lingua dell'interfaccia: `auto` segue il browser (e ricade sull'italiano).
  language: 'auto',
  // Experimental floating-splits layout — OFF by default, desktop-only.
  floatingSplits: false,
  // Misura di lettura della chat. 820px sta attorno alle 90 colonne al corpo di
  // serie: la stessa fascia in cui si tengono le superfici di lettura serie,
  // Claude Code nel terminale compreso. Attiva di serie perché il difetto che
  // corregge — la riga lunga quanto la pane, dove l'occhio perde il rigo
  // tornando a capo — si vede appena la finestra è larga, cioè quasi sempre.
  // 0 = piena larghezza, per chi la preferisce com'era.
  chatMaxWidth: 820,
  // La riga «Board generale» in cima alla sidebar: c'è perché la superficie
  // esiste, non perché oggi ci sia lavoro aperto. Vedi AppSettings.
  showBoardRow: true,
  // Voice loop board — off by default: it takes over the microphone and
  // speaks, which is not something to switch on for the user without asking.
  voiceMode: 'off',
};

const STORAGE_KEY = 'app-settings';
/** La chiave `ui_state` lato server. Stessa rotta di `sidebar-state`. */
export const SETTINGS_SERVER_KEY = 'settings';

/**
 * Le due preferenze che NON viaggiano: sono geometria di QUESTA finestra.
 *
 * La larghezza della sidebar di un 27" su un telefono è metà schermo, e
 * "collassata" è lo stato di una finestra, non una preferenza dell'utente (le
 * finestre staccate e il mobile la forzano da sé). Restano in `AppSettings`
 * perché è lì che il resto dell'app le legge, ma non entrano né nel payload
 * verso il server né nell'idratazione (il server le rimuove comunque a sua
 * volta, `stripDeviceLocalFields`).
 */
export const DEVICE_LOCAL_SETTING_KEYS = ['sidebarWidth', 'sidebarCollapsed', 'sidebarWidthExpanded'] as const;

export function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      // Spread CIECO no: solo le chiavi che esistono ancora. Una spread cieca
      // fa sopravvivere per sempre i campi ritirati — `syncableSettings` li
      // ricopia nel PUT e tornano su al server a ogni salvataggio, come
      // fossili. È già successo con `enableNewChat` (rimosso 2026-08-06).
      // `sanitizeSettingsPayload` fa lo stesso filtro sul verso opposto.
      const parsed: unknown = JSON.parse(saved);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const known: Record<string, unknown> = {};
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (key in (parsed as Record<string, unknown>)) known[key] = (parsed as Record<string, unknown>)[key];
        }
        return { ...DEFAULT_SETTINGS, ...(known as Partial<AppSettings>) };
      }
    }
  } catch {}
  return DEFAULT_SETTINGS;
}

let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

// Event name fired on every settings write so live consumers can re-read
// without polling localStorage on every render (see MessageList).
export const SETTINGS_CHANGED_EVENT = 'app-settings-changed';

// ── Idratazione dal server ───────────────────────────────────────────────────
//
// Il PUT c'era da sempre; la LETTURA no. Le preferenze salivano al server e
// non tornavano mai giù: bastava un altro dispositivo, un localStorage pulito
// o la WebView del guscio desktop (storage suo) per ritrovarsi le notifiche
// riaccese e il font di default, con il valore giusto fermo sul server.
//
// Il verso di lettura è modellato su `useSidebarState`, incluse le sue due
// lezioni pagate care: si sanifica SEMPRE (il payload potrebbe essere una
// busta GET annidata, e una spread cieca la ripersiste per sempre), e non si
// SCRIVE prima di aver letto (un client fresco che tocca un toggle prima della
// GET pubblicherebbe i DEFAULT, cancellando le preferenze di tutti — è
// esattamente così che si persero i pin della sidebar).

let hydrated = false;
let lastLocalChange = 0;
// La modifica fatta PRIMA che l'idratazione arrivi non si butta: si parcheggia
// e parte appena il canale è aperto. Buttarla renderebbe il gate una perdita
// silenziosa di dati invece di una precedenza.
let pendingPut: AppSettings | null = null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True se `v` è una busta GET (`{ value, server_seq }`) invece dello stato. */
function looksLikeEnvelope(v: Record<string, unknown>): boolean {
  return 'value' in v && ('server_seq' in v || 'payload_version' in v);
}

/** Normalizza QUALSIASI payload persistito/broadcast in un parziale pulito:
 *  scende attraverso le buste annidate, tiene solo le chiavi note e butta le
 *  device-local. Roba come `payload_version` non deve mai rientrare nello
 *  stato, o al PUT successivo torna su al server. Esportata per i test. */
export function sanitizeSettingsPayload(raw: unknown): Partial<AppSettings> | null {
  let cur: unknown = raw;
  for (let depth = 0; isRecord(cur) && looksLikeEnvelope(cur) && depth < 10; depth++) {
    cur = cur.value;
  }
  if (!isRecord(cur)) return null;
  const deviceLocal = new Set<string>(DEVICE_LOCAL_SETTING_KEYS);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (deviceLocal.has(key)) continue;
    if (key in cur) out[key] = cur[key];
  }
  return out as Partial<AppSettings>;
}

/** Il payload che sale al server: le preferenze VERE, senza la geometria di
 *  questa finestra. */
export function syncableSettings(settings: AppSettings): Partial<AppSettings> {
  const out: Record<string, unknown> = { ...settings };
  for (const key of DEVICE_LOCAL_SETTING_KEYS) delete out[key];
  return out as Partial<AppSettings>;
}

/**
 * Applica un valore arrivato dal server: lo fonde SOTTO il locale per le
 * chiavi device-local (che restano di questa finestra), lo scrive in
 * localStorage e sveglia i consumatori vivi.
 *
 * Ritorna il valore fuso, o null se il payload non conteneva niente di
 * usabile — un `null` non deve mai far ripiegare l'app sui default: le
 * preferenze locali sono più fresche del nulla.
 */
export function applyServerSettings(raw: unknown): AppSettings | null {
  const sv = sanitizeSettingsPayload(raw);
  if (!sv || Object.keys(sv).length === 0) return null;
  const merged: AppSettings = { ...loadSettings(), ...sv };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)); } catch {}
  try { window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT)); } catch {}
  return merged;
}

/** Sblocca il PUT, e manda quello eventualmente rimasto in attesa. Va chiamata
 *  quando la GET iniziale ha ESITO — riuscita o fallita: se il server non
 *  risponde il PUT fallirebbe comunque, e tenere il client muto per sempre
 *  sarebbe peggio. */
export function markSettingsHydrated(): void {
  hydrated = true;
  const pending = pendingPut;
  pendingPut = null;
  if (pending) putSettings(pending);
}

/** Da quanto l'utente ha toccato un'impostazione qui. Il verso di lettura la
 *  usa per non sovrascrivere una modifica appena fatta con un frame in volo. */
export function msSinceLocalSettingsChange(): number {
  return Date.now() - lastLocalChange;
}

/** Solo per i test: riporta il modulo allo stato di boot. */
export function __resetSettingsSyncState(): void {
  hydrated = false;
  lastLocalChange = 0;
  pendingPut = null;
  if (settingsSaveTimer) { clearTimeout(settingsSaveTimer); settingsSaveTimer = null; }
}

function putSettings(settings: AppSettings): void {
  // PANE-01-ALLOWED: non-pane ui-state key (app settings: fontSize, density, notifications). Not one of the 6 legacy pane keys.
  fetch(`/api/ui-state/${SETTINGS_SERVER_KEY}`, { // PANE-01-ALLOWED
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(syncableSettings(settings)),
  }).catch(() => {});
}

export function saveSettings(settings: AppSettings) {
  // Write localStorage immediately (fast paint)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  lastLocalChange = Date.now();
  // Notify in-process consumers (cross-tab is covered by the 'storage' event).
  try { window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT)); } catch {}

  // Debounced server sync (1s for resize-heavy changes)
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    // Gate: mai pubblicare prima di aver letto (vedi il commento sopra).
    if (!hydrated) { pendingPut = settings; return; }
    putSettings(settings);
  }, 1000);
}
