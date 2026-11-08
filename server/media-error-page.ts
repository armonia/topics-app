/**
 * The answer of `/api/media` when the file CANNOT be given, for human eyes.
 *
 * Since a local file opens in the panel by going through here
 * (browser-local-file-url.ts), this route no longer serves only `<img>` and
 * `<video>`: it is a NAVIGATION, and what it answers fills the screen in front
 * of a person. `{"error":"forbidden: invalid path"}` on a white background is,
 * to whoever looks, indistinguishable from a blank page: a refusal nobody can read.
 *
 * So: when the caller is a navigation (`Accept: text/html`) the answer is a
 * page that names the file, the reason and what can be done. When the caller is
 * an `<img>`/`fetch()` the JSON stays as before, because there code reads it and
 * changing its shape would break whoever checks it.
 *
 * The HTTP status never changes: 403 stays 403. Only the language changes.
 */
import { escapeHtml } from "./lib/escape-html";

/** `true` se la richiesta è una navigazione, non un sotto-fetch di pagina. */
export function wantsHtml(accept: string | null): boolean {
  if (!accept) return false;
  // `Accept: text/html,...` lo mandano le navigazioni; `image/*` un <img>,
  // `*/*` un fetch(). Il confronto è sul PRIMO tipo dichiarato, che è quello
  // che il browser preferisce davvero.
  return /^\s*text\/html\b/i.test(accept) || accept.includes("text/html,");
}

const esc = escapeHtml;

export interface MediaErrorPage {
  /** Il percorso richiesto, come l'ha scritto chi ha chiesto. */
  path: string;
  /** Titolo breve: cos'è successo. */
  title: string;
  /** Riga di spiegazione. */
  detail: string;
}

/**
 * Pagina d'errore sobria e leggibile in entrambi i temi (la pane non ci dice il
 * suo, quindi si adatta da sola invece di sparare un fondo bianco).
 */
export function mediaErrorHtml({ path, title, detail }: MediaErrorPage): string {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  background:#fafafa; color:#18181b; }
@media (prefers-color-scheme: dark) { body { background:#18181b; color:#e4e4e7; } }
main { max-width:34rem; padding:2rem; }
h1 { font-size:1.05rem; font-weight:640; margin:0 0 .55rem; letter-spacing:-.01em; }
p { margin:0 0 .75rem; opacity:.85; }
code { font:13px ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all;
  background:rgba(127,127,127,.14); padding:.15rem .35rem; border-radius:.3rem; }
</style></head><body><main>
<h1>${esc(title)}</h1>
<p><code>${esc(path)}</code></p>
<p>${esc(detail)}</p>
</main></body></html>`;
}
