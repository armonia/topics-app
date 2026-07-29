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
