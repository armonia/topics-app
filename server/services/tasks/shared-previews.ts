/**
 * Delivery-preview bookkeeping: what counts as evidence, the sheet, duplicates and the carousel images.
 */

import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { PREVIEW_CARD_MAX_RATIO } from "../../../shared/board";
import { imageShape } from "../image-shape";
import { isDeliverySheetPath, isAutoCapturedPreview } from "../../../shared/media-kind";
import { renderDeliverySheet } from "../delivery-sheet";
import { createHash } from "node:crypto";
import { sliceCodePoints } from "../../lib/code-points";
import type { SharedCore } from "./shared-core";
import type { SharedCardRead } from "./shared-card-read";

export type SharedPreviews = ReturnType<typeof createSharedPreviews>;

export function createSharedPreviews(db: Database, { fileExists, getTaskRow, lastWordOfThread, now, reviewNote, writeDeliverySheet }: SharedCore, { DESCRIPTION_PREVIEW_CHARS }: SharedCardRead) {


// ── Review-evidence promotion ──
// The delivery protocol asks agents for update_task(previewImage=…), but in
// practice they attach the evidence to the delivery COMMENT and the board
// card stays blind (3 out of 3 first real dispatches). Same philosophy as
// the dispatcher's mirrored delivery comment: the server GUARANTEES the
// outcome instead of relying on agent discipline. When a task is in review
// with no preview, promote the newest previewable comment attachment
// (image/video, absolute path, existing on disk) to `preview_image`.
// Idempotent and best-effort: an explicit previewImage always wins (we only
// fill the empty case), and any failure just leaves the card without
// preview — exactly the status quo.
//
// `svg` è in lista dal 10/08: il protocollo (`PREVIEW_RULE`) ha un terzo ramo
// — DIAGRAMMA — per le consegne senza superficie renderizzata (un piano,
// un'architettura, una migrazione), e senza l'estensione qui quel ramo
// nasceva morto: l'agente allegava il diagramma al commento di consegna e la
// promozione lo saltava, lasciando la card cieca.
const PREVIEWABLE_MEDIA = /\.(png|jpe?g|gif|webp|svg|webm|mp4|mov)$/i;


/**
   * The paths this card's retirement has already REJECTED.
   *
   * It lives in a column and not in memory because the question comes back
   * after a restart, and that is exactly where it did damage:
   * `sweepReviewPreviews` fished the just-retired shot back out of the thread.
   * The column is a JSON array; an unreadable row counts as "nothing
   * rejected", which is the previous behaviour and never loses real evidence.
   */
  const rejectedPaths = (raw: string | null | undefined): string[] => {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch { return []; }
  };


/** Quante evidenze al massimo finiscono nel carosello della card. Oltre, non
   *  e' piu' un carosello ma un archivio, e quello e' il thread nel drawer. */
  const PREVIEW_SLIDES_MAX = 8;


const VIDEO_MEDIA = /\.(webm|mp4|mov)$/i;


/**
   * Gate di FORMA — non un quarto cancello di review.
   *
   * Un'immagine molto più alta che larga, nel riquadro `object-cover` della
   * card, non si rimpicciolisce: si taglia. Promuoverla mette sulla board la
   * fascia alta di un documento e fa sembrare consegnata un'evidenza che
   * nessuno può leggere — è così che la card di un PIANO ha finito per mostrare
   * la fotografia del piano stesso.
   *
   * Quindi la promozione si ferma e lascia una nota. Si FERMA LA PROMOZIONE,
   * non la consegna: il task resta in review, l'allegato resta nel thread, e
   * l'agente legge nella nota quale ramo del protocollo era quello giusto. Un
   * rifiuto qui non deve mai costare un giro di dispatch.
   *
   * La soglia è `PREVIEW_CARD_MAX_RATIO`, la STESSA della card. Erano due (0.7
   * qui, 0.537 là) perché il tetto della card era un'altezza fissa e quindi un
   * rapporto ballerino: si promuoveva col numero largo ciò che poi la card
   * tagliava col numero stretto. Ora la card ha un tetto proporzionale, quindi
   * il gate dice esattamente «la card taglierebbe questa» — un numero solo per
   * la stessa immagine. Forma non misurabile (video, formato esotico, file
   * illeggibile) ⇒ si promuove: vedi `imageShape`.
   */
  function tooTallForCard(path: string): { ratio: number; width: number; height: number } | null {
    if (VIDEO_MEDIA.test(path)) return null;
    const shape = imageShape(path);
    if (!shape) return null;
    return shape.ratio > PREVIEW_CARD_MAX_RATIO ? shape : null;
  }


/**
   * L'ULTIMO RAMO, quello che non puo' fallire: se la card non ha evidenza, la
   * si DISEGNA con i fatti che stanno gia' in colonna (ramo, file, lines,
   * passi, etichette).
   *
   * Idempotente: si rigenera solo sopra il vuoto o sopra una scheda precedente,
   * mai sopra l'evidenza di qualcuno. Best-effort come tutto quello che sta
   * attorno: senza `writeDeliverySheet` iniettata (test, host minimi) non fa
   * niente e la card resta com'era.
   */
  function ensureDeliverySheet(taskId: string): void {
    if (!writeDeliverySheet) return;
    try {
      const row = getTaskRow(taskId) as {
        status?: string;
        text?: string | null;
        preview_image?: string | null;
        delivery_branch?: string | null;
        delivery_files_changed?: number | null;
        delivery_insertions?: number | null;
        delivery_deletions?: number | null;
        delivery_uncommitted_files?: number | null;
      } | undefined;
      if (!row || row.status !== "review") return;
      const attuale = (row.preview_image ?? "").trim();
      if (attuale && !isDeliverySheetPath(attuale)) return;
      const figli = db.prepare(
        "SELECT status FROM tasks WHERE parent_task_id = ? AND COALESCE(archived, 0) = 0",
      ).all(taskId) as Array<{ status: string }>;
      const labels = (db.prepare(
        "SELECT label FROM task_labels WHERE task_id = ? ORDER BY label",
      ).all(taskId) as Array<{ label: string }>).map((r) => r.label);
      const svg = renderDeliverySheet({
        taskId,
        title: row.text ?? "",
        branch: row.delivery_branch ?? null,
        filesChanged: row.delivery_files_changed ?? null,
        insertions: row.delivery_insertions ?? null,
        deletions: row.delivery_deletions ?? null,
        // The work that is NOT on a commit: without this number the sheet has
        // one sentence for two opposite situations (nothing to hand over, and a
        // delivery left behind in the worktree), and the reviewer picks blind.
        uncommittedFiles: row.delivery_uncommitted_files ?? null,
        subtasksTotal: figli.length,
        subtasksDone: figli.filter((f) => f.status === "done").length,
        labels,
        // COSA E' STATO FATTO, quando non ci sono numeri da mostrare.
        //
        // La stessa riga che la card disegna sopra il titolo: l'ultima parola
        // vera del thread, saltando cronologia e contabilita' (`status` e
        // `service` non sono parole di nessuno). Senza, il ramo senza codice
        // scriveva «Nessun codice consegnato» — un'assenza al posto di
        // un'informazione, sul 60% della larghezza della scheda.
        summary: lastWordOfThread(taskId),
      });
      const path = writeDeliverySheet(taskId, svg);
      if (!path) return;
      // Il ritiro NON si spegne qui: una scheda non e' l'evidenza nuova che
      // supera un ritiro, e' il ripiego che tiene la card leggibile intanto.
      db.prepare("UPDATE tasks SET preview_image = ?, updated_at = ? WHERE id = ?")
        .run(path, now(), taskId);
    } catch { /* best-effort: senza scheda la card torna com'era, vuota */ }
  }


function promoteReviewPreview(taskId: string): void {
    try {
      const row = getTaskRow(taskId);
      if (!row || row.status !== "review") return;
      // Una SCHEDA vale come riquadro vuoto: e' il ripiego che abbiamo disegnato
      // noi, quindi la prima evidenza vera deve poterla sostituire. Qualunque
      // altra anteprima, invece, e' di qualcuno e non si tocca.
      const attuale = (row.preview_image ?? "").trim();
      if (attuale && !isDeliverySheetPath(attuale)) return;
      // WHAT WAS REJECTED DOES NOT COME BACK. The retired image stays attached
      // to the comment that carried it, which is precisely where we fish below:
      // without this line the startup sweep put the just-rejected shot back on
      // the card, and turned the retirement off while doing it.
      const alreadyRejected = rejectedPaths(row.preview_rejected);
      const rows = db.prepare(
        "SELECT media FROM task_comments WHERE task_id = ? AND media IS NOT NULL ORDER BY created_at DESC LIMIT 10",
      ).all(taskId) as Array<{ media: string }>;
      const rejected: Array<{ path: string; shape: { ratio: number; width: number; height: number } }> = [];
      for (const r of rows) {
        let files: unknown;
        try { files = JSON.parse(r.media); } catch { continue; }
        if (!Array.isArray(files)) continue;
        for (const f of files) {
          if (typeof f !== "string" || !f.startsWith("/") || !PREVIEWABLE_MEDIA.test(f)) continue;
          if (alreadyRejected.includes(f)) continue;
          if (!fileExists(f)) continue;
          const tall = tooTallForCard(f);
          if (tall) { rejected.push({ path: f, shape: tall }); continue; }
          // Anche l'adozione automatica supera il ritiro: la card ha di nuovo
          // un'evidenza, quindi il fatto «ritirata» ha smesso di valere.
          // A DUPLICATE AUTO SHOT IS EVIDENCE OF NOTHING, so it is refused
          // instead of merely noted. The note stays a note for an image a
          // PERSON attached: two cards on the same panel really can share one,
          // which is why this was never a block. An automatic capture is a
          // different animal - byte-identical to another card's means the app
          // was in the same state, and that says nothing about THIS delivery.
          // Measured 2026-09-01: task 1f225c0f carried the very screenshot of
          // 1c8fd103 (md5 f8a398c6), the machine wrote the note, and then used
          // the image anyway. Reported: «si vede solo uno screen a cazzo».
          // allow-italian: the words that reported it, quoted.
          const isDuplicate = noteDuplicatePreview(taskId, f);
          if (isDuplicate && isAutoCapturedPreview(f)) continue;
          db.prepare(
            "UPDATE tasks SET preview_image = ?, preview_retired_at = NULL, preview_retired_reason = NULL, updated_at = ? WHERE id = ?",
          ).run(f, now(), taskId);
          return;
        }
      }
      // Nessun candidato da promuovere. Il riquadro NON resta vuoto: il vuoto
      // valeva come segnale finche' era raro, e il 20/08 era 9 card su 16.
      // Vedi `services/delivery-sheet.ts` per il perche' e per l'onesta' della
      // scheda (dichiaratamente disegnata, sostituita dalla prima evidenza
      // vera). Le istruzioni su come allegare l'evidenza restano nell'envelope
      // dell'agente (PREVIEW_RULE), non nel thread di chi decide.
      ensureDeliverySheet(taskId);
      if (!rejected.length && !rows.some((r) => (r.media ?? "").trim())) {
        return;
      }
      // Nessun candidato promosso ma qualcuno scartato per forma: la card
      // resterebbe cieca senza che nessuno sappia perché.
      if (rejected.length) {
        const { path, shape } = rejected[0]!;
        reviewNote(
          taskId,
          `Anteprima non promossa: \`${baseName(path)}\` è ${shape.width}×${shape.height}, altezza/larghezza ${shape.ratio.toFixed(2)} (soglia ${PREVIEW_CARD_MAX_RATIO}). ` +
            "Sulla card se ne vedrebbe solo la fascia alta. La consegna resta in review e l'allegato resta nel thread: " +
            "se il lavoro non ha una superficie renderizzata il ramo giusto è un DIAGRAMMA `.svg` (la struttura, non la foto del documento); " +
            "se è UI, ricattura a viewport ≤1440×900. Poi `update_task(preview_image=…)`.",
        );
      }
    } catch { /* best-effort — the card just stays without a preview */ }
  }


/**
   * SEGNALE, mai blocco: l'anteprima appena messa è byte per byte quella di un
   * altro task.
   *
   * Nel rilievo che ha aperto questo lavoro c'erano 16 PNG identici da 10.191
   * byte sparsi su altrettante card — lo stesso screenshot riciclato, cioè
   * consegne senza evidenza propria. Ma alcuni di quei duplicati sono legittimi
   * (due task sullo stesso pannello, uno stato vuoto che è davvero identico):
   * un blocco farebbe strage di consegne buone. Quindi si scrive una nota e si
   * lascia decidere a chi legge.
   */
  /**
   * The other card carrying THE SAME IMAGE, byte for byte, or null.
   *
   * Pure on purpose: the adoption path wants to write a note about it, the
   * review sweep only wants to ask. Asking used to mean writing, so the sweep
   * could not use it without dripping the same note into the thread every pass.
   */
  function duplicatePreviewOf(taskId: string, path: string): { id: string; text: string; path: string } | null {
    try {
      const mine = fileDigest(path);
      if (!mine) return null;
      const others = db.prepare(
        "SELECT id, text, preview_image FROM tasks WHERE preview_image IS NOT NULL AND preview_image != '' AND id != ? ORDER BY updated_at DESC LIMIT 200",
      ).all(taskId) as Array<{ id: string; text: string; preview_image: string }>;
      for (const o of others) {
        if (o.preview_image === path) continue; // stesso file, non un duplicato di contenuto
        if (fileDigest(o.preview_image) !== mine) continue;
        return { id: o.id, text: o.text ?? "", path: o.preview_image };
      }
    } catch { /* best-effort: the signal is an extra, not an invariant */ }
    return null;
  }


function noteDuplicatePreview(taskId: string, path: string): boolean {
    const other = duplicatePreviewOf(taskId, path);
    if (!other) return false;
    try {
      const mine = fileDigest(path) ?? "";
      {
        const o = other;
        reviewNote(
          taskId,
          `Anteprima IDENTICA (md5 \`${mine.slice(0, 8)}\`) a quella del task \`${o.id}\`, «${o.text.slice(0, 60)}». ` +
            "Non è un blocco: due task sullo stesso pannello possono avere davvero la stessa immagine. " +
            "Ma se è una svista, questa consegna non ha ancora un'evidenza sua.",
        );
      }
    } catch { /* best-effort: il segnale è un extra, non un invariante */ }
    return true;
  }


/** md5 del file, con cache su (path, size, mtime): la scansione dei duplicati
   *  rilegge le stesse anteprime a ogni consegna. `null` se non si può leggere. */
  const digestCache = new Map<string, { key: string; md5: string }>();


function fileDigest(path: string): string | null {
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size === 0 || st.size > 16 * 1024 * 1024) return null;
      const key = `${st.size}:${st.mtimeMs}`;
      const hit = digestCache.get(path);
      if (hit && hit.key === key) return hit.md5;
      const md5 = createHash("md5").update(readFileSync(path)).digest("hex");
      digestCache.set(path, { key, md5 });
      return md5;
    } catch { return null; }
  }


function baseName(p: string): string { return p.slice(p.lastIndexOf("/") + 1); }


/**
   * L'anteprima parte da dove comincia la SOSTANZA, non dal preambolo.
   *
   * Segnalato guardando una card: «anche la descrizione non ha senso». Su
   * `235afe11` i 240 caratteri dell'anteprima erano cosi':
   *
   *     «Potremmo fare una roba molto figa per poter assicurarci che il nostro
   *      browser ide sia effettivamente perfetto e interessante.
   *      - Omologare la cronologia delle tab di navigazione con la cronologia
   *        delle tab normali.
   *      - Metterlo anche come menu»
   *
   * Meta' dello spazio bruciata da una frase che non dice niente, e il secondo
   * punto elenco tagliato a meta'. La sostanza — cosa c'e' da fare — comincia
   * al primo trattino.
   *
   * Quindi: se il testo ha un ELENCO, l'anteprima parte da li'. E' un taglio
   * strutturale, non un giudizio sul contenuto: non si decide che una frase e'
   * inutile, si osserva che chi ha scritto ha messo i punti sotto un cappello,
   * e che i punti sono la parte che si legge.
   *
   * Il preambolo non si perde: il drawer mostra la descrizione INTERA. Qui si
   * sceglie solo da dove far partire i 240 caratteri che stanno sulla card.
   */
  function anteprimaUtile(testo: string): string {
    const t = testo.trimStart();
    // Il primo punto elenco, se comincia una RIGA (non un trattino in mezzo a
    // una frase) e se ha del testo sopra: senza cappello non c'e' niente da
    // saltare, e partire dal secondo punto perderebbe il primo.
    const m = t.match(/\n\s*(?:[-*•]\s+|\d+[.)]\s+)/);
    if (!m || m.index === undefined) return t;
    const cappello = t.slice(0, m.index).trim();
    // Un cappello CORTO e' gia' il punto, non un preambolo: «Tre cose da fare:»
    // vale piu' del primo elenco. Si salta solo cio' che e' lungo abbastanza da
    // mangiarsi l'anteprima.
    if (cappello.length < 80) return t;
    return t.slice(m.index).trimStart();
  }


/**
   * Il taglio dell'anteprima sui percorsi a riga singola, CON LA STESSA UNITÀ
   * dell'altro.
   *
   * `substr` di SQLite conta CARATTERI, `String.slice` conta unità UTF-16: su
   * un'emoji (o su qualunque carattere fuori dal piano base) le due porte
   * tagliavano in due punti diversi, e la stessa card mostrava due anteprime a
   * seconda che arrivasse dalla lista o da una scrittura ribaltata sul WS.
   * `Array.from` itera per punti di codice, che è l'unità di `substr`.
   */
  const previewOf = (s: string): string =>
    sliceCodePoints(anteprimaUtile(s), DESCRIPTION_PREVIEW_CHARS);


/**
   * LE ALTRE EVIDENZE di ogni card: i media allegati nel thread.
   *
   * A COSA SERVE. `preview_image` e' UNA sola — la copertina che il server ha
   * scelto — e finora il resto restava sepolto nel thread. Ma un agente che
   * consegna un lavoro visivo allega spesso piu' scatti (prima/dopo, tre
   * schermate di un flusso), e chi guarda la board li vedeva solo aprendo il
   * task e scorrendo i commenti. Segnalato: «assicuriamoci che la preview possa
   * avere anche piu' slide navigabili».
   *
   * UNA QUERY PER PAGINA, non una per card: stesso motivo per cui i commenti
   * passano da `cardCommentsFor`. Il tetto per card esiste perche' un thread
   * lungo puo' avere decine di allegati, e un carosello da trenta slide non e'
   * un carosello: e' un archivio, e quello sta nel drawer.
   */
  function previewImagesFor(ids: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    /* REJECTED evidence stays out of the carousel. `retirePreview` removes the
     * cover, but the slides are fished from those same attachments: without
     * this read the retired shot stayed visible next to the good one, so the
     * card kept showing exactly what the retirement had declared false. One
     * query, like the media above. */
    const rejectedByTask = new Map<string, string[]>();
    try {
      const rr = db.query(
        `SELECT id, preview_rejected FROM tasks
          WHERE id IN (SELECT value FROM json_each(?)) AND preview_rejected IS NOT NULL`,
      ).all(JSON.stringify(ids)) as Array<{ id: string; preview_rejected: string | null }>;
      for (const r of rr) rejectedByTask.set(r.id, rejectedPaths(r.preview_rejected));
    } catch { /* column missing (old db): nothing rejected, as before */ }
    /* Il tipo della riga e' DICHIARATO, non `any`: sono due colonne, si
     * scrivono. Il cricchetto sugli `any` (`check:any-budget`) mi ha preso
     * proprio qui, e aveva ragione — `r.media` su un `any` non avrebbe detto
     * niente se un domani la colonna cambiasse nome. */
    let rows: Array<{ task_id: string; media: string | null }>;
    try {
      rows = db.query(
        `SELECT task_id, media FROM task_comments
          WHERE task_id IN (SELECT value FROM json_each(?)) AND media IS NOT NULL
          ORDER BY created_at ASC`,
      ).all(JSON.stringify(ids)) as Array<{ task_id: string; media: string | null }>;
    } catch { return out; }
    for (const r of rows) {
      if (!r.media) continue;
      let files: unknown;
      try { files = JSON.parse(r.media); } catch { continue; }
      if (!Array.isArray(files)) continue;
      for (const f of files) {
        // Le stesse regole della promozione: path assoluto, estensione che
        // qualcuno sa disegnare. Un `.pdf` fra le slide sarebbe un buco.
        if (typeof f !== "string" || !f.startsWith("/") || !PREVIEWABLE_MEDIA.test(f)) continue;
        if (rejectedByTask.get(r.task_id)?.includes(f)) continue;
        const list = out.get(r.task_id);
        if (!list) { out.set(r.task_id, [f]); continue; }
        if (list.length >= PREVIEW_SLIDES_MAX) continue;
        if (!list.includes(f)) list.push(f);
      }
    }
    return out;
  }
  return {
    PREVIEWABLE_MEDIA,
    PREVIEW_SLIDES_MAX,
    VIDEO_MEDIA,
    anteprimaUtile,
    baseName,
    digestCache,
    duplicatePreviewOf,
    ensureDeliverySheet,
    fileDigest,
    noteDuplicatePreview,
    previewImagesFor,
    previewOf,
    promoteReviewPreview,
    rejectedPaths,
    tooTallForCard,
  };
}
