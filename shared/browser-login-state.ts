/**
 * Il formato `storageState` di Playwright (cookie + localStorage per origine).
 *
 * È il formato di interscambio dei login del browser: lo scrive il server
 * (`server/browser-login-state.ts`), lo rilegge il pane nativo via i comandi
 * cookie in Rust (`CookieJson` in desktop-tauri/src-tauri/src/lib.rs parla
 * ESATTAMENTE questa forma) e lo maneggia il client
 * (`client/src/lib/shell/browserLoginState.ts`). Tre lettori, quindi finora
 * tre dichiarazioni: due in TypeScript — identiche, cioè pronte a divergere —
 * e una in Rust, che TypeScript non può controllare comunque.
 *
 * Le due TypeScript ora sono una. Se cambia qui, cambia per entrambe; se
 * cambia la struct Rust, questo file è il posto dove si guarda per allinearla.
 */

export interface StorageCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** Secondi epoch; -1 (o assente) = cookie di sessione. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface StorageOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface StorageState {
  cookies: StorageCookie[];
  origins: StorageOrigin[];
}

/**
 * Identità di un cookie secondo RFC 6265: `name` da solo NON basta, due siti
 * diversi hanno entrambi il loro `session`. Domain e path assenti si
 * normalizzano ai default che usa già il pane nativo quando inietta
 * (`cookies_set_blocking` mette "/" se il path manca), così lo stesso cookie
 * scritto dalle due parti collide invece di duplicarsi.
 */
/**
 * La chiave e' un JSON e non tre pezzi incollati con un separatore:
 * qualunque carattere si scelga come colla, un valore che lo contiene fa
 * collidere due cookie diversi. `JSON.stringify` di una tupla non ha questo
 * problema — e il separatore che avevo scelto era un byte NUL, che il
 * cancello del repo (tests/unit/no-nul-bytes.test.ts) rifiuta perche' nasconde
 * il file a grep.
 */
function cookieKey(c: StorageCookie): string {
  return JSON.stringify([c.name, (c.domain ?? '').toLowerCase(), c.path || '/']);
}

/**
 * Aggiungere a `base` quello che `extra` ha IN PIÙ, senza toccare nient'altro.
 * In conflitto vince `base`: questa funzione può solo AGGIUNGERE
 * autenticazione, mai sostituirla.
 *
 * Serve al passaggio di sessione fra la WKWebView nativa e la sessione
 * condivisa: le due hanno barattoli di cookie separati, e chi si è loggato di
 * là si ritrova sloggato di qua.
 *
 * PERCHÉ VINCE `base` E NON CHI ARRIVA. La prima versione dava la vittoria a
 * chi arriva, con l'idea che fosse «la parte che l'utente stava usando». Ma
 * chi arriva è il barattolo nativo, e un cookie nativo può essere VECCHIO e
 * non ancora scaduto: una sessione lasciata lì mesi fa. Sostituendo, quel
 * cookie morto avrebbe buttato fuori un login più fresco che il telefono aveva
 * appena fatto sulla sessione condivisa — e siccome il risultato si scrive su
 * disco, per sempre. Cioè avremmo tolto un logout creandone un altro, peggiore
 * perché silenzioso e irreversibile. Non esiste un criterio onesto per dire
 * quale dei due sia il più fresco: `expires` non serve, i cookie di
 * autenticazione sono quasi sempre di sessione (-1).
 *
 * Quindi la regola è la sola che si può difendere: riempire i buchi. Dove la
 * sessione condivisa non ha niente, arriva il nativo; dove ha già qualcosa,
 * resta il suo. È un miglioramento stretto rispetto a oggi — oggi non passa
 * nulla — e non può sloggare nessuno.
 *
 * L'ordine è STABILE (prima le chiavi di `base`, poi le nuove di `extra` in
 * ordine d'arrivo): rifarlo non deve produrre un file diverso, o il
 * salvataggio su disco cambierebbe a vuoto a ogni oscillazione del flip.
 */
export function mergeStorageState(base: StorageState, extra: StorageState): StorageState {
  const cookies: StorageCookie[] = [];
  const byKey = new Map<string, number>();
  for (const c of [...(base.cookies ?? []), ...(extra.cookies ?? [])]) {
    if (!c || typeof c.name !== 'string') continue;
    const k = cookieKey(c);
    // Chiave già presente: si TIENE quella che c'era. Vedi sopra — sostituirla
    // è il modo per sloggare qualcuno con un cookie vecchio ma non scaduto.
    if (byKey.has(k)) continue;
    byKey.set(k, cookies.length);
    cookies.push(c);
  }

  const origins: StorageOrigin[] = [];
  const originAt = new Map<string, number>();
  for (const o of [...(base.origins ?? []), ...(extra.origins ?? [])]) {
    if (!o?.origin || !Array.isArray(o.localStorage)) continue;
    const at = originAt.get(o.origin);
    if (at === undefined) {
      originAt.set(o.origin, origins.length);
      // Si copia l'oggetto INTERO, non `{origin, localStorage}`: la sessione
      // condivisa persiste con `storageState({ indexedDB: true })`, quindi
      // un'origine può portarsi dietro campi che questo tipo non nomina.
      // Ricostruirla dai due che conosciamo li cancellerebbe — cioè un merge
      // che si presenta come «non perdo niente» e intanto butta via l'IndexedDB
      // in cui vive metà dei login moderni.
      origins.push({ ...o, localStorage: [...o.localStorage] });
      continue;
    }
    // Origine già vista: si aggiungono solo le chiavi di localStorage che
    // mancano. Stessa regola dei cookie, e per lo stesso motivo: un token
    // vecchio che sostituisce quello buono è un logout.
    const prev = origins[at]!;
    const merged = prev.localStorage;
    for (const kv of o.localStorage) {
      if (!kv || typeof kv.name !== 'string') continue;
      if (merged.some((e) => e.name === kv.name)) continue;
      merged.push(kv);
    }
    // I campi in più (IndexedDB) si prendono da chi li ha, senza cancellarli:
    // `o` per primo così un'origine che li porta non li perde, `prev` sopra
    // perché su ciò che è già noto comanda la base.
    origins[at] = { ...o, ...prev, localStorage: merged };
  }

  return { cookies, origins };
}
