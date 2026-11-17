/**
 * Everything the server answers from disk: the dev-server proxy, the app shell, the bundle assets, uploads, media and the
 * /preview file server (`serveStatic`), and the app shell again for client-side routes (`spaFallback`). Each returns a Response when
 * it matched and undefined to let the request go on.
 */
import { join, resolve, sep } from "path";
import { existsSync } from "fs";
import { shouldServeSpaFallback } from "../spa-fallback";
import { classifyStaticAsset, pickPrecompressed } from "../static-assets";
import { servedFileHeaders } from "../lib/served-file-headers";
import { activeContentGuardHeaders, PREVIEW_SANDBOX_FLAGS } from "../routes/media";
import { readBundleRev, stampBundleRev } from "../lib/dev-bundle-reload";
import type { AfterHttp } from "../boot/scope";

export function createStaticFiles(scope: Pick<AfterHttp, "PORT" | "PUBLIC_DIR" | "ctx" | "getMimeType">) {
  const { PORT, PUBLIC_DIR, ctx, getMimeType } = scope;
  /** Last index.html we served successfully, with the bundle rev it carried. The
   *  fallback for a request that lands while /public is being rewritten — see the
   *  `GET /` handler. */
  let lastGoodShell: { html: string; rev: string } | null = null;
  const isDevPort = PORT === 3330;

  async function serveStatic(req: Request, url: URL, pathname: string, method: string): Promise<Response | undefined> {
    // LETTURA = GET **o HEAD**. Ogni ramo statico qui sotto era gated sul solo
    // `method === "GET"`, così un HEAD scivolava fino in fondo e prendeva 404:
    // misurato l'11/08 sul server vivo, `GET /assets/index-<hash>.js` → 200 e
    // `HEAD` sullo stesso path → 404, `HEAD /` → 404. HEAD è il verbo di cache,
    // proxy, link checker e sonde di salute — chi chiede «esiste? è cambiato?»
    // si sentiva rispondere «non esiste» e agiva di conseguenza (invalida,
    // riscarica, segnala un link morto). RFC 9110 §9.3.2: la risposta a HEAD è
    // identica a quella di GET **senza il corpo**, header compresi.
    // Il corpo non va tolto a mano: Bun.serve svuota da sé la risposta a un HEAD
    // e conserva `Content-Length` (verificato con Bun.file e con una stringa) —
    // quello che mancava era solo il montaggio del verbo.
    const isRead = method === "GET" || method === "HEAD";
    // La parità degli HEADER, non solo dello status. Quando il corpo è un
    // `Bun.file` grande (misurato: 290 KB sì, 3 KB no — è il ramo sendfile) Bun
    // aggiunge da sé un `Content-Disposition: filename="index-<hash>.js"`, che
    // sull'HEAD non c'è: due risposte che dovrebbero essere identiche
    // differivano di un header, e quello sul GET è pure malformato (RFC 6266
    // vuole un tipo, `inline`/`attachment`, non un `filename` nudo). Dichiararlo
    // NOI vince sull'iniezione e riallinea i due verbi.
    // Solo per il bundle, che è roba NOSTRA e va renderizzata: gli allegati e i
    // media restano senza dichiarazione, e i download del browser hanno già il
    // loro `attachment` esplicito qualche riga più sotto.
    // Dev mode proxy: ?dev=true proxies to Topics Vite dev server on :3332
    const isDevMode = url.searchParams.get("dev") === "true" || req.headers.get("cookie")?.includes("topics-dev=true");
    if (isDevMode && isRead && !pathname.startsWith("/api/") && !pathname.startsWith("/ws")) {
      try {
        const viteUrl = `https://localhost:3332${pathname}${url.search}`;
        // `method` e non "GET" implicito: un HEAD proxato come GET tirerebbe giù
        // da Vite l'intero modulo per poi buttarlo via.
        const viteResp = await fetch(viteUrl, { method, headers: req.headers, tls: { rejectUnauthorized: false } } as any); // allow-any: moved verbatim from server.ts, where the counter was blind to this line (a stray block-comment opener swallowed it)
        if (viteResp.ok) {
          const respHeaders = new Headers(viteResp.headers);
          if (url.searchParams.get("dev") === "true") {
            respHeaders.set("Set-Cookie", "topics-dev=true; Path=/; SameSite=Lax");
          }
          return new Response(viteResp.body, { status: viteResp.status, headers: respHeaders });
        }
      } catch {
        // Vite not running, fall through to static files
      }
    }
    // Exit dev mode: ?dev=false clears cookie
    if (url.searchParams.get("dev") === "false") {
      return new Response(null, { status: 302, headers: { "Location": "/", "Set-Cookie": "topics-dev=; Path=/; Max-Age=0" } });
    }

    // Static files
    if (isRead && (pathname === "/" || pathname === "/index.html")) {
      // Last-known-good shell. /public is rewritten while the server serves it:
      // it was the build-watch agent (off since 2026-08-04, and staying off:
      // docs/build-watch-decision.md), and it is now the one-shot
      // `bun run build:client`, which EMPTIES public/ first. So a page load
      // that lands mid rebuild used to read a missing index.html, throw, and
      // answer 500 — the app "doesn't open", for a window that has nothing to
      // do with the app.
      // Serving the previous shell instead turns a rebuild into something the
      // user never sees. The rev is cached WITH the html: re-deriving it from
      // a half-written /public would stamp an empty rev and trip the client's
      // "new version available" detector.
      let html: string;
      let rev: string;
      try {
        const fresh = await Bun.file(join(PUBLIC_DIR, "index.html")).text();
        if (!fresh.trim()) throw new Error("index.html is empty");
        html = fresh;
        rev = readBundleRev(PUBLIC_DIR);
        lastGoodShell = { html: fresh, rev };
      } catch (err) {
        if (!lastGoodShell) {
          console.error(`[Static] index.html unreadable and no cached shell:`, err);
          return new Response("Bundle not built yet — run `cd client && bun run build`.", { status: 503, headers: { "Cache-Control": "no-store" } }); // allow-emdash: body moved verbatim out of server.ts, which sat outside this gate's roots
        }
        console.warn(`[Static] index.html unreadable (build in flight?) — serving the last good shell`);
        ({ html, rev } = lastGoodShell);
      }
      if (isDevPort) {
        html = html
          .replace(/\/icons\/icon-180\.png/g, '/icons/icon-180-dev.png')
          .replace(/\/icons\/icon-192\.png/g, '/icons/icon-192-dev.png')
          .replace('href="/manifest.json"', 'href="/manifest-dev.json"');
      }
      // Stamp the rev this HTML represents so the client never has to re-derive
      // it from its own DOM (which drifts as Vite injects lazy-chunk preloads —
      // the phantom "nuova versione disponibile" loop).
      html = stampBundleRev(html, rev);
      // no-STORE, not no-cache: the app shell must never sit in a cache. With
      // `no-cache` WKWebView still served a stale index.html after a deploy
      // (revalidation didn't fire reliably), so the desktop kept booting the
      // old bundle. `no-store` forces a fresh fetch every launch; the hashed
      // /assets/* stay immutable, so this costs one tiny HTML fetch, not the JS.
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (isRead && pathname.endsWith(".html")) {
      const file = Bun.file(join(PUBLIC_DIR, pathname));
      if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": "inline" } });
    }
    // Asset del bundle. La decisione (quali file, con che cache) sta in
    // `classifyStaticAsset` (server/static-assets.ts) così è unit-testata —
    // stesso trattamento di `shouldServeSpaFallback`. Qui c'era un elenco di
    // nomi a mano in cui `/boot.js` mancava: la shell web caricava uno script
    // che rispondeva 404, e con lui perdeva tema pre-paint e service worker.
    if (isRead) {
      const asset = classifyStaticAsset(pathname, PUBLIC_DIR);
      if (asset) {
        const file = Bun.file(asset.filePath);
        if (await file.exists()) {
          // Precompressed siblings, built by the vite plugin next to each asset.
          // The Content-Type stays the one of the ORIGINAL file (an `.js.br` is
          // still JavaScript, only encoded), and `Vary` goes out on every reply,
          // compressed or not: a shared cache that stored the raw answer must
          // not hand it to a client that asked for brotli, and vice versa.
          const encoded = pickPrecompressed(asset.filePath, req.headers.get("accept-encoding"), existsSync);
          const headers: Record<string, string> = {
            "Content-Type": getMimeType(asset.filePath),
            "Cache-Control": asset.cacheControl,
            "Content-Disposition": "inline",
            "Vary": "Accept-Encoding",
          };
          if (encoded) headers["Content-Encoding"] = encoded.encoding;
          return new Response(encoded ? Bun.file(encoded.filePath) : file, { headers });
        }
      }
    }

    // Serve uploaded files (screenshots, attachments)
    if (isRead && pathname.startsWith("/uploads/")) {
      const filePath = join(ctx.UPLOADS_DIR, pathname.slice("/uploads/".length));
      // Lo stesso cancello di `/media/`: il confronto e' su una CARTELLA, con il
      // separatore in coda, cosi' un fratello tipo `…/uploads-evil` non passa.
      const resolvedUpload = resolve(filePath);
      const resolvedUploads = resolve(ctx.UPLOADS_DIR);
      if (resolvedUpload !== resolvedUploads && !resolvedUpload.startsWith(resolvedUploads + sep)) {
        return new Response("Forbidden", { status: 403 });
      }
      const file = Bun.file(filePath);
      if (await file.exists()) {
        // UN UPLOAD E' CONTENUTO DI QUALCUN ALTRO servito sull'origine della app.
        // Senza `nosniff` un browser puo' indovinare il tipo e rendere un .svg o
        // un .html come pagina: XSS memorizzata, stessa origine, sessione inclusa.
        // Le immagini/video/audio/pdf restano `inline` perche' e' cosi' che si
        // guardano in chat; tutto il resto scende come allegato, come gia' fanno
        // i download del browser pane qui sotto.
        // `image/svg+xml` PASSAVA il test `^image/`, ed e' esattamente il buco
        // che quel commento diceva di chiudere: un .svg navigato direttamente
        // esegue il suo `<script>` sull'origine della app, con la sessione
        // dentro. La decisione sta in `served-file-headers` perche' era gia'
        // scritta due volte — qui e nei download del browser pane 40 righe piu'
        // sotto — e le due copie erano divergenti.
        return new Response(file, {
          headers: servedFileHeaders({
            mime: getMimeType(filePath),
            filename: pathname.split("/").pop() || "file",
            cacheControl: "public, max-age=3600",
          }),
        });
      }
      return new Response("Not Found", { status: 404 });
    }

    // Serve app media files (browser screenshots, etc.)
    // Handles paths like /media/browser/uuid.jpg → <APP_DATA_DIR>/media/browser/uuid.jpg
    if (isRead && pathname.startsWith("/media/") && !pathname.includes("..")) {
      const mediaBase = join(ctx.APP_DATA_DIR, "media");
      const filePath = join(mediaBase, pathname.slice("/media/".length));
      // Security: ensure resolved path stays within media directory (match on a
      // trailing separator so a sibling like `…/media-evil` can't sneak through,
      // while still allowing the base dir itself).
      const resolvedFile = resolve(filePath);
      const resolvedBase = resolve(mediaBase);
      if (resolvedFile === resolvedBase || resolvedFile.startsWith(resolvedBase + sep)) {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          // Browser-pane DOWNLOADS are UNTRUSTED content (whatever a headless
          // page downloaded) served same-origin. Force an attachment + no sniff
          // + CSP sandbox so an .html/.svg payload can NEVER inline-render as
          // stored XSS on the app origin — the link only ever downloads the file.
          if (pathname.startsWith("/media/browser/downloads/")) {
            const name = (pathname.split("/").pop() || "download").replace(/["\\\r\n]/g, "_");
            return new Response(file, {
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Disposition": `attachment; filename="${name}"`,
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "sandbox",
                "Cache-Control": "private, no-store",
              },
            });
          }
          return new Response(file, { headers: { "Content-Type": getMimeType(filePath), "Cache-Control": "public, max-age=86400" } });
        }
      }
      return new Response("Not Found", { status: 404 });
    }

    // Preview endpoint: serve local files for browser panel
    if (isRead && pathname.startsWith("/preview/")) {
      let filePath = decodeURIComponent(pathname.slice("/preview".length));
      if (!filePath.startsWith("/")) filePath = "/" + filePath;
      const resolved = resolve(filePath);
      if (resolved !== filePath || filePath.includes("..")) return new Response("Forbidden", { status: 403 });
      // CONFINE. Fino al 2026-08-06 qui non ce n'era nessuno: l'unico controllo
      // era «il path è canonico», quindi QUALUNQUE file del disco usciva da qui.
      // Misurato: `GET /preview/etc/hosts` → 200 col contenuto, e da una seconda
      // rete presente sulla macchina. `~/.ssh/id_rsa` stava dietro la stessa
      // porta, e con lui `~/.topics/daemon-state.json`, cioè il token del daemon.
      //
      // L'identità (change `device-auth`) chiude la porta a chi non è appaiato,
      // ma non rende sicuro un file server per chi è dentro: un dispositivo
      // autorizzato non ha ragione di leggere `/etc`. Il confine è quello che il
      // resto del server usa già — l'unione delle dir di progetto note
      // (`resolveProjectPath`, che confronta il path REALE così un symlink dentro
      // un progetto non diventa una porta) più le radici dei media e degli
      // allegati. Non è una lista nuova da mantenere: è la stessa, riusata.
      const dentroProgetto = ctx.resolveProjectPath(resolved) !== null;
      if (!dentroProgetto && !ctx.isPathAllowed(resolved)) {
        console.warn(`[Security] Preview path denied: ${resolved}`);
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const file = Bun.file(resolved);
        if (await file.exists()) {
          // THE OTHER DOOR ONTO THE SAME BYTES. This route serves ANY file
          // inside a project directory, which is exactly where the `.html` and
          // `.svg` an agent writes (or `POST /api/files/upload` accepts) land,
          // and it used to send them with a bare `Content-Type`: a `<script>`
          // in one of them ran on our origin with the session cookie. The
          // sandboxed iframe on the client was the only guard, and pasting the
          // URL into a pane walked around it. Same composer as `/api/media`,
          // so the two cannot drift apart again.
          const contentType = getMimeType(resolved);
          return new Response(file, {
            headers: {
              ...activeContentGuardHeaders(contentType, { sandboxFlags: PREVIEW_SANDBOX_FLAGS }),
              "Content-Type": contentType,
              "Cache-Control": "no-cache",
            },
          });
        }
      } catch (err) {
        // `Bun.file(...).exists()` resolves to `false` on every stat error this
        // machine could produce (verified by hand: ENOENT, a path through a
        // non-directory, a name long enough for ENAMETOOLONG — none of them
        // throw), so nothing between here and the `return` above is known to
        // reach this catch today. The real byte-for-byte read (the one that
        // CAN throw EACCES, e.g. a 0-perm file whose `stat` still succeeds)
        // happens lazily once Bun streams the returned `Response` body, which
        // is after this function has already returned — outside this
        // try/catch entirely. Kept as a backstop (logged, not swallowed) for
        // whatever future Bun behavior or edge case does land here; not
        // covered by an automated test for the reason above.
        console.warn("[preview] read failed", resolved, err);
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response("Not Found", { status: 404 });
    }
    return undefined;
  }

  async function spaFallback(req: Request, pathname: string, method: string): Promise<Response | undefined> {
    // SPA navigation fallback. Client-side routes like `/task/<uuid>` have no
    // file on disk; a full-page load (refresh / pasted link) must still boot the
    // app so openTaskLink can read the path. Serve the app shell for GET HTML
    // navigations only. This sits AFTER all api/asset routing on purpose: a
    // missing asset (`/assets/foo.js`) or unknown `/api/*` route already returned
    // its real 404 above — never masked by index.html. The decision lives in
    // `shouldServeSpaFallback` (server/spa-fallback.ts) so it's unit-tested.
    // Same no-store headers as the "/" branch.
    if (shouldServeSpaFallback({ method, pathname, accept: req.headers.get("accept") })) {
      let html = await Bun.file(join(PUBLIC_DIR, "index.html")).text();
      if (isDevPort) {
        html = html
          .replace(/\/icons\/icon-180\.png/g, '/icons/icon-180-dev.png')
          .replace(/\/icons\/icon-192\.png/g, '/icons/icon-192-dev.png')
          .replace('href="/manifest.json"', 'href="/manifest-dev.json"');
      }
      html = stampBundleRev(html, readBundleRev(PUBLIC_DIR));
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    return undefined;
  }

  return { serveStatic, spaFallback };
}
