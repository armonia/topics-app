/**
 * Un solo cassetto cookie fra la WKWebView nativa e la sessione condivisa.
 *
 * IL FATTO. Una pane browser sul desktop si disegna in due modi: la WKWebView
 * NATIVA (veloce, privata di questo Mac, con il suo `WKWebsiteDataStore`
 * persistente per contesto) e la sessione CONDIVISA (il contesto Playwright
 * lato server, che anche il telefono può vedere e guidare). L'auto-share passa
 * dall'una all'altra da solo appena un altro dispositivo apre lo STESSO
 * contesto. Ma i due lati hanno barattoli di cookie separati: chi si era
 * loggato di là si ritrova sloggato di qua, e il login sembra semplicemente
 * evaporato.
 *
 * IL PUNTO DI GIUNZIONE. La sessione condivisa NON nasce vuota: alla creazione
 * del contesto `browser-service.ts` legge già lo stato persistito di quel
 * contesto e lo passa a `newContext({ storageState })`. Quindi non serve
 * inventare un canale nuovo — basta che, quando quel seme viene preparato e
 * dall'altra parte c'è una pane nativa VIVA, il seme contenga anche i cookie
 * della pane nativa. Leggerli è già possibile: `browser_save_state` sul
 * delegate nativo fa esattamente questo, ed è la stessa gamba che l'agente usa
 * oggi per salvare un login (`browser-native-state.ts`).
 *
 * LE REGOLE CHE LO RENDONO SICURO. Il percorso dell'auto-share balla (debounce
 * 1200 ms), quindi questo passaggio:
 *  - non SOVRASCRIVE mai: fonde (`mergeStorageState`), perché la sessione
 *    condivisa ha i suoi login — fatti dal telefono o da un `browser_load_state`
 *    dell'agente — e buttarli via risolverebbe un logout creandone un altro;
 *  - non scrive MAI il vuoto: se la pane nativa non ha nulla da dare, il seme
 *    resta quello che era. Un barattolo vuoto che vince su uno pieno è
 *    esattamente il logout che stiamo togliendo;
 *  - è idempotente: rifarlo a ogni oscillazione dà lo stesso file;
 *  - non alza MAI un'eccezione e ha un tetto di tempo suo. Sta sul percorso di
 *    creazione del contesto, cioè fra il telefono e il suo primo fotogramma: se
 *    il Mac non risponde, la pane condivisa nasce sloggata com'era prima, non
 *    non nasce.
 *
 * DUE DIREZIONI, DUE FUNZIONI.
 *  - `seedSharedFromNative`: nativa → condivisa, sul percorso di creazione del
 *    contesto Playwright. «Mi loggo sul Mac, il telefono apre la stessa scheda
 *    ed è dentro».
 *  - `seedNativeFromShared`: condivisa → nativa, quando la pane nativa (ri)nasce
 *    su quel contesto. «Mi loggo dal telefono, torno sul Mac e sono dentro».
 *    Questo verso scrive nel barattolo persistente del Mac, quindi è più
 *    prudente dell'altro: SOLO cookie (mai una navigazione della pane per
 *    posare il localStorage), e mai due volte lo stesso barattolo.
 */
import {
  nativeDelegateRegistry,
  type NativeDelegateRegistry,
} from "./browser-native-delegate";
import { loadStorageState, saveStorageState } from "./browser-state-store";
import { mergeStorageState, type StorageState } from "../shared/browser-login-state";

/** Quanto si aspetta il Mac prima di lasciar perdere. Il registry nativo ha un
 *  timeout suo da 30s, giusto per una tool-call dell'agente ma assurdo qui:
 *  questo sta davanti al primo fotogramma del telefono. Meglio una pane
 *  sloggata subito che una pane nera per mezzo minuto. */
export const HANDOFF_TIMEOUT_MS = 2_000;

/** Perché il passaggio non è avvenuto. `ok` è l'unico esito che ha scritto. */
export type HandoffOutcome =
  | { ok: true; cookies: number; origins: number }
  | { ok: false; skipped: "no-native-pane" | "empty" | "export-failed" | "timeout"; error?: string };

export interface HandoffDeps {
  registry?: NativeDelegateRegistry;
  load?: typeof loadStorageState;
  save?: typeof saveStorageState;
  timeoutMs?: number;
}

/** Lo stato che torna dal client è dato di rete: fidarsi della forma no. */
function coerceStorageState(raw: unknown): StorageState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(s.cookies)) return null;
  return {
    cookies: s.cookies as StorageState["cookies"],
    origins: Array.isArray(s.origins) ? (s.origins as StorageState["origins"]) : [],
  };
}

/**
 * Versare il barattolo della pane nativa viva in quello persistito della
 * sessione condivisa dello STESSO contesto, prima che il contesto Playwright
 * venga creato.
 *
 * Non lancia mai: ogni fallimento è un `{ ok: false, skipped }` e il chiamante
 * tira dritto. Il confinamento è per contesto — `contextId` è la chiave sia del
 * delegate nativo sia dello store — quindi i cookie di un topic non possono
 * finire in un altro.
 */
export async function seedSharedFromNative(
  contextId: string,
  deps: HandoffDeps = {},
): Promise<HandoffOutcome> {
  const registry = deps.registry ?? nativeDelegateRegistry;
  const load = deps.load ?? loadStorageState;
  const save = deps.save ?? saveStorageState;
  const timeoutMs = deps.timeoutMs ?? HANDOFF_TIMEOUT_MS;

  // Nessuna pane nativa viva su questo contesto = niente da passare. È il caso
  // NORMALE (il web, il telefono da solo, una pane mai aperta sul Mac).
  if (!registry.isDelegated(contextId)) return { ok: false, skipped: "no-native-pane" };

  let raw: unknown;
  try {
    // `delegateOp` risolve (non rigetta) anche in errore, quindi la corsa col
    // timeout è sicura: il ramo perdente non lascia un rejection orfano.
    raw = await Promise.race([
      registry.delegateOp(contextId, "browser_save_state", {}),
      new Promise<{ error: string }>((resolve) =>
        setTimeout(() => resolve({ error: "handoff timeout" }), timeoutMs),
      ),
    ]);
  } catch (err) {
    return { ok: false, skipped: "export-failed", error: err instanceof Error ? err.message : String(err) };
  }

  if (raw && typeof raw === "object" && "error" in raw) {
    const error = String((raw as { error: unknown }).error);
    return { ok: false, skipped: /timeout/i.test(error) ? "timeout" : "export-failed", error };
  }

  const native = coerceStorageState(raw);
  if (!native) return { ok: false, skipped: "export-failed", error: "malformed state from the native pane" };
  // Niente da dare: il seme esistente resta com'è. Scrivere il vuoto sopra un
  // login buono sarebbe il logout che questo codice esiste per togliere.
  if (!native.cookies.length && !native.origins.length) return { ok: false, skipped: "empty" };

  const base = (await load(contextId).catch(() => null)) ?? { cookies: [], origins: [] };
  const merged = mergeStorageState(base as StorageState, native);
  try {
    await save(contextId, merged as never);
  } catch (err) {
    return { ok: false, skipped: "export-failed", error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, cookies: merged.cookies.length, origins: merged.origins.length };
}

// ---------------------------------------------------------------------------
// IL VERSO OPPOSTO: sessione condivisa -> WKWebView nativa.
// ---------------------------------------------------------------------------

/** Esito del passaggio all'indietro. `ok` e' l'unico che ha toccato la pane. */
export type ReverseHandoffOutcome =
  | { ok: true; cookies: number }
  | {
      ok: false;
      skipped: "no-native-pane" | "empty" | "unchanged" | "apply-failed" | "timeout";
      error?: string;
    };

export interface ReverseHandoffDeps {
  registry?: NativeDelegateRegistry;
  load?: typeof loadStorageState;
  timeoutMs?: number;
  /** Memoria «cosa ho già posato su questo contesto». Iniettabile per i test;
   *  di serie è quella di processo qui sotto. */
  memo?: Map<string, string>;
}

/**
 * Cosa è già stato posato sulla pane nativa, per contesto. Il gancio del
 * passaggio è `register_native_executor`, che riparte a OGNI riconnessione del
 * socket: senza questa memoria ogni riconnessione riscriverebbe cookie su una
 * WKWebView viva. Solo di processo, apposta: dopo un riavvio del server rifarlo
 * una volta è giusto — il barattolo può essere cambiato mentre era giù.
 */
const posato = new Map<string, string>();

/** Impronta stabile del barattolo: cambia quando cambia un cookie che conta. */
function impronta(cookies: StorageState["cookies"]): string {
  return JSON.stringify(
    cookies
      .map((c) => [c.name, c.domain, c.path, c.value] as const)
      .sort((a, b) => (a.join(" ") < b.join(" ") ? -1 : 1)),
  );
}

/**
 * Versare il barattolo della sessione CONDIVISA nella pane NATIVA viva dello
 * stesso contesto — il ritorno del passaggio.
 *
 * IL CASO. Il telefono apre una scheda, si logga, chiude. La pane del Mac torna
 * alla sua WKWebView e mostra ancora il logout: il login è rimasto nel
 * barattolo della sessione condivisa (`data/browser-state/<ctx>/storage.json`,
 * che `destroyContext` salva) e non l'ha mai riletto nessuno.
 *
 * LE REGOLE, più strette dell'altro verso — qui si scrive su una pane VIVA:
 *  - SOLO COOKIE. `browser_load_state` lato nativo, per posare il localStorage,
 *    NAVIGA la pane su ogni origine e poi torna indietro: giusto quando è
 *    l'agente a chiederlo, inaccettabile come effetto automatico di un flip
 *    (strapperebbe la pagina sotto gli occhi di chi guarda). I login che vivono
 *    in localStorage restano affare del `browser_load_state` esplicito.
 *  - NON SVUOTA. Posare cookie sul cookie store della WKWebView è additivo: i
 *    login che il Mac ha su altri siti restano dove sono.
 *  - MAI DUE VOLTE LO STESSO barattolo (vedi `posato`).
 *  - NON LANCIA MAI e ha un tetto di tempo suo: sta sul percorso del flip verso
 *    la nativa, che deve restare veloce. Al peggio la pane resta com'era.
 */
export async function seedNativeFromShared(
  contextId: string,
  deps: ReverseHandoffDeps = {},
): Promise<ReverseHandoffOutcome> {
  const registry = deps.registry ?? nativeDelegateRegistry;
  const load = deps.load ?? loadStorageState;
  const timeoutMs = deps.timeoutMs ?? HANDOFF_TIMEOUT_MS;
  const memo = deps.memo ?? posato;

  // Nessuna WKWebView viva su questo contesto = non c'è dove versare. È il caso
  // NORMALE (il web, il telefono da solo, una pane mai aperta sul Mac).
  if (!registry.isDelegated(contextId)) return { ok: false, skipped: "no-native-pane" };

  const shared = await load(contextId).catch(() => null);
  const cookies = (Array.isArray(shared?.cookies) ? shared.cookies : []) as StorageState["cookies"];
  // Niente da dare. Applicare il vuoto non toglierebbe nulla (è additivo) ma
  // sarebbe una scrittura a vuoto su una pane viva a ogni riconnessione.
  if (!cookies.length) return { ok: false, skipped: "empty" };

  const fp = impronta(cookies);
  if (memo.get(contextId) === fp) return { ok: false, skipped: "unchanged" };

  let raw: unknown;
  try {
    // `delegateOp` risolve (non rigetta) anche in errore: la corsa col timeout
    // non lascia rejection orfane.
    raw = await Promise.race([
      registry.delegateOp(contextId, "browser_load_state", {
        state: { cookies, origins: [] } satisfies StorageState,
      }),
      new Promise<{ error: string }>((resolve) =>
        setTimeout(() => resolve({ error: "handoff timeout" }), timeoutMs),
      ),
    ]);
  } catch (err) {
    return { ok: false, skipped: "apply-failed", error: err instanceof Error ? err.message : String(err) };
  }

  if (raw && typeof raw === "object" && "error" in raw) {
    const error = String((raw as { error: unknown }).error);
    // Fallito ⇒ NON si memorizza: al prossimo giro si riprova invece di
    // credersi già a posto.
    return { ok: false, skipped: /timeout/i.test(error) ? "timeout" : "apply-failed", error };
  }

  memo.set(contextId, fp);
  const applied = (raw as { cookies?: unknown } | null)?.cookies;
  return { ok: true, cookies: typeof applied === "number" ? applied : cookies.length };
}
