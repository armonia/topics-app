/**
 * Il banner: le stesse statistiche, in un'immagine che si può incollare fuori.
 *
 * ── PERCHÉ SVG E PERCHÉ SENZA NIENTE DENTRO ────────────────────────────────
 * Il posto in cui finisce è il README di un profilo GitHub, cioè un contesto
 * ostile: GitHub serve le immagini dei README dal suo proxy (Camo), che
 * RISCRIVE l'URL e scarica il file una volta sola per cache. Quindi il banner
 * deve essere un file completo — niente `<image href>` esterni, niente
 * `@font-face`, niente CSS che arrivi da un'altra richiesta: tutto ciò che non
 * è dentro questo SVG, là fuori non esiste. I font sono famiglie di sistema con
 * ripiego generico, per lo stesso motivo.
 *
 * ── L'ESCAPING NON È UNA CORTESIA ──────────────────────────────────────────
 * Un nome con una `&` — o un nome messo lì apposta — dentro un SVG non
 * escapato produce un documento malformato che il browser rifiuta, e nel caso
 * cattivo un `<script>`. Qui dentro passa un solo dato di testo libero (il
 * nome), e passa da `esc()`. Il test prova entrambe le cose.
 *
 * ── I NUMERI SI ABBREVIANO, IL COSTO NO ────────────────────────────────────
 * `9.629.422.233 token` non si legge; `9.6B` sì. Il costo invece resta per
 * esteso a due decimali: è l'unico numero della card che qualcuno potrebbe
 * confrontare con un estratto conto.
 */

import type { ProfileStats } from "./profile-stats";

export interface BannerOptions {
  /** Il nome mostrato in cima. Testo libero: è l'unico, e va escapato. */
  name?: string | null;
  /** `dark` (default) o `light`: il README di GitHub ha due temi, e chi ne
   *  serve uno solo ha un banner che sparisce a metà dei visitatori. */
  theme?: "dark" | "light";
  /** Titolo sopra il nome. */
  subtitle?: string | null;
}

const TEMI = {
  dark: {
    bg: "#0d1117",
    card: "#161b22",
    border: "#30363d",
    text: "#e6edf3",
    muted: "#8b949e",
    accent: "#7c8cff",
    spark: "#7c8cff",
    sparkFill: "#7c8cff22",
  },
  light: {
    bg: "#ffffff",
    card: "#f6f8fa",
    border: "#d0d7de",
    text: "#1f2328",
    muted: "#59636e",
    accent: "#4b56c4",
    spark: "#4b56c4",
    sparkFill: "#4b56c422",
  },
} as const;

/** I cinque caratteri che rompono un documento XML. `&` per primo, o si
 *  ri-escaperebbero le entità appena scritte. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 9.629.422.233 → `9.6B`. Sotto il migliaio si scrive per intero: «0.9K» è
 *  più lungo e meno chiaro di «912». */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
}

/**
 * Lo sparkline dei 30 giorni.
 *
 * Con tutti i giorni a zero non si disegna NIENTE: una linea piatta in fondo
 * al riquadro si legge come «zero costante», che è vero, ma una linea piatta a
 * metà — quella che uscirebbe da una normalizzazione su un massimo zero —
 * direbbe una costanza inventata. Meglio il riquadro vuoto.
 */
export function sparkPath(
  serie: ReadonlyArray<{ tokens: number }>,
  w: number,
  h: number,
): { line: string; area: string } | null {
  if (serie.length < 2) return null;
  const max = Math.max(...serie.map((p) => p.tokens));
  if (max <= 0) return null;
  const dx = w / (serie.length - 1);
  const punti = serie.map((p, i) => {
    const x = i * dx;
    const y = h - (p.tokens / max) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return {
    line: `M${punti.join(" L")}`,
    area: `M0,${h} L${punti.join(" L")} L${w},${h} Z`,
  };
}

interface Cella {
  label: string;
  value: string;
  hint?: string;
}

/** Cosa merita un riquadro. Cinque, non nove: una card con nove numeri non si
 *  legge, si scorre. */
function celle(s: ProfileStats): Cella[] {
  return [
    { label: "sessions", value: compact(s.sessions.total), hint: `${compact(s.sessions.open)} open` },
    { label: "tasks done", value: compact(s.tasks.done), hint: `${compact(s.tasks.total)} total` },
    { label: "tokens", value: compact(s.tokens.total), hint: "cache included" },
    { label: "agent hours", value: compact(Math.round(s.agentHours)), hint: `${compact(s.activity.activeDays)} active days` },
    { label: "projects", value: compact(s.projects), hint: s.activity.streakDays > 0 ? `${s.activity.streakDays}d streak` : "-" },
  ];
}

const W = 860;
const H = 200;

/** Il banner completo, come stringa SVG. Nessuna I/O: si prova confrontando
 *  testo. */
export function renderBanner(stats: ProfileStats, opts: BannerOptions = {}): string {
  const t = TEMI[opts.theme === "light" ? "light" : "dark"];
  const nome = esc((opts.name ?? "Topics").slice(0, 48));
  const sub = esc((opts.subtitle ?? "Coding agents, organised").slice(0, 64));
  const c = celle(stats);

  const padX = 24;
  const cellW = (W - padX * 2) / c.length;
  const riquadri = c
    .map((cella, i) => {
      const x = padX + i * cellW;
      return [
        `<text x="${(x + 2).toFixed(1)}" y="112" fill="${t.text}" font-size="26" font-weight="600">${esc(cella.value)}</text>`,
        `<text x="${(x + 2).toFixed(1)}" y="130" fill="${t.muted}" font-size="11" letter-spacing="0.6">${esc(cella.label.toUpperCase())}</text>`,
        cella.hint
          ? `<text x="${(x + 2).toFixed(1)}" y="146" fill="${t.muted}" font-size="10" opacity="0.75">${esc(cella.hint)}</text>`
          : "",
      ].join("");
    })
    .join("");

  const spark = sparkPath(stats.activity.last30, W - padX * 2, 30);
  const sparkSvg = spark
    ? `<g transform="translate(${padX},156)">
      <path d="${spark.area}" fill="${t.sparkFill}"/>
      <path d="${spark.line}" fill="none" stroke="${t.spark}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    </g>`
    : "";

  const costo = stats.cost.measuredUsd > 0
    ? `$${stats.cost.measuredUsd.toFixed(2)}${stats.cost.uncertainRows > 0 ? "+" : ""} measured spend`
    : "self-hosted";

  // `role="img"` + `<title>` perché un banner senza testo alternativo, in un
  // README, per un lettore di schermo è una riga vuota.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
  <title id="t">${nome} · Topics stats</title>
  <desc id="d">${esc(`${compact(stats.sessions.total)} sessions, ${compact(stats.tasks.done)} tasks done, ${compact(stats.tokens.total)} tokens`)}</desc>
  <rect width="${W}" height="${H}" rx="12" fill="${t.bg}"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.card}" stroke="${t.border}"/>
  <g font-family="ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
    <text x="${padX}" y="44" fill="${t.text}" font-size="20" font-weight="700">${nome}</text>
    <text x="${padX}" y="64" fill="${t.muted}" font-size="12">${sub}</text>
    <text x="${W - padX}" y="44" fill="${t.accent}" font-size="12" font-weight="600" text-anchor="end">TOPICS</text>
    <text x="${W - padX}" y="64" fill="${t.muted}" font-size="11" text-anchor="end">${esc(costo)}</text>
    <line x1="${padX}" y1="78" x2="${W - padX}" y2="78" stroke="${t.border}"/>
    ${riquadri}
    ${sparkSvg}
    <text x="${W - padX}" y="${H - 12}" fill="${t.muted}" font-size="10" text-anchor="end" opacity="0.8">last 30 days</text>
  </g>
</svg>`;
}
