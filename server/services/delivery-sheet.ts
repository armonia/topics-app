/**
 * LA SCHEDA DI CONSEGNA: l'anteprima che c'e' SEMPRE.
 *
 * ── Il rilievo (20/08/2026) ────────────────────────────────────────────────
 * 9 card su 16 in review non mostravano nulla nel riquadro dell'anteprima.
 * Nessuna delle 9 aveva un allegato nel thread, quindi la promozione
 * automatica (`promoteReviewPreview`) non aveva niente da promuovere; e
 * l'anteprima viva non nasceva perche' il worktree serve un 503 «Bundle not
 * built yet», che il cancello sul CONTENUTO giustamente rifiuta di fotografare.
 * Risultato: la colonna review era una lista di rettangoli vuoti, e la domanda
 * di chi guarda la board era sempre la stessa: «cos'e' stato fatto qui?».
 *
 * ── La scelta ──────────────────────────────────────────────────────────────
 * Il riquadro vuoto era una scelta: «un silenzio onesto». Ma il silenzio vale
 * come segnale solo se e' raro, e a 9 card su 16 non segnalava piu' niente.
 * Quindi l'ultimo ramo del protocollo (DIAGRAMMA, per le consegne senza
 * superficie renderizzata) lo disegna il server per conto suo, con i fatti che
 * ha gia' in colonna: ramo, file toccati, righe aggiunte e tolte, sottotask.
 *
 * ── L'onesta' resta ────────────────────────────────────────────────────────
 * Una scheda NON deve poter essere scambiata per una fotografia del lavoro:
 * e' dichiaratamente disegnata (intestazione «SCHEDA DI CONSEGNA», nota in
 * fondo), non ha mai l'aria di uno screenshot, e appena arriva un'evidenza vera
 * (previewImage esplicita, allegato promuovibile, screenshot vivo) viene
 * sostituita. Il suo path la rende riconoscibile: `.../task-sheets/<id>.svg`.
 *
 * Puro per costruzione: qui si compone testo SVG e basta. Chi lo scrive su
 * disco e' il chiamante (`writeDeliverySheet` iniettato in `tasks.ts`), cosi'
 * questo modulo resta verificabile senza filesystem.
 */

import { mkdirSync, writeFileSync } from "node:fs";
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
   * L'ultima parola del thread: cosa e' stato fatto, detto da chi l'ha fatto.
   *
   * SERVE AL RAMO SENZA CODICE, ed e' il difetto che ripara. Quando la card non
   * ha numeri di consegna la scheda scriveva «Nessun codice consegnato. La
   * consegna sta nel thread della card»: il 60% della larghezza per dichiarare
   * un'ASSENZA e mandare a leggere altrove. Segnalato: «dovrebbe mettere sempre
   * qualcosa di utile per comprendere».
   *
   * Se il thread una parola ce l'ha, quella parola sta qui invece del rimando.
   */
  summary?: string | null;
}

const W = 1200;
const H = 720; // rapporto 0.6: sotto la soglia della card (0.70), non viene tagliata

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

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
  const ins = num(data.insertions);
  const del = num(data.deletions);
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
    .map((l, i) => `<text x="72" y="${TITLE_Y + i * TITLE_STEP}" class="t">${escapeXml(l)}</text>`)
    .join("\n    ");

  const stats = hasCode
    ? `
    <text x="72" y="${NUM_Y}" class="n">${files}</text>
    <text x="72" y="${KEY_Y}" class="k">file toccati</text>
    <text x="420" y="${NUM_Y}" class="n add">+${ins ?? 0}</text>
    <text x="420" y="${KEY_Y}" class="k">righe aggiunte</text>
    <text x="800" y="${NUM_Y}" class="n del">-${del ?? 0}</text>
    <text x="800" y="${KEY_Y}" class="k">righe tolte</text>
    <text x="72" y="${BRANCH_Y}" class="b">${escapeXml(data.branch ?? "")}</text>`
    : summarySvg(data.summary, NUM_Y, KEY_Y);

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
        `<text x="${x + 20}" y="${CHIP_Y}" class="chiptext">${escapeXml(testo)}</text>`;
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
  <text x="${W - 72}" y="110" class="id" text-anchor="end">#${escapeXml(data.taskId.slice(0, 8))}</text>
  <rect x="72" y="140" width="${W - 144}" height="2" fill="#272c37"/>
  ${titleSvg}
  <rect x="72" y="${RULE_Y}" width="${W - 144}" height="2" fill="#272c37"/>${stats}
  ${chips}
  ${passi}
  <text x="72" y="${H - 52}" class="foot">Disegnata dal server: questa consegna non ha una superficie da fotografare.</text>
</svg>
`;
}

/**
 * Il modo in cui l'host scrive una scheda: sotto `<dati>/media/task-sheets/`,
 * cioe' DENTRO l'allowlist che poi la serve (`isPathAllowed` guarda
 * `${OPENCLAW_DIR}/media/`). Scritta altrove, la card mostrerebbe un'immagine
 * rotta: lo stesso inciampo gia' pagato una volta dalle anteprime vive.
 *
 * Torna `null` invece di lanciare: una scheda mancata non deve poter far
 * fallire una consegna.
 */
export function makeSheetWriter(openclawDir: string): (taskId: string, svg: string) => string | null {
  return (taskId, svg) => {
    try {
      const path = deliverySheetPath(join(openclawDir, "media"), taskId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, svg, "utf-8");
      return path;
    } catch {
      return null;
    }
  };
}

/**
 * Il ramo SENZA codice: cosa e' stato fatto, a parole.
 *
 * Prima diceva «Nessun codice consegnato. La consegna sta nel thread della
 * card»: un'assenza e un rimando, per il 60% della larghezza. Ora prova a
 * scrivere l'ultima parola del thread — la stessa che la card mostra sopra il
 * titolo — perche' e' l'unica cosa utile che qui si possa mettere.
 *
 * Il ripiego resta per il caso in cui una parola non c'e' proprio (turno morto
 * prima di commentare): li' l'assenza E' l'informazione, e dirla e' onesto.
 *
 * Le due Y arrivano come PARAMETRI e non come costanti di modulo: vivono nella
 * funzione che disegna il resto della scheda, e ricopiarne i valori qui
 * significherebbe due numeri da tenere allineati a mano — cioe' una scheda che
 * si scompagina al primo ritocco del layout.
 */
function summarySvg(summary: string | null | undefined, NUM_Y: number, KEY_Y: number): string {
  const testo = (summary ?? "").replace(/\s+/g, " ").trim();
  if (!testo) {
    return `
    <text x="72" y="${NUM_Y - 22}" class="b">Nessun riassunto della consegna.</text>
    <text x="72" y="${KEY_Y}" class="k">Il turno e' finito prima che l'agente commentasse.</text>`;
  }
  // Tre righe da 62 caratteri: sotto la soglia di leggibilita' a 268px, che e'
  // il cancello di tutta la scheda.
  const righe = wrapText(testo, 62, 3);
  return righe
    .map((l, i) => `<text x="72" y="${NUM_Y - 22 + i * 44}" class="b">${escapeXml(l)}</text>`)
    .join("\n    ");
}
