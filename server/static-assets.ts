// Quali file del bundle si servono, e con che cache — l'unico predicato, puro e
// testabile, dietro alle risposte statiche di server.ts.
//
// Perché esiste: prima era un'ALLOWLIST di nomi scritta a mano dentro l'`if`
// (`/vite.svg`, `/manifest.json`, `/sw.js`, `/changelog.json`, …). `/boot.js`
// non c'era. Dal 30/06/2026 — `de2e85be`, il commit che ESTRAE lo script di boot
// da index.html apposta per non farlo rifiutare dalla CSP di Tauri — la shell
// web caricava `<script src="/boot.js">` e riceveva un 404. Sotto Tauri il
// guasto era invisibile (là /public è EMBEDDED e lo serve la shell), ma su
// web/PWA spariva tutto quello che quello script fa PRIMA del primo paint:
// tema (FOUC), classi vibrancy, sidebar pre-collassata, telemetria CSP e —
// soprattutto — la registrazione del service worker, cioè PWA offline e push.
//
// Un elenco di nomi non può che tornare in deriva al prossimo asset aggiunto:
// la regola è quindi strutturale, non nominale. Si serve QUALSIASI file che
// esista davvero alla radice del bundle (un solo segmento, con un'estensione) e
// qualsiasi cosa sotto `/assets/` e `/icons/`.

import { join, resolve, sep } from "path";

export interface StaticAsset {
  /** Path assoluto del file da servire. Chi chiama verifica che esista. */
  filePath: string;
  cacheControl: string;
}

/** Contenuto con nome versionato (hash Vite) o comunque stabile. */
const IMMUTABLE_PREFIXES = ["/assets/", "/icons/"];

/** Un solo segmento con un'estensione: `/boot.js`, `/sw.js`, `/manifest.json`. */
const ROOT_FILE = /^\/[^/]+\.[^/]+$/;

/**
 * Il file (e la sua cache) per questo pathname, o `null` se non è una richiesta
 * di asset statico.
 *
 * La cache: immutabile per `/assets/` e `/icons/`; `no-cache` per tutto ciò che
 * sta alla radice, perché è roba che cambia a ogni release e che pinnata per un
 * anno bloccherebbe l'app su un bundle vecchio (`sw.js` e `boot.js` in testa —
 * sono esattamente i due che decidono cosa viene servito dopo).
 */
export function classifyStaticAsset(pathname: string, publicDir: string): StaticAsset | null {
  const immutable = IMMUTABLE_PREFIXES.some((p) => pathname.startsWith(p));
  if (!immutable && !ROOT_FILE.test(pathname)) return null;

  const filePath = join(publicDir, pathname);
  // Guardia di traversata. `URL.pathname` normalizza già i `..`, e un file di
  // radice ha un segmento solo, quindi non ci si arriva — ma il confronto sul
  // path risolto è la garanzia che non dipende da quelle due premesse. Il
  // separatore finale serve perché una directory sorella (`…/public-altro`) non
  // passi il prefisso.
  const base = resolve(publicDir);
  if (!resolve(filePath).startsWith(base + sep)) return null;

  return {
    filePath,
    cacheControl: immutable ? "public, max-age=31536000, immutable" : "no-cache",
  };
}
