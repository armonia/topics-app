/**
 * Quali file `browser_upload` ha il diritto di leggere.
 *
 * IL BUCO. `readUploadFile` prendeva `args.path`, apriva il file e ne
 * restituiva i byte in base64 perché finissero in un `<input type=file>` su una
 * pagina qualsiasi. Nessuna allowlist: solo "esiste" e "sta sotto il cap di
 * dimensione". Il commento sopra la funzione lo giustificava con «the browser
 * REST bridge is gateway-token gated» — ma il gate fida il LOOPBACK senza
 * token, per disegno. Sul percorso locale, che è quello che conta qui, quella
 * mitigazione non esisteva: il commento era più rassicurante del codice.
 *
 * LA MINACCIA È LOCALE, E NON È TEORICA. Non si arriva da remoto. Ma su una
 * macchina che fa girare agenti con tool-call generate da un modello basta un
 * path sbagliato in una chiamata per far leggere al server un file arbitrario
 * dell'utente e caricarlo su un sito raggiungibile. `~/.ssh/id_rsa` sta
 * comodamente sotto il cap dei 25 MB.
 *
 * LE DUE TRAPPOLE DEL CONFRONTO, che questo modulo evita:
 *
 * 1. `startsWith(root)` NUDO non è contenimento. Con radice `/Users/x/media`,
 *    `/Users/x/media-rubato/segreto` passa: è un fratello col prefisso giusto.
 *    Serve `p === root || p.startsWith(root + "/")`.
 *
 * 2. Il confronto va fatto sul path REALE. `../` si normalizza, ma un SYMLINK
 *    no: un link dentro una radice consentita che punta a `/etc` renderebbe
 *    `/etc` raggiungibile con un path che a stringa è impeccabile. Chi chiama
 *    deve passare il path già risolto (`realpathSync`) — e le radici pure, che
 *    a loro volta possono essere link.
 *
 * Questo modulo è PURO apposta: la risoluzione tocca il disco, la decisione no,
 * e la decisione è la parte che va provata.
 */
import { resolve, sep } from "path";

/** Un path è dentro una radice? Contenimento vero, non prefisso di stringa. */
export function isInsideRoot(candidate: string, root: string): boolean {
  const p = resolve(candidate);
  const r = resolve(root);
  if (p === r) return true;
  return p.startsWith(r.endsWith(sep) ? r : r + sep);
}

export interface UploadRootsInput {
  /** `~/.topics/media` e simili: dove gli agenti depositano i propri artefatti. */
  mediaDirs?: readonly string[];
  /** `UPLOADS_DIR` del server. */
  uploadsDir?: string | null;
  /** I progetti REGISTRATI. Sono cartelle che l'utente ha dichiarato come
   *  proprie: consentirle tiene in piedi il caso d'uso vero (caricare un
   *  documento che sta nel progetto su cui si sta lavorando) senza aprire il
   *  disco intero. */
  projectPaths?: readonly string[];
  /** Radici extra dichiarate a mano (`TOPICS_UPLOAD_ROOTS`, separate da `:`).
   *  La valvola per un caso che non avevamo previsto, esplicita e dell'utente. */
  extraRoots?: readonly string[];
}

/** Le radici consentite, normalizzate e deduplicate. Vuote ⇒ nessun upload. */
export function uploadAllowedRoots(input: UploadRootsInput): string[] {
  const all = [
    ...(input.mediaDirs ?? []),
    ...(input.uploadsDir ? [input.uploadsDir] : []),
    ...(input.projectPaths ?? []),
    ...(input.extraRoots ?? []),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of all) {
    const t = (r ?? "").trim();
    if (!t) continue;
    const abs = resolve(t);
    // `/` come radice consentita vanificherebbe l'allowlist in silenzio: se
    // qualcuno la configura, è quasi certamente un errore e va detto.
    if (abs === sep) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

export type UploadPathVerdict = { ok: true } | { ok: false; error: string };

/**
 * Decide se un path REALE (già risolto dai symlink) è consentito.
 *
 * Il rifiuto nomina il path e le radici attese: un "permesso negato" che non
 * dice cosa ci si aspettava costringe chi lo legge a indovinare, e chi lo
 * legge qui è spesso un agente che deve correggere la propria chiamata.
 */
export function checkUploadPath(realPath: string, roots: readonly string[]): UploadPathVerdict {
  if (roots.length === 0) {
    return {
      ok: false,
      error:
        "browser_upload: nessuna radice consentita configurata. Nessun file può essere caricato. " +
        "Definisci TOPICS_UPLOAD_ROOTS o registra il progetto.",
    };
  }
  if (roots.some((r) => isInsideRoot(realPath, r))) return { ok: true };
  return {
    ok: false,
    error:
      `browser_upload: percorso fuori dalle radici consentite: ${realPath}. ` +
      `Radici attese: ${roots.join(", ")}. ` +
      `Se il file serve davvero, spostalo sotto una di queste (o aggiungi la radice a TOPICS_UPLOAD_ROOTS).`,
  };
}

/** `TOPICS_UPLOAD_ROOTS=/a:/b` → `["/a","/b"]`. Vuoto/assente ⇒ nessuna extra. */
export function parseExtraRoots(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw.split(":").map((s) => s.trim()).filter(Boolean);
}
