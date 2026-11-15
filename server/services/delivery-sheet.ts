/**
 * THE DELIVERY SHEET: the preview that is ALWAYS there.
 *
 * The finding (2026-08-20): 9 review cards out of 16 showed nothing in the
 * preview frame. None of the 9 had an attachment in the thread, so the
 * automatic promotion (`promoteReviewPreview`) had nothing to promote; and the
 * live preview was never born because the worktree serves a 503 "Bundle not
 * built yet", which the CONTENT gate rightly refuses to photograph. The review
 * column was a list of empty rectangles, and whoever looked at the board kept
 * asking the same thing: "what was done here?".
 *
 * The choice: the empty frame was deliberate, "an honest silence". But silence
 * is a signal only when it is rare, and at 9 cards out of 16 it signalled
 * nothing. So the last branch of the protocol (a DIAGRAM, for deliveries with
 * no rendered surface) is drawn by the server itself, from the facts the
 * column already has: branch, touched files, lines added and removed, subtasks.
 *
 * Honesty stays: a sheet must NOT be mistaken for a photograph of the work. It
 * is openly drawn (header "SCHEDA DI CONSEGNA", a note at the bottom), never
 * looks like a screenshot, and is replaced as soon as real evidence arrives
 * (explicit previewImage, promotable attachment, live screenshot). Its path
 * makes it recognisable: `.../task-sheets/<id>.svg`.
 *
 * Pure by construction: this only composes SVG text. Whoever writes it to disk
 * is the caller (`writeDeliverySheet`, injected in `tasks.ts`), so this module
 * stays testable without a filesystem.
 */

import { escapeHtml } from "../lib/escape-html";
import { mkdirSync, writeFileSync } from "node:fs";
import { questionToProse } from "../../shared/question-prose";
import { dirname, join } from "node:path";
import { DELIVERY_SHEET_DIR } from "../../shared/media-kind";

/** Il file della scheda per un task, dentro `mediaDir`. */
export function deliverySheetPath(mediaDir: string, taskId: string): string {
  return `${mediaDir.replace(/\/+$/, "")}/${DELIVERY_SHEET_DIR}/${taskId}.svg`;
}

export interface DeliverySheetData {
  taskId: string;
  title: string;
  /** Il ramo consegnato, quando la card ne ha uno. */
  branch?: string | null;
  filesChanged?: number | null;
  insertions?: number | null;
  deletions?: number | null;
  /** Sottotask chiusi / totali: il passo che la card gia' racconta a parole. */
  subtasksDone?: number;
  subtasksTotal?: number;
  /** Etichette della card (kind + chi chiude), massimo tre in figura. */
  labels?: string[];
  /**
   * The last real word in the thread: what was done, said by whoever did it.
   *
   * THIS IS THE BODY OF THE SHEET, no longer the fallback for when the numbers
   * are missing. Until 2026-09-01 the diffstat won: three big figures (files,
   * insertions, deletions) plus the branch name, and the summary showed up only
   * when there was no code. A reviewer does not ask "which files changed", they
   * ask "what is this task, where does it stand, what do I decide" - and a
   * diffstat answers none of that. Reported twice on the same day: "it only
   * talks about the git state and not about what happened", then "not true
   * things but USEFUL things, I do not need git".
   */
  summary?: string | null;
  /**
   * Files changed in the worktree and NEVER committed, counted when the card
   * was delivered. `null` means nobody could measure it, which is not the same
   * as zero and does not print the same sentence.
   *
   * WHY IT IS HERE AT ALL: the three numbers above count commits, so a turn
   * that ended before committing scored zero everywhere and the card read as
   * "this produced nothing". Measured 2026-09-01 on card 1c8fd103: two modified
   * files, +29/-6, no commit, sheet at zero. The reviewer's decision hangs
   * exactly on that difference - one line ("commit it") against a re-dispatch.
   */
  uncommittedFiles?: number | null;
}

const W = 1200;
const H = 720; // rapporto 0.6: sotto la soglia della card (0.70), non viene tagliata


/**
 * Manda a capo su `maxLines` righe da `perLine` caratteri circa. SVG non sa
 * andare a capo da solo e non c'e' un motore di testo qui: si taglia sulle
 * parole, e l'ultima riga finisce con un troncamento visibile invece che con
 * una parola tagliata a meta'.
 */
export function wrapText(text: string, perLine: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length || perLine < 2 || maxLines < 1) return [];
  const lines: string[] = [];
  let cur = "";
  let idx = 0;
  while (idx < words.length && lines.length < maxLines) {
    const raw = words[idx]!;
    const w = raw.length > perLine ? `${raw.slice(0, perLine - 1)}…` : raw;
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= perLine) { cur = next; idx++; continue; }
    lines.push(cur);
    cur = "";
  }
  if (cur && lines.length < maxLines) { lines.push(cur); cur = ""; }
  if (idx < words.length || cur) {
    const last = lines[lines.length - 1] ?? "";
    lines[lines.length - 1] = last.endsWith("…")
      ? last
      : last.length + 1 > perLine ? `${last.slice(0, perLine - 1)}…` : `${last}…`;
  }
  return lines;
}

function num(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Il SVG della scheda. Sempre una stringa valida: se non c'e' un solo dato di
 * consegna, la scheda lo DICE (ed e' comunque piu' informativa del vuoto).
 */
export function renderDeliverySheet(data: DeliverySheetData): string {
  const files = num(data.filesChanged);
  const hasCode = !!(data.branch && files !== null);

  // LE QUOTE, in un posto solo. Il titolo occupa fino a tre righe e la fascia
  // dei numeri comincia SOTTO la sua ultima riga possibile: le etichette
  // stavano a meta' del titolo e ci finivano sopra quando il titolo era lungo.
  const TITLE_Y = 216;
  const TITLE_STEP = 60;
  const RULE_Y = 388;
  const NUM_Y = 484;
  const KEY_Y = 534;
  const BRANCH_Y = 584;
  const CHIP_Y = 616;

  const titleLines = wrapText(data.title || "(senza titolo)", 34, 3);
  const titleSvg = titleLines
    .map((l, i) => `<text x="72" y="${TITLE_Y + i * TITLE_STEP}" class="t">${escapeHtml(l)}</text>`)
    .join("\n    ");

  // WHAT WAS DONE, always - and never the diffstat. See `summary` above.
  const stats = summarySvg(data.summary, NUM_Y, KEY_Y);

  // THE STATE, IN WORDS, where the branch name used to sit. A branch with no
  // commit on it is not "zero files": it is work that has not been handed over
  // yet, and that is a thing to decide about. Said as a sentence, because the
  // number said it in a form that read as "nothing happened".
  //
  // AND THE TWO NON-DELIVERIES ARE NOT ONE. "Nothing was produced" and
  // "produced, never committed" both scored zero here, and they are the two
  // opposite decisions the reviewer has to take: a re-dispatch against one line
  // asking for a commit. When the probe counted uncommitted files, THAT is the
  // sentence: it names work that still exists on disk and can be lost.
  const handedOver = hasCode && (files ?? 0) > 0;
  const dirty = num(data.uncommittedFiles);
  const stateText = !handedOver && dirty !== null && dirty > 0
    ? `Nel worktree ci sono ${dirty} file modificati mai committati: il lavoro c'e', non e' consegnato.`
    : data.branch && !handedOver
      ? "Il ramo non porta ancora nessun commit: il lavoro non e' consegnato."
      : "";
  // CONSTANT TEXT, not data: this file writes both sentences and the only
  // variable part is a number. Running them through `escapeHtml` would turn
  // their apostrophes into `&#39;` while protecting nothing.
  const stateLine = stateText
    ? `<text x="72" y="${BRANCH_Y}" class="k">${stateText}</text>`
    : "";

  const total = data.subtasksTotal ?? 0;
  const passi = total > 0
    ? `<text x="${W - 72}" y="${BRANCH_Y}" class="k" text-anchor="end">Passi chiusi: ${data.subtasksDone ?? 0} di ${total}</text>`
    : "";

  const labels = (data.labels ?? []).filter(Boolean).slice(0, 3);
  const chips = labels
    .map((l, i) => {
      const testo = l.slice(0, 14);
      const larghezza = 40 + testo.length * 14;
      const x = 72 + i * 200;
      return `<rect x="${x}" y="${CHIP_Y - 30}" width="${larghezza}" height="42" rx="21" class="chip"/>` +
        `<text x="${x + 20}" y="${CHIP_Y}" class="chiptext">${escapeHtml(testo)}</text>`;
    })
    .join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
  <style>
    text { font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .h { fill: #6f7787; font-size: 30px; letter-spacing: 6px; }
    .id { fill: #4d5464; font-size: 30px; }
    .t { fill: #eef1f6; font-size: 52px; font-weight: 600; }
    .n { fill: #eef1f6; font-size: 84px; font-weight: 700; }
    .add { fill: #6ee7a8; }
    .del { fill: #f4a2a2; }
    .k { fill: #8b93a3; font-size: 28px; }
    .b { fill: #9fb4ff; font-size: 32px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .chip { fill: #232833; }
    .chiptext { fill: #aab3c4; font-size: 24px; }
    .foot { fill: #5b6273; font-size: 24px; }
  </style>
  <rect width="${W}" height="${H}" fill="#0f1116"/>
  <rect x="18" y="18" width="${W - 36}" height="${H - 36}" rx="28" fill="#171a21" stroke="#272c37" stroke-width="2"/>
  <text x="72" y="110" class="h">SCHEDA DI CONSEGNA</text>
  <text x="${W - 72}" y="110" class="id" text-anchor="end">#${escapeHtml(data.taskId.slice(0, 8))}</text>
  <rect x="72" y="140" width="${W - 144}" height="2" fill="#272c37"/>
  ${titleSvg}
  <rect x="72" y="${RULE_Y}" width="${W - 144}" height="2" fill="#272c37"/>${stats}
  ${stateLine}
  ${chips}
  ${passi}
  <text x="72" y="${H - 52}" class="foot">Disegnata dal server: questa consegna non ha una superficie da fotografare.</text>
</svg>
`;
}

/**
 * Il modo in cui l'host scrive una scheda: sotto `<dati>/media/task-sheets/`,
 * cioe' DENTRO l'allowlist che poi la serve (`isPathAllowed` guarda
 * `${APP_DATA_DIR}/media/`). Scritta altrove, la card mostrerebbe un'immagine
 * rotta: lo stesso inciampo gia' pagato una volta dalle anteprime vive.
 *
 * Torna `null` invece di lanciare: una scheda mancata non deve poter far
 * fallire una consegna.
 */
export function makeSheetWriter(appDataDir: string): (taskId: string, svg: string) => string | null {
  return (taskId, svg) => {
    try {
      const path = deliverySheetPath(join(appDataDir, "media"), taskId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, svg, "utf-8");
      return path;
    } catch {
      return null;
    }
  };
}

/**
 * THE BRANCH WITH NO CODE: what was done, in words.
 *
 * It used to read "no code delivered, the delivery is in the card's thread":
 * an absence plus a redirection, over 60% of the width. Now it tries to write
 * the last word of the thread, the same one the card shows above the title,
 * because that is the only useful thing this space can hold.
 *
 * The fallback stays for when a word is genuinely missing (a turn that died
 * before commenting): there the absence IS the information, and saying so is
 * honest.
 *
 * The two Y values arrive as PARAMETERS and not as module constants: they live
 * in the function that draws the rest of the sheet, and copying them here would
 * mean two numbers to keep aligned by hand, that is a sheet that falls apart at
 * the first tweak of the layout.
 */
function summarySvg(summary: string | null | undefined, NUM_Y: number, KEY_Y: number): string {
  // A QUESTION IS NOT CODE, and the sheet was printing the transport fence.
  // ```question is a wire format read by `parseQuestionBlock`; leaked into the
  // figure it opened the summary with three backticks and a keyword. Same cure
  // the card already uses, from the same shared module - the defect this repo
  // has already paid for once on another surface.
  const testo = questionToProse(summary ?? "").replace(/\s+/g, " ").trim();
  if (!testo) {
    return `
    <text x="72" y="${NUM_Y - 22}" class="b">Nessun riassunto della consegna.</text>
    <text x="72" y="${KEY_Y}" class="k">Il turno e' finito prima che l'agente commentasse.</text>`;
  }
  // Three lines of 62 characters: under the readability threshold at 268px,
  // which is the gate the whole sheet has to pass.
  const righe = wrapText(testo, 62, 3);
  return righe
    .map((l, i) => `<text x="72" y="${NUM_Y - 22 + i * 44}" class="b">${escapeHtml(l)}</text>`)
    .join("\n    ");
}
