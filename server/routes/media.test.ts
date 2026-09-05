/**
 * Le tre porte che scrivono e restituiscono file di provenienza ignota:
 * `/api/upload`, `/api/context-upload` e `/api/media`.
 *
 * COSA MISURA, e perché la versione precedente di questo file non lo misurava.
 *
 * 1. La politica sul tipo si IMPORTA da `./media`, non si ricopia qui. La copia
 *    locale (un `ALLOWED_UPLOAD_MIMES` scritto a mano in cima al test) diceva sì
 *    a `text/plain` mentre la rotta vera riceveva `text/plain;charset=utf-8` e
 *    rispondeva 400: un allegato `.txt` era rotto in produzione con la suite
 *    tutta verde. Un test che ridichiara la regola che deve sorvegliare non
 *    sorveglia niente.
 *
 * 2. Che cosa arriva davvero nel `type` di una parte multipart lo si MISURA
 *    (primo test), invece di darlo per scontato: sotto Bun `req.formData()`
 *    IGNORA il `Content-Type` dichiarato dal client e lo ri-deriva dal nome del
 *    file. Lo scenario «travestito» che il vecchio test diceva di provare non
 *    esiste in quella forma, e credere il contrario faceva sembrare coperto un
 *    asse che era scoperto.
 *
 * 3. La difesa si prova anche con `getMimeType` CIECO (tutto
 *    `application/octet-stream`): è la condizione reale per `.xhtml`, `.mjs`,
 *    `.svgz`, che la tabella del server non conosce.
 *
 * Il router è puro rispetto al disco tranne che per le cartelle iniettate,
 * quindi si prova per intero senza avviare il server, e la misura è il
 * CONTENUTO della cartella — non solo lo status.
  * @covers MEDIA-01
 */

import { describe, expect, test, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, extname, resolve } from "path";
import {
  createMediaRouter,
  isActiveContentUpload,
  normalizeMime,
  ACTIVE_CONTENT_MIMES,
  ACTIVE_CONTENT_EXTENSIONS,
  activeContentGuardHeaders,
  PREVIEW_SANDBOX_FLAGS,
} from "./media";
import type { AppContext } from "../types";
import { closeDatabase } from "../db";

/* DATA_DIR E' AMBIENTE CONDIVISO, e questo file lo scrive.
 *
 * `server/db.ts:17` risolve la cartella dati come `process.env.DATA_DIR ||
 * join(dataRoot, "data")`: l'ambiente vince sull'argomento esplicito. Bun
 * carica piu' file di test nello STESSO processo, quindi una scrittura non
 * restituita decide dove finisce il database di tutti i file caricati dopo.
 * Misurato il 21/08: due file lanciati insieme aprivano quattro volte lo
 * stesso db temporaneo di uno dei due, mentre da soli ne creavano di propri.
 * Qui la variabile serve davvero (non si passa da `initDatabase`), quindi si
 * RESTITUISCE invece di toglierla. */
const DATA_DIR_PRIMA = process.env.DATA_DIR;


const tmpRoot = mkdtempSync(join(tmpdir(), "media-route-test-"));
let uploadsDir: string;
let contextDir: string;
let mediaDir: string;

/**
 * La tabella del server (`server/utils.ts`) per le estensioni che questi test
 * toccano. È uno STUB di una dipendenza iniettata, non una copia della regola:
 * la regola sta in `isActiveContentUpload`, che il test importa. Ciò che questa
 * tabella deve riprodurre fedelmente è il PARAMETRO — `text/plain;charset=…` è
 * quello che Bun consegna davvero, ed è il valore su cui la rotta cadeva.
 */
function getMimeType(p: string): string {
  const types: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".pdf": "application/pdf",
    ".html": "text/html", ".svg": "image/svg+xml", ".txt": "text/plain",
    ".md": "text/markdown", ".webm": "video/webm", ".json": "application/json",
    ".csv": "text/csv", ".zip": "application/zip", ".m4a": "audio/mp4",
    ".js": "application/javascript",
  };
  return types[extname(p).toLowerCase()] || "application/octet-stream";
}

/** La tabella CIECA: è la condizione reale per ogni estensione che il server
 *  non conosce, e sotto di essa regge solo l'asse dell'estensione. */
const blindMimeType = () => "application/octet-stream";

type ContextTopic = { id: string; contextFiles?: string[]; updatedAt?: string };
type MediaRouterOptions = {
  topics?: Map<string, ContextTopic>;
  rawGlobalTopicIds?: ReadonlySet<string>;
};

function router(mime: (p: string) => string = getMimeType, options: MediaRouterOptions = {}) {
  // Context upload is intentionally Topic-bound. Keep one normal target by
  // default so the ordinary positive upload tests exercise the real path.
  const topics = options.topics ?? new Map<string, ContextTopic>([["t-1", { id: "t-1", contextFiles: [] }]]);
  const rawGlobalTopicIds = options.rawGlobalTopicIds ?? new Set<string>();
  const ctx = {
    // The registry helper only needs this raw id lookup. It deliberately does
    // not model eligibility: a damaged global row is still a role that must be
    // denied before this route reaches the filesystem.
    db: {
      query: () => ({
        get: (_scope: string, topicId: string) => rawGlobalTopicIds.has(topicId)
          ? { scope: "global", topic_id: topicId, created_at: "now", updated_at: "now" }
          : null,
      }),
    },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    getTopicById: (topicId: string) => topics.get(topicId) ?? null,
    saveSingleTopic: (topic: ContextTopic) => { topics.set(topic.id, topic); },
    // `/api/media` serve solo ciò che sta nella cartella consentita del test.
    isPathAllowed: (p: string) => resolve(p).startsWith(mediaDir),
    resolveProjectPath: () => null,
    getMimeType: mime,
    UPLOADS_DIR: uploadsDir,
    CONTEXT_DIR: contextDir,
  } as unknown as AppContext;
  return createMediaRouter(ctx);
}

/** Un upload multipart vero: è `req.formData()` a leggerlo, quindi la busta
 *  deve essere quella reale — un finto `File` in un oggetto non proverebbe
 *  niente del percorso che conta. */
async function upload(
  file: File,
  mime: (p: string) => string = getMimeType,
): Promise<{ status: number; body: { path?: string; error?: string } }> {
  const fd = new FormData();
  fd.append("file", file);
  const req = new Request("http://localhost/api/upload", { method: "POST", body: fd });
  const url = new URL(req.url);
  const res = await router(mime)(req, url, url.pathname, "POST");
  if (!res) throw new Error("la rotta non ha risposto");
  return { status: res.status, body: (await res.json()) as { path?: string; error?: string } };
}

async function contextUpload(
  file: File,
  topicId = "t-1",
  options?: MediaRouterOptions,
): Promise<{ status: number; body: { path?: string; error?: string } }> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("topicId", topicId);
  const req = new Request("http://localhost/api/context-upload", { method: "POST", body: fd });
  const url = new URL(req.url);
  const res = await router(getMimeType, options)(req, url, url.pathname, "POST");
  if (!res) throw new Error("la rotta non ha risposto");
  return { status: res.status, body: (await res.json()) as { path?: string; error?: string } };
}

async function contextDelete(
  topicId: string,
  filePath: string,
  options?: MediaRouterOptions,
): Promise<{ status: number; body: { error?: string; code?: string } }> {
  const req = new Request("http://localhost/api/context-file", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topicId, filePath }),
  });
  const url = new URL(req.url);
  const res = await router(getMimeType, options)(req, url, url.pathname, "DELETE");
  if (!res) throw new Error("la rotta non ha risposto");
  return { status: res.status, body: (await res.json()) as { error?: string; code?: string } };
}

async function fetchMedia(path: string, range?: string): Promise<Response> {
  const req = new Request(`http://localhost/api/media?path=${encodeURIComponent(path)}`, {
    headers: range ? { range } : undefined,
  });
  const url = new URL(req.url);
  const res = await router()(req, url, url.pathname, "GET");
  if (!res) throw new Error("la rotta non ha risposto");
  return res;
}

/** La misura vera: cosa è finito su disco. Uno status da solo non distingue
 *  «rifiutato» da «rifiutato dopo aver scritto». */
function uploadedFiles(): string[] {
  return existsSync(uploadsDir) ? readdirSync(uploadsDir) : [];
}

function contextFiles(topicId = "t-1"): string[] {
  const dir = join(contextDir, topicId);
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeEach(() => {
  uploadsDir = mkdtempSync(join(tmpRoot, "uploads-"));
  contextDir = mkdtempSync(join(tmpRoot, "context-"));
  mediaDir = mkdtempSync(join(tmpRoot, "media-"));
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("multipart · che cosa arriva DAVVERO nel tipo di una parte", () => {
  test("Bun ri-deriva il tipo dal NOME DEL FILE e butta via quello dichiarato", async () => {
    // La misura che smonta lo scenario «travestito» come era scritto prima: il
    // valore dichiarato dal client non sopravvive a `formData()`, quindi un
    // controllo sul solo tipo dichiarato non è aggirabile — è semplicemente un
    // controllo su un valore che nessun client controlla più.
    const fd = new FormData();
    fd.append("finta", new File(["<script>"], "finta.html", { type: "image/png" }));
    fd.append("foto", new File(["x"], "foto.png", { type: "text/html" }));
    const letta = await new Request("http://x/", { method: "POST", body: fd }).formData();

    expect((letta.get("finta") as File).type).toBe("text/html;charset=utf-8");
    expect((letta.get("foto") as File).type).toBe("image/png");
    // …e il parametro c'è anche sul caso banale: è il valore su cui l'allowlist
    // rispondeva 400 a un `.txt`.
    fd.append("nota", new File(["ciao"], "nota.txt", { type: "text/plain" }));
    const due = await new Request("http://x/", { method: "POST", body: fd }).formData();
    expect((due.get("nota") as File).type).toBe("text/plain;charset=utf-8");
  });
});

describe("la politica sul tipo · importata, non ricopiata", () => {
  test("normalizeMime toglie parametri, spazi e maiuscole", () => {
    expect(normalizeMime("text/plain;charset=utf-8")).toBe("text/plain");
    expect(normalizeMime("  TEXT/HTML ; charset=UTF-8 ")).toBe("text/html");
    expect(normalizeMime("image/png")).toBe("image/png");
    expect(normalizeMime(null)).toBe("");
    expect(normalizeMime("")).toBe("");
  });

  test("il contenuto attivo resta negato ANCHE con il parametro attaccato", () => {
    // Il modo esatto in cui l'XSS memorizzato si riapriva: chi «sistemava» il
    // 400 su `.txt` aggiungendo le varianti con charset a un'allowlist faceva
    // rientrare `text/html;charset=utf-8` senza che niente diventasse rosso.
    expect(isActiveContentUpload("nota.txt", "text/html;charset=utf-8", "text/plain")).toBe(true);
    expect(isActiveContentUpload("nota.txt", "IMAGE/SVG+XML", "text/plain")).toBe(true);
    // …e un tipo inerte con parametro NON è contenuto attivo.
    expect(isActiveContentUpload("nota.txt", "text/plain;charset=utf-8", "text/plain")).toBe(false);
  });

  test("ogni MIME attivo ha l'estensione corrispondente nell'altro insieme", () => {
    // I due insiemi sono due assi della stessa regola: se uno nomina un tipo
    // che l'altro non riconosce, resta la strada in cui il file passa.
    const perExtension = new Map([
      ["text/html", "html"], ["application/xhtml+xml", "xhtml"], ["image/svg+xml", "svg"],
      ["text/javascript", "js"], ["application/javascript", "js"],
      ["application/x-javascript", "js"], ["application/x-httpd-php", "php"],
    ]);
    for (const mime of ACTIVE_CONTENT_MIMES) {
      // Un MIME nuovo senza voce qui fa rosso: `undefined` non sta in nessun
      // insieme, ed è esattamente la strada che resterebbe aperta.
      const ext = perExtension.get(mime) ?? "";
      expect(`${mime}→${ext}→${ACTIVE_CONTENT_EXTENSIONS.has(ext)}`).toBe(`${mime}→${ext}→true`);
    }
  });
});

describe("contro la tabella VERA del server, non contro lo stub", () => {
  /**
   * `getMimeType` e `ALLOWED_UPLOAD_MIMES` vivono dentro la chiusura di
   * `createAppContext` (`server/utils.ts`), che apre un database: lo si costruisce
   * su una cartella temporanea con le migration copiate — lo stesso schema di
   * `push.test.ts` — così qui dentro girano gli oggetti REALI e non una loro
   * imitazione. È il punto: la copia locale in cima a questo file diceva che
   * `text/plain` bastava, e la rotta vera riceveva `text/plain;charset=utf-8`.
   */
  let vero: { getMimeType: (p: string) => string; ALLOWED_UPLOAD_MIMES: Set<string> };

  beforeAll(async () => {
    const base = mkdtempSync(join(tmpdir(), "media-real-ctx-"));
    const migDir = join(base, "server", "db", "migrations");
    mkdirSync(migDir, { recursive: true });
    const realMigDir = join(import.meta.dir, "..", "db", "migrations");
    for (const f of readdirSync(realMigDir)) {
      if (!f.endsWith(".sql")) continue;
      writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
    }
    process.env.DATA_DIR = join(base, "data");
    const { createAppContext } = await import("../utils");
    const ctx = createAppContext(base);
    vero = { getMimeType: ctx.getMimeType, ALLOWED_UPLOAD_MIMES: ctx.ALLOWED_UPLOAD_MIMES };
  });

  test("lo stub di questo file COMBACIA con la tabella vera, estensione per estensione", () => {
    // Il cancello contro la deriva: se la tabella del server cambia sotto i
    // piedi, i test qui sopra continuerebbero a girare su un mondo che non
    // esiste più — che è esattamente com'è passata inosservata la regressione.
    for (const ext of [".png", ".jpg", ".pdf", ".html", ".svg", ".txt", ".md", ".webm", ".json", ".csv", ".zip", ".js"]) {
      expect(`${ext}→${getMimeType(`x${ext}`)}`).toBe(`${ext}→${vero.getMimeType(`x${ext}`)}`);
    }
    // …e per un'estensione che nessuna delle due conosce.
    expect(getMimeType("x.qqq")).toBe(vero.getMimeType("x.qqq"));
  });

  test("l'allowlist VERA contiene contenuto attivo: non poteva essere lei la guardia", () => {
    // `ALLOWED_UPLOAD_MIMES` ammette `text/html`, `text/javascript` e
    // `image/svg+xml`. Chi «sistemava» il 400 su `.txt` allargandola avrebbe
    // riaperto l'XSS memorizzato senza che niente diventasse rosso: la difesa
    // deve stare in un insieme che NEGA, ed è quello importato da `./media`.
    for (const attivo of ["text/html", "text/javascript", "image/svg+xml"]) {
      expect(`${attivo}→ammesso:${vero.ALLOWED_UPLOAD_MIMES.has(attivo)}`).toBe(`${attivo}→ammesso:true`);
      expect(`${attivo}→negato:${ACTIVE_CONTENT_MIMES.has(attivo)}`).toBe(`${attivo}→negato:true`);
    }
  });

  test("con il getMimeType VERO: gli allegati passano e il contenuto attivo no", async () => {
    for (const name of ["nota.txt", "log.log", "conf.json", "arch.zip", "senzaestensione", "registrazione.m4a"]) {
      const r = await upload(new File(["x"], name), vero.getMimeType);
      expect(`${name}→${r.status}`).toBe(`${name}→200`);
    }
    for (const name of ["xss.html", "logo.svg", "pagina.xhtml", "modulo.mjs"]) {
      const r = await upload(new File(["<script>alert(1)</script>"], name), vero.getMimeType);
      expect(`${name}→${r.status}`).toBe(`${name}→400`);
    }
    expect(uploadedFiles()).toHaveLength(6);
  });
});

describe("/api/upload · il tetto", () => {
  test("un file oltre i 10MB è 413, e la cartella resta VUOTA", async () => {
    const troppo = new File([new Uint8Array(11 * 1024 * 1024)], "grosso.png", { type: "image/png" });
    const r = await upload(troppo);
    expect(r.status).toBe(413);
    expect(uploadedFiles()).toHaveLength(0);
  });

  test("un file dentro il tetto passa e viene scritto — il controllo positivo", async () => {
    // Senza questo, un rifiuto totale farebbe passare i test qui sopra per il
    // motivo sbagliato.
    const r = await upload(new File([new Uint8Array(1024)], "piccolo.png", { type: "image/png" }));
    expect(r.status).toBe(200);
    expect(uploadedFiles()).toHaveLength(1);
    expect(r.body.path?.startsWith(uploadsDir)).toBe(true);
  });
});

describe("/api/upload · si NEGA il contenuto attivo, non si ammette il resto", () => {
  test("gli allegati che l'allowlist rifiutava tornano a passare", async () => {
    // La regressione misurata: il selettore degli allegati di un commento è un
    // `<input type="file">` senza filtri, quindi ognuno di questi era un 400 in
    // faccia a una persona, con `text/plain;charset=utf-8` scritto nel
    // messaggio d'errore.
    for (const [name, type] of [
      ["nota.txt", "text/plain"],
      ["log.log", ""],
      ["conf.json", "application/json"],
      ["arch.zip", "application/zip"],
      ["senzaestensione", ""],
      ["registrazione.m4a", "audio/x-m4a"],
    ] as const) {
      const r = await upload(new File(["x"], name, type ? { type } : undefined));
      expect(`${name}→${r.status}`).toBe(`${name}→200`);
    }
    expect(uploadedFiles()).toHaveLength(6);
  });

  test("gli allegati veri continuano a passare: immagine, PDF, testo, clip", async () => {
    for (const [name, type] of [
      ["foto.png", "image/png"],
      ["nota.md", "text/markdown"],
      ["relazione.pdf", "application/pdf"],
      ["prova.webm", "video/webm"],
    ] as const) {
      const r = await upload(new File(["x"], name, { type }));
      expect(`${name}→${r.status}`).toBe(`${name}→200`);
    }
    expect(uploadedFiles()).toHaveLength(4);
  });

  test("il contenuto attivo è 400, e la cartella resta VUOTA", async () => {
    for (const name of ["xss.html", "logo.svg", "pagina.xhtml", "modulo.mjs", "index.phtml", "foglio.xsl"]) {
      const r = await upload(new File(["<script>alert(1)</script>"], name));
      expect(`${name}→${r.status}`).toBe(`${name}→400`);
    }
    expect(uploadedFiles()).toHaveLength(0);
  });

  test("regge anche se getMimeType è CIECO: l'estensione basta da sola", async () => {
    // `.xhtml`, `.mjs`, `.svgz` non stanno nella tabella del server, quindi per
    // loro il tipo servito è `application/octet-stream` e l'asse dei MIME non
    // vede niente. Questo è il caso reale, non un'ipotesi.
    for (const name of ["xss.html", "logo.svg", "pagina.xhtml", "modulo.mjs", "logo.svgz"]) {
      const r = await upload(new File(["<script>alert(1)</script>"], name), blindMimeType);
      expect(`${name}→${r.status}`).toBe(`${name}→400`);
    }
    expect(uploadedFiles()).toHaveLength(0);
  });

  test("l'errore mostra il tipo NORMALIZZATO: il parametro non è la colpa", async () => {
    const r = await upload(new File(["<h1>"], "xss.html"));
    expect(r.body.error).toContain("text/html.");
    expect(r.body.error).not.toContain("charset");
  });

  test("un eseguibile NON è contenuto attivo per questa porta, e si archivia", async () => {
    // Cambio di politica deliberato: `.exe` era 400 per via dell'allowlist. Non
    // viene mai servito come qualcosa che il browser esegue (torna
    // `application/octet-stream`, e `/uploads/` lo manda giù come `attachment`),
    // e rifiutare un allegato inerte è il difetto che questa porta aveva.
    const r = await upload(new File(["MZ"], "app.exe", { type: "application/x-msdownload" }));
    expect(r.status).toBe(200);
    expect(uploadedFiles()).toHaveLength(1);
  });
});

describe("/api/context-upload · la SECONDA porta, stessa regola", () => {
  test("l'SVG non entra più in CONTEXT_DIR", async () => {
    // Misurato prima della correzione: `l.svg` → 200 e il file scritto, perché
    // qui la regola era l'allowlist, e l'allowlist conteneva `image/svg+xml` e
    // `text/html`. Da lì `/api/media` lo restituiva col tipo dedotto
    // dall'estensione.
    const r = await contextUpload(new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "l.svg"));
    expect(r.status).toBe(400);
    expect(contextFiles()).toHaveLength(0);
  });

  test("nemmeno l'HTML", async () => {
    const r = await contextUpload(new File(["<script>alert(1)</script>"], "pagina.html"));
    expect(r.status).toBe(400);
    expect(contextFiles()).toHaveLength(0);
  });

  test("il `topicId` è UN segmento: con `..` dentro non si scrive niente, e non fuori dalla cartella", async () => {
    // `join(CONTEXT_DIR, topicId)` collapses `..`, so only the file NAME was
    // sanitized while the FOLDER walked out of the boundary: measured with
    // `topicId=../../../../tmp/topics-escape`, which really wrote there.
    const escape = join(tmpRoot, "context-escape");
    const upward = "../".repeat(6) + escape.replace(/^\//, "");
    for (const bad of [upward, "../evasione", "a/b", "", "."]) {
      const r = await contextUpload(new File(["x"], "note.txt"), bad);
      expect(`${bad}→${r.status}`).toBe(`${bad}→400`);
    }
    expect(existsSync(escape)).toBe(false);
    expect(existsSync(join(contextDir, ".."))).toBe(true); // the root is still there
    expect(readdirSync(contextDir)).toHaveLength(0);
  });

  test("i file di contesto veri passano, estensione ignota compresa", async () => {
    for (const name of ["appunti.txt", "dati.json", "schema.sql", "senzaestensione"]) {
      const r = await contextUpload(new File(["x"], name));
      expect(`${name}→${r.status}`).toBe(`${name}→200`);
    }
    expect(contextFiles()).toHaveLength(4);
  });

  test("requires an existing Topic before deriving or creating a context directory", async () => {
    // A well-formed id that names nobody: the single-segment guard above has
    // already answered 400 for the shapes that try to walk out, so this one is
    // about the OTHER half of the door. No directory is created for a Topic
    // that does not exist, which is how a phantom sibling of the context root
    // used to appear from a multipart field alone.
    const unknownId = "topic-that-does-not-exist";
    const r = await contextUpload(new File(["x"], "nota.txt"), unknownId);

    expect(r.status).toBe(404);
    expect(existsSync(join(contextDir, unknownId))).toBe(false);
    expect(contextFiles()).toHaveLength(0);
  });

  test("contains even a corrupt stored Topic id before filesystem effects", async () => {
    const topics = new Map<string, ContextTopic>([
      ["crafted", { id: "../outside-context-root", contextFiles: [] }],
    ]);
    const escaped = resolve(contextDir, "../outside-context-root");
    const r = await contextUpload(new File(["x"], "nota.txt"), "crafted", { topics });

    expect(r.status).toBe(400);
    expect(existsSync(escaped)).toBe(false);
  });

  test("raw registered coordinator cannot upload or delete generic context files", async () => {
    const topicId = "global-coordinator";
    const existing = join(contextDir, topicId, "already-there.txt");
    mkdirSync(join(contextDir, topicId), { recursive: true });
    writeFileSync(existing, "kept");
    const topic: ContextTopic = { id: topicId, contextFiles: [existing] };
    const options: MediaRouterOptions = {
      topics: new Map([[topicId, topic]]),
      rawGlobalTopicIds: new Set([topicId]),
    };

    const upload = await contextUpload(new File(["x"], "nota.txt"), topicId, options);
    expect(upload.status).toBe(403);
    expect(contextFiles(topicId)).toEqual(["already-there.txt"]);
    expect(topic.contextFiles).toEqual([existing]);

    const deletion = await contextDelete(topicId, existing, options);
    expect(deletion.status).toBe(403);
    expect(deletion.body.code).toBe("orchestrator_topic_invariant");
    expect(topic.contextFiles).toEqual([existing]);
  });

  test("context-file delete only changes a path contained in the target Topic directory", async () => {
    const topicId = "ordinary-topic";
    const outside = join(tmpRoot, "not-a-context-file.txt");
    writeFileSync(outside, "do not detach this metadata");
    const topic: ContextTopic = { id: topicId, contextFiles: [outside] };
    const r = await contextDelete(topicId, outside, {
      topics: new Map([[topicId, topic]]),
    });

    expect(r.status).toBe(400);
    expect(topic.contextFiles).toEqual([outside]);
  });
});

describe("/api/media · come torna indietro ciò che è stato caricato", () => {
  function seed(name: string, body: string): string {
    mkdirSync(mediaDir, { recursive: true });
    const p = join(mediaDir, name);
    writeFileSync(p, body);
    return p;
  }

  test("un SVG torna sandboxato: lo script non è più sulla nostra origine", async () => {
    const p = seed("logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    const res = await fetchMedia(p);
    expect(res.status).toBe(200);
    // Il tipo resta quello vero, o un `<img src>` legittimo smetterebbe di
    // disegnarsi: a togliere l'origine è la sandbox, non il Content-Type.
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("e un HTML pure", async () => {
    const p = seed("pagina.html", "<script>alert(1)</script>");
    const res = await fetchMedia(p);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });

  test("un'immagine normale NON viene sandboxata, ma il nosniff c'è comunque", async () => {
    // Controllo positivo: se sandboxassimo tutto, i test qui sopra passerebbero
    // per il motivo sbagliato e le anteprime sarebbero rotte.
    const p = seed("foto.png", "\x89PNG");
    const res = await fetchMedia(p);
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("le stesse guardie sulla risposta PARZIALE (206), o basta un Range per aggirarle", async () => {
    const p = seed("logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    const res = await fetchMedia(p, "bytes=0-9");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("activeContentGuardHeaders · la funzione che compone quelle guardie", () => {
  // `/preview/` (server.ts) serves the SAME files as `/api/media` and carried
  // neither nosniff nor sandbox: a project `.html` ran on our own origin with
  // the session cookie. Both doors now call this, so they can no longer drift
  // apart; the parameter is the only thing that tells them apart.
  test("il contenuto attivo prende la sandbox, l'inerte no, il nosniff sempre", () => {
    expect(activeContentGuardHeaders("text/html")).toEqual({
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    });
    expect(activeContentGuardHeaders("image/svg+xml;charset=utf-8")["Content-Security-Policy"]).toBe("sandbox");
    expect(activeContentGuardHeaders("image/png")).toEqual({ "X-Content-Type-Options": "nosniff" });
  });

  test("l'anteprima concede gli stessi permessi dell'iframe del client, mai `allow-same-origin`", () => {
    // The preview must keep RUNNING a page an agent wrote (the client already
    // renders it in an iframe with these very flags); what closes the hole is
    // the directive neither door grants.
    const policy = activeContentGuardHeaders("text/html", { sandboxFlags: PREVIEW_SANDBOX_FLAGS })["Content-Security-Policy"];
    expect(policy).toBe("sandbox allow-scripts allow-forms allow-popups");
    expect(policy).not.toContain("allow-same-origin");
  });
});

afterAll(() => {
  // The "what REALLY arrives" describe opens the `_db` singleton through
  // createAppContext (line ~241) and never closed it: `_db` stayed open for the
  // next file in the same process. Under sharded execution that file can be
  // migration-registry-by-name, whose initDatabase becomes a no-op on the stale
  // singleton and never creates its dataDir: "unable to open database file".
  // Closing here makes this file order-independent.
  closeDatabase();
  if (DATA_DIR_PRIMA === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = DATA_DIR_PRIMA;
});
