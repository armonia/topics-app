/**
 * La risposta di `/api/media` quando il file NON si può dare, per occhi umani.
 *
 * Da quando un file locale si apre nel pannello passando di qui
 * (browser-local-file-url.ts), questa rotta non serve più solo `<img>` e
 * `<video>`: è una NAVIGAZIONE, e ciò che risponde finisce a schermo intero
 * davanti a una persona. `{"error":"forbidden: invalid path"}` su fondo bianco
 * è, per chi guarda, indistinguibile dalla pagina bianca da cui è nata tutta
 * questa storia — un rifiuto che non si legge.
 *
 * Quindi: se chi chiede è una navigazione (`Accept: text/html`) la risposta è
 * una pagina che dice il file, il motivo e cosa si può fare. Se chi chiede è un
 * `<img>`/`fetch()` resta il JSON di prima, perché lì a leggere è del codice —
 * e cambiargli la forma sotto i piedi romperebbe chi la controlla.
 *
 * Il codice HTTP non cambia mai: 403 resta 403. Cambia solo la lingua.
 */

/** `true` se la richiesta è una navigazione, non un sotto-fetch di pagina. */
export function wantsHtml(accept: string | null): boolean {
  if (!accept) return false;
  // `Accept: text/html,...` lo mandano le navigazioni; `image/*` un <img>,
  // `*/*` un fetch(). Il confronto è sul PRIMO tipo dichiarato, che è quello
  // che il browser preferisce davvero.
  return /^\s*text\/html\b/i.test(accept) || accept.includes("text/html,");
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

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
