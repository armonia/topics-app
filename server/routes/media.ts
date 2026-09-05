import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { AppContext, RouteHandler } from "../types";
import { wantsHtml, mediaErrorHtml } from "../media-error-page";

/**
 * Media + file/upload I/O endpoints — serving project media and handling
 * file/base64/context uploads. Split out of the topics.ts chat god-file: pure
 * filesystem I/O, fully self-contained on ctx members (json/readJSON, the
 * UPLOADS_DIR/CONTEXT_DIR config, the path allowlist helpers,
 * getTopicById/saveSingleTopic) + stdlib. No chat/provider coupling.
 *
 * `ctx.ALLOWED_UPLOAD_MIMES` non si usa più da qui: la politica sul tipo è la
 * DENY list qui sotto, e l'allowlist rifiutava allegati legittimi. Resta un
 * membro del contesto senza lettori — se nessuno la rivendica, va tolta da
 * `server/utils.ts` e da `server/types.ts` invece che lasciata a suggerire una
 * regola che non c'è.
 */
/** Il tetto per ogni upload, una volta sola. Era scritto tre volte in tre
 *  blocchi diversi — e in uno dei tre non era scritto affatto. */
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

/**
 * Quanto può pesare l'INVOLUCRO multipart oltre al file: il confine, le
 * intestazioni di parte, il nome del file. Serve perché il pre-controllo su
 * `content-length` misura la busta e non il contenuto, e senza margine
 * rifiuterebbe un file esattamente al limite.
 */
const MULTIPART_SLACK = 64 * 1024;

/**
 * LA POLITICA: si NEGA il contenuto attivo, non si AMMETTE tutto il resto.
 *
 * Un'allowlist di MIME su un allegato risponde alla domanda sbagliata. Chi
 * attacca un file a un commento passa da un `<input type="file">` senza filtri
 * (`client/src/components/Board/TaskDetail.tsx`), quindi ogni estensione che
 * l'allowlist non prevedeva diventava un 400 in faccia a una persona: misurati
 * `.txt` (`text/plain;charset=utf-8`, respinto dal PARAMETRO), `.log`, `.json`,
 * `.zip`, `.m4a` e qualunque file senza estensione. Un tipo ignoto non è
 * pericoloso: pericoloso è un tipo che il browser ESEGUE se glielo
 * restituiamo, e quelli sono pochi e nominabili.
 *
 * `UPLOADS_DIR` è servita sulla NOSTRA origine (`/uploads/…` in server.ts) e i
 * file di contesto tornano da `/api/media` con il `Content-Type` dedotto
 * dall'ESTENSIONE: un `.html` caricato lì torna indietro come `text/html` ed è
 * XSS persistente, col cookie di sessione e tutta l'API in mano. Vale per
 * l'SVG, che è un documento con script dentro.
 */
export const ACTIVE_CONTENT_MIMES = new Set([
  "text/html", "application/xhtml+xml", "image/svg+xml",
  "text/javascript", "application/javascript", "application/x-javascript",
  "application/x-httpd-php",
]);

/**
 * Le stesse cose viste dall'ESTENSIONE, che è ciò che decide davvero il
 * `Content-Type` con cui il file torna indietro.
 *
 * Non è una ridondanza: la tabella `getMimeType` del server non conosce
 * `.xhtml`, `.mjs`, `.svgz` né `.phtml`, quindi per quei nomi restituisce
 * `application/octet-stream` e il solo confronto sui MIME li lascerebbe
 * passare — per poi farli servire da un proxy o da un browser meno prudente
 * come ciò che l'estensione dice. `.xml` resta FUORI di proposito: è inerte
 * quando lo si serve, e negarlo rifiuterebbe allegati legittimi (l'unico modo
 * di renderlo attivo è un XSLT same-origin, e `/uploads/` scende comunque come
 * `attachment`).
 */
export const ACTIVE_CONTENT_EXTENSIONS = new Set([
  "html", "htm", "xhtml", "shtml", "svg", "svgz",
  "js", "mjs", "cjs", "php", "phtml", "xsl", "xslt", "htaccess",
]);

/**
 * Il MIME ridotto alla forma su cui si confronta: senza parametri, senza spazi,
 * minuscolo. `text/plain;charset=utf-8` è il valore che Bun produce davvero da
 * un `.txt`, e confrontarlo intero contro un elenco di tipi nudi lo faceva
 * cadere fuori da OGNI insieme — sia da quello che ammette sia da quello che
 * nega. Un tipo che non combacia con niente è il caso peggiore: sembra
 * rifiutato per policy e invece è rifiutato per punteggiatura.
 */
export function normalizeMime(raw: string | null | undefined): string {
  if (!raw) return "";
  return (raw.split(";")[0] ?? "").trim().toLowerCase();
}

/** L'estensione in minuscolo, senza punto. `""` se non ce n'è. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * L'UNICA decisione sul tipo di un upload, e la esporta questo modulo perché il
 * test importi QUESTA e non una copia (la copia locale nel test è il motivo per
 * cui il 400 su `.txt` non l'aveva visto nessuno).
 *
 * Tre domande, perché tre sono le strade con cui il file può tornare indietro
 * attivo: il tipo DICHIARATO, il tipo che l'estensione produrrà quando lo
 * serviremo, e l'estensione nuda per i nomi che la tabella del server non
 * conosce. Il dichiarato conta meno di quanto sembri — sotto Bun
 * `req.formData()` IGNORA il `Content-Type` della parte e lo ri-deriva dal nome
 * del file — ma resta il valore che arriva da altri client HTTP, quindi si
 * guarda comunque.
 */
export function isActiveContentUpload(fileName: string, declaredType: string, servedType: string): boolean {
  return (
    ACTIVE_CONTENT_MIMES.has(normalizeMime(declaredType)) ||
    ACTIVE_CONTENT_MIMES.has(normalizeMime(servedType)) ||
    ACTIVE_CONTENT_EXTENSIONS.has(extensionOf(fileName))
  );
}

/**
 * The guard headers for a stored file served INLINE on the app's own origin.
 *
 * One function because there are two doors onto the same bytes: `/api/media`
 * and `/preview/` (server.ts) both hand back a file from a project directory
 * with a `Content-Type` deduced from the extension. `/preview/` had neither
 * header until this was extracted, so an `.html` or `.svg` an agent wrote (or
 * an upload) ran as a same-origin document with the session cookie and could
 * call `/api/files/content` and `/api/files/save` from inside the page.
 *
 * `nosniff` alone does not cover an SVG: there the declared type IS the active
 * one, nothing is being guessed. What closes it is `sandbox`, which puts the
 * DOCUMENT in an opaque origin, so the script inside no longer sees the cookie
 * nor the API. An `<img>` creates no document, so legitimate SVG images still
 * draw: that is why the answer is a sandbox and not a forced `attachment`,
 * which would turn "open this file in the pane" into a download.
 *
 * `sandboxFlags` is what the two doors do NOT share. `/api/media` grants
 * nothing: those files are attachments and context uploads, and no one expects
 * them to run. `/preview/` grants `allow-scripts allow-forms allow-popups`,
 * the exact set of the iframe the client already renders it in
 * (`client/src/components/Editor/fileMedia.tsx`), so previewing a page an
 * agent wrote keeps working. The directive that matters is the one NEITHER
 * grants: without `allow-same-origin` the document has no origin to abuse.
 */
export function activeContentGuardHeaders(
  contentType: string,
  opts?: { sandboxFlags?: string },
): Record<string, string> {
  const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff" };
  if (ACTIVE_CONTENT_MIMES.has(normalizeMime(contentType))) {
    headers["Content-Security-Policy"] = `sandbox${opts?.sandboxFlags ? " " + opts.sandboxFlags : ""}`;
  }
  return headers;
}

/** What `/preview/` grants inside its sandbox: the iframe's own attribute set,
 *  minus `allow-same-origin`, which is the whole point. */
export const PREVIEW_SANDBOX_FLAGS = "allow-scripts allow-forms allow-popups";

/** A topic id that can be a directory name and nothing else. The negated form
 *  of the class `getMessagesPath` sanitizes with, so the two agree on what a
 *  topic id is allowed to look like. */
export const TOPIC_ID_SEGMENT = /^[A-Za-z0-9_:-]+$/;

export function createMediaRouter(ctx: AppContext): RouteHandler {
  const {
    json, readJSON, getTopicById, saveSingleTopic,
    isPathAllowed, resolveProjectPath, getMimeType,
    UPLOADS_DIR, CONTEXT_DIR,
  } = ctx;

  return async function mediaRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {
    // --- Media serving ---
    if (method === "GET" && pathname === "/api/media") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return json({ error: "path parameter required" }, 400);
      // Prefer the media allowlist for cacheable project media; fall back to
      // resolveProjectPath so sibling images of any openable MD file load.
      // Symmetric with /api/files/content which also uses resolveProjectPath.
      let resolved = isPathAllowed(resolve(filePath)) ? resolve(filePath) : resolveProjectPath(filePath);
      // Da quando un file locale si APRE nel pannello passando di qui, un
      // rifiuto finisce a schermo intero davanti a una persona: in JSON è
      // indistinguibile dalla pagina bianca. Stesso codice HTTP, lingua umana —
      // e solo per le navigazioni (vedi media-error-page.ts).
      const asHtml = wantsHtml(req.headers.get("accept"));
      if (!resolved) {
        if (!asHtml) return json({ error: "forbidden: invalid path" }, 403);
        return new Response(
          mediaErrorHtml({
            path: filePath,
            title: "Questo file non posso servirlo",
            detail:
              "È fuori dalle cartelle che questo server può leggere. Spostalo in una cartella consentita, oppure apri il progetto a cui appartiene.",
          }),
          { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      if (!existsSync(resolved)) {
        if (!asHtml) return new Response("Not Found", { status: 404 });
        return new Response(
          mediaErrorHtml({
            path: resolved,
            title: "Questo file non c'è",
            detail: "Il percorso è consentito, ma sul disco non esiste (o è stato spostato).",
          }),
          { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }
      const file = Bun.file(resolved);
      const contentType = getMimeType(resolved);
      // Questa rotta restituisce file di cui NON conosciamo la provenienza —
      // i file di contesto caricati da un client, i media di un progetto — con
      // il `Content-Type` dedotto dall'estensione, sulla nostra origine. Il
      // perché delle due intestazioni sta su `activeContentGuardHeaders`, che
      // è la stessa che compone quelle di `/preview/`.
      const guardie = activeContentGuardHeaders(contentType);
      // Range support — required for <video> seeking (review clips). Bun does
      // NOT auto-slice a manually-built Response (verified: a Range request got
      // a full 200), so serve 206 ourselves when a Range header is present; a
      // full 200 with Accept-Ranges otherwise. Harmless for images.
      const size = file.size;
      const range = req.headers.get("range");
      const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" } });
        }
        end = Math.min(end, size - 1);
        return new Response(file.slice(start, end + 1), {
          status: 206,
          headers: {
            ...guardie,
            "Content-Type": contentType,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
          },
        });
      }
      return new Response(file, { headers: { ...guardie, "Content-Type": contentType, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600" } });
    }

    // --- Base64 image upload ---
    if (method === "POST" && pathname === "/api/upload-image") {
      try {
        const body = await readJSON(req);
        if (!body?.dataUrl || !body?.mimeType) return json({ error: "dataUrl and mimeType required" }, 400);
        const { dataUrl, mimeType } = body;
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return json({ error: "Invalid data URL format" }, 400);
        const ext = mimeType === "image/png" ? "png" : "jpg";
        mkdirSync(UPLOADS_DIR, { recursive: true });
        const filename = `${Date.now()}-paste.${ext}`;
        const filepath = join(UPLOADS_DIR, filename);
        // Cap the payload like /api/context-upload does (10MB) — this base64
        // path had no size limit, so a huge dataUrl was decoded into memory and
        // written straight to disk (asymmetric memory/disk-fill).
        //
        // `/api/upload` was named here too, and it was NOT true: that route had
        // neither a cap nor a MIME check, and this comment is why nobody went
        // to look. A comment that promises a control the code does not have is
        // worse than no comment — both routes now have both, and the shared
        // `MAX_UPLOAD_SIZE` at the top of the file is what keeps the claim honest.
        const b64 = match[2];
        // base64 inflates ~4:3 — cheap pre-decode guard before buffering.
        if (b64.length > MAX_UPLOAD_SIZE * 1.4) return json({ error: "Image too large. Maximum size is 10MB." }, 413);
        const buffer = Buffer.from(b64, "base64");
        if (buffer.byteLength > MAX_UPLOAD_SIZE) return json({ error: "Image too large. Maximum size is 10MB." }, 413);
        writeFileSync(filepath, buffer);
        return json({ url: filepath });
      } catch (err: any) { return json({ error: "Image upload failed: " + err.message }, 500); }
    }

    // --- File upload ---
    //
    // Il tetto e il controllo sul tipo ci sono per davvero, e per molto tempo
    // non c'erano: il corpo finiva intero in `arrayBuffer()` e da lì su disco,
    // senza limite di dimensione e senza guardare niente. Il commento di
    // `/api/upload-image` lo dava per scontato anche di questa: era la
    // rassicurazione più pericolosa possibile, perché diceva che il controllo
    // c'era e faceva smettere di cercarlo.
    //
    // Il controllo NEGA il contenuto attivo e ammette il resto. La prima
    // versione faceva il contrario, e un'allowlist di MIME su un allegato
    // rifiutava `.txt`, `.log`, `.json`, `.zip`, `.m4a` e ogni file senza
    // estensione: una recinzione che tiene fuori l'uso legittimo non protegge
    // niente, si aggira col menu «apri con».
    if (method === "POST" && pathname === "/api/upload") {
      try {
        // PRIMA di leggere il corpo. `formData()` bufferizza tutto, quindi un
        // controllo fatto dopo avrebbe già pagato la memoria che vuole negare.
        // È la busta, non il file: da qui il margine per l'involucro multipart.
        const declaredLength = Number(req.headers.get("content-length") ?? "");
        if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_SIZE + MULTIPART_SLACK) {
          return json({ error: "File too large. Maximum size is 10MB." }, 413);
        }
        const formData = await req.formData();
        const file = formData.get("file");
        if (!file || typeof file === "string") return json({ error: "file required" }, 400);
        // …e poi sul FILE, che è la misura che conta: `content-length` può
        // mancare (chunked) e comunque descrive la busta.
        if ((file as File).size > MAX_UPLOAD_SIZE) {
          return json({ error: "File too large. Maximum size is 10MB." }, 413);
        }
        const safeName = (file as File).name.replace(/[^a-zA-Z0-9._-]/g, "_");
        // DENY, non ALLOW: un'estensione sconosciuta si archivia, non si
        // rifiuta. Vedi `isActiveContentUpload` — e il tipo mostrato all'utente
        // è quello NORMALIZZATO, perché «File type not allowed:
        // text/plain;charset=utf-8» dava la colpa a un parametro.
        const declaredType = normalizeMime((file as File).type) || normalizeMime(getMimeType(safeName));
        if (isActiveContentUpload(safeName, declaredType, getMimeType(safeName))) {
          return json({ error: `File type not allowed: ${declaredType || "unknown"}. Active content (HTML, SVG, scripts) cannot be stored here.` }, 400);
        }
        mkdirSync(UPLOADS_DIR, { recursive: true });
        const filename = `${Date.now()}-${safeName}`;
        const filepath = join(UPLOADS_DIR, filename);
        const buffer = await (file as File).arrayBuffer();
        writeFileSync(filepath, Buffer.from(buffer));
        return json({ path: filepath, filename: (file as File).name, size: (file as File).size });
      } catch (err: any) { return json({ error: "Upload failed: " + err.message }, 500); }
    }

    // --- Context file deletion ---
    if (method === "DELETE" && pathname === "/api/context-file") {
      const body = await readJSON(req);
      if (!body?.topicId || !body?.filePath) return json({ error: "topicId and filePath required" }, 400);
      const topic = getTopicById(body.topicId);
      if (!topic) return json({ error: "not found" }, 404);
      topic.contextFiles = (topic.contextFiles || []).filter(f => f !== body.filePath);
      topic.updatedAt = new Date().toISOString();
      saveSingleTopic(topic);
      return json({ ok: true });
    }

    // --- Context file upload ---
    if (method === "POST" && pathname === "/api/context-upload") {
      try {
        const formData = await req.formData();
        const file = formData.get("file");
        const topicId = formData.get("topicId") as string;
        if (!file || typeof file === "string") return json({ error: "file required" }, 400);
        if (!topicId) return json({ error: "topicId required" }, 400);
        // A SINGLE SEGMENT, judged before anything touches the disk. `topicId`
        // went straight into `join(CONTEXT_DIR, topicId)` + `mkdirSync`, and
        // `join` collapses `..`: only the file NAME was sanitized, so the
        // FOLDER walked out of CONTEXT_DIR wherever the caller asked. Same
        // character class as `getMessagesPath` (`server/utils.ts`), which is
        // the shape a topic id really has; the twin route
        // `POST /api/files/upload` reaches the same place with
        // `hasDotDotSegment` + `isContained`.
        if (!TOPIC_ID_SEGMENT.test(topicId)) return json({ error: "invalid topicId" }, 400);
        const safeName = (file as File).name.replace(/[^a-zA-Z0-9._-]/g, "_");
        // La STESSA porta, la stessa regola. L'allowlist che stava qui ammetteva
        // `text/html` e `image/svg+xml` (misurato: `l.svg` → 200, scritto in
        // CONTEXT_DIR) e quella cartella torna indietro da `/api/media` con il
        // `Content-Type` dedotto dall'estensione: era la seconda porta sullo
        // stesso XSS memorizzato, aperta mentre la prima veniva chiusa.
        const fileType = normalizeMime((file as File).type) || normalizeMime(getMimeType(safeName));
        if (isActiveContentUpload(safeName, fileType, getMimeType(safeName))) {
          return json({ error: `File type not allowed: ${fileType || "unknown"}. Active content (HTML, SVG, scripts) cannot be stored here.` }, 400);
        }
        // 400 e non 413, com'era: questa rotta ha già dei clienti che leggono
        // il codice, e allinearla sarebbe un cambio di contratto travestito da
        // pulizia. Il tetto invece è lo stesso numero, dichiarato una volta.
        if ((file as File).size > MAX_UPLOAD_SIZE) return json({ error: "File too large. Maximum size is 10MB." }, 400);
        const topicDir = join(CONTEXT_DIR, topicId);
        mkdirSync(topicDir, { recursive: true });
        const filename = `${Date.now()}-${safeName}`;
        const filepath = join(topicDir, filename);
        const buffer = await (file as File).arrayBuffer();
        writeFileSync(filepath, Buffer.from(buffer));
        const topic = getTopicById(topicId);
        if (topic) {
          if (!topic.contextFiles) topic.contextFiles = [];
          topic.contextFiles.push(filepath);
          topic.updatedAt = new Date().toISOString();
          saveSingleTopic(topic);
        }
        return json({ path: filepath, filename: (file as File).name, size: (file as File).size });
      } catch (err: any) { return json({ error: "Upload failed: " + err.message }, 500); }
    }

    return null;
  };
}
