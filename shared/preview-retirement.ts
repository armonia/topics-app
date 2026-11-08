/**
 * «Anteprima ritirata» è uno STATO della card, non un messaggio nel thread.
 *
 * La bonifica delle anteprime false (`scripts/check-preview-evidence.ts --fix`)
 * e il cancello sul contenuto (`server/services/preview-manager.ts`) hanno
 * scritto una nota nel thread di 23 card: «⚠️ Anteprima RITIRATA…». Un messaggio
 * però non invecchia e non si corregge — su 3 di quelle card l'anteprima è
 * tornata e la nota continua a dire il contrario.
 *
 * Il fatto vive ora sulla card (`tasks.preview_retired_at/reason`, migration
 * `20260812120000`). Questo modulo è l'altra metà: riconoscere le note già
 * SCRITTE, perché per quelle non esiste nessuna colonna scritta al momento
 * giusto. Non si cancella niente dal DB — la storia resta; si smette di
 * MOSTRARE una nota quando quello che afferma non è più vero.
 */

import { isDeliverySheetPath } from "./media-kind";

/**
 * Le note che affermano «questa card NON ha un'anteprima».
 *
 * Solo queste due: `⚠️ output_url rimosso…` parla dell'anteprima VIVA (il
 * server sulla porta), che può restare morta anche quando l'immagine torna —
 * nasconderla sarebbe nascondere un fatto ancora vero.
 */
const RETIREMENT_NOTE_PATTERNS: RegExp[] = [
  /^⚠️\s*Anteprima RITIRATA\b/,
  /^⚠️\s*Nessuna anteprima allegata\b/,
];

/** Il testo con cui la bonifica marca lo stato sulla card (migration + script). */
export const DUPLICATE_EVIDENCE_REASON =
  "l'immagine era byte per byte identica a quella di altre card: non era evidenza di questo lavoro";

/**
 * Vero se il commento è una nota di ritiro dell'anteprima.
 *
 * Il riconoscimento è sul TESTO ancorato all'inizio, non sul `kind`: le 23 note
 * già scritte sono `review-note`, ma un `kind` giusto non è la cosa che rende
 * falsa la nota — lo è quello che afferma. L'ancora `^` è la guardia vera: un
 * commento umano che CITA la nota la porta dentro la frase, non in testa.
 */
export function isPreviewRetirementNote(c: { content: string; kind?: string | null }): boolean {
  const text = c.content.trim();
  return RETIREMENT_NOTE_PATTERNS.some((re) => re.test(text));
}

/**
 * La nota è SUPERATA: dice che non c'è anteprima, ma la card ce l'ha.
 *
 * Il verso non è ambiguo — la nota viene scritta nello stesso gesto che azzera
 * l'anteprima, quindi un'immagine presente adesso è per forza arrivata DOPO.
 */
export function isSupersededPreviewNote(
  c: { content: string; kind?: string | null },
  task: { previewImage?: string | null },
): boolean {
  // Una SCHEDA DI CONSEGNA non supera la nota: e' il ripiego disegnato dal
  // server, e quello che la nota afferma (l'evidenza vera non c'e') resta vero.
  const preview = (task.previewImage ?? "").trim();
  const hasPreview = !!preview && !isDeliverySheetPath(preview);
  return hasPreview && isPreviewRetirementNote(c);
}
