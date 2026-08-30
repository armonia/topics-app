/**
 * Attachments staged on a board composer, in ONE place.
 *
 * The task thread had its own upload loop and its own paste handler; the
 * composer that CREATES a task had neither, so a screenshot could be dropped on
 * an existing card and not on a new one. Two composers with the same gesture
 * are two copies that drift, and they had already drifted before anybody wrote
 * them twice: this module is the gesture, both surfaces call it.
 *
 * The pipeline is the native chat's: POST /api/upload (multipart) gives back an
 * absolute path, which is what the board stores and what /api/media serves.
 */

export interface StagedAttachment {
  /** Absolute path returned by /api/upload — what the board stores. */
  path: string;
  name: string;
  isImage: boolean;
}

/** How many files one message carries. Beyond this the pill stops accepting. */
export const MAX_ATTACHMENTS = 8;

/**
 * The images inside a paste. A pasted screenshot arrives as a clipboard item of
 * kind 'file': text and rich text are left alone, so pasting a paragraph keeps
 * behaving like a paste.
 */
export function imagesFromClipboard(data: DataTransfer | null): File[] {
  return Array.from(data?.items ?? [])
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
}

/**
 * The files inside a drop. Everything is accepted (a PDF or a log is a legit
 * attachment), but a drag that carries no file at all — text selection, a link,
 * a pane being moved around the layout — gives an empty list, so the caller can
 * leave the event to whoever else wants it.
 */
export function filesFromDrop(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []);
}

/** Does this drag carry files? Answered on dragover, where `files` is empty by
 *  spec and only `types` is readable. */
export function dragCarriesFiles(data: DataTransfer | null): boolean {
  return Array.from(data?.types ?? []).includes('Files');
}

/**
 * Upload one file and return it staged. Throws with the server's own message:
 * the caller shows it, since a silent failure here looks exactly like a file
 * that never got attached.
 */
export async function uploadAttachment(file: File): Promise<StagedAttachment> {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/upload', { method: 'POST', body: fd });
  const d = await r.json().catch(() => null) as { path?: string; error?: string } | null;
  if (!r.ok || !d?.path) throw new Error(d?.error || 'upload failed');
  return { path: d.path, name: file.name, isImage: file.type.startsWith('image/') };
}
