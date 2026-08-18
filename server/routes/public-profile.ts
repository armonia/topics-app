/**
 * Pagina pubblica del profilo — servita senza autenticazione.
 *
 * ── PERCHE' SENZA AUTH ──────────────────────────────────────────────────────
 * Il punto e' condividere le statistiche con chi non ha un account Topics. La
 * pagina si raggiunge via LAN (rete locale) o via relay (se attivo), ed e'
 * identica a quella che vedrebbe chiunque aprisse l'URL. Non c'e' login, non
 * c'e' sessione: il server serve HTML statico con i dati del momento.
 *
 * ── COSA MANCA RISPETTO ALLE IMPOSTAZIONI ───────────────────────────────────
 * La spesa in dollari e' un dato personale. Sul banner SVG la scegli tu ogni
 * volta; su una pagina sempre accesa e' un'altra cosa. Qui compare solo se
 * l'utente ha attivato `profilePublishCost` nelle impostazioni.
 * Il default e' false: la pagina pubblica non mostra mai la spesa di sua
 * iniziativa.
 *
 * ── COME FUNZIONA ───────────────────────────────────────────────────────────
 * HTML reso dal server, senza dipendenze esterne: niente CDN, niente JS del
 * bundle client, niente CSS importato. Tutto l'inline. Funziona anche con JS
 * disabilitato. Si ricarica col solito F5: i dati sono freschi a ogni GET.
 */

import type { AppContext } from "../types";
import { computeProfileStats } from "../services/profile-stats";
import { getAppSettings } from "../services/app-settings";

function compatto(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sparklineSvg(last30: Array<{ date: string; tokens: number }>): string {
  const max = Math.max(0, ...last30.map((p) => p.tokens));
  if (last30.length < 2 || max <= 0) return "";
  const w = 280;
  const h = 40;
  const dx = w / (last30.length - 1);
  const punti = last30.map(
    (p, i) => `${(i * dx).toFixed(1)},${(h - (p.tokens / max) * h).toFixed(1)}`,
  );
  const area = `M0,${h} L${punti.join(" L")} L${w},${h} Z`;
  const line = `M${punti.join(" L")}`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="${w}" height="${h}" style="display:block;width:100%;height:${h}px">
    <path d="${area}" fill="#7c8cff22" />
    <path d="${line}" fill="none" stroke="#7c8cff" stroke-width="1.5" vector-effect="non-scaling-stroke" />
  </svg>`;
}

function cifra(valore: string, etichetta: string, nota?: string): string {
  return `
  <div style="min-width:0">
    <div style="font-size:22px;font-weight:600;color:#e6edf3;font-variant-numeric:tabular-nums;letter-spacing:-0.02em">${esc(valore)}</div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#8b949e;margin-top:2px">${esc(etichetta)}</div>
    ${nota ? `<div style="font-size:10px;color:#6e7681;margin-top:1px">${esc(nota)}</div>` : ""}
  </div>`;
}

export function buildPublicProfilePage(ctx: AppContext): string {
  const stats = computeProfileStats(ctx.db);
  const settings = getAppSettings();
  // La spesa compare SOLO se l'utente ha scelto di mostrarla.
  const mostraCosto = settings.profilePublishCost === true;

  const nome: string | null = (() => {
    try {
      const r = ctx.db.query(
        `SELECT p.display_name AS name
           FROM installation_owners io JOIN people p ON p.id = io.person_id
          ORDER BY io.is_default DESC LIMIT 1`,
      ).get() as { name?: string } | null;
      return r?.name ?? null;
    } catch {
      return null;
    }
  })();

  const da = stats.activity.firstSeen
    ? new Date(stats.activity.firstSeen).toLocaleDateString("it-IT", {
        year: "numeric",
        month: "long",
      })
    : null;

  const spark = sparklineSvg(stats.activity.last30);

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${nome ? esc(nome) + " su Topics" : "Profilo Topics"}</title>
<meta name="description" content="Statistiche d'uso di Topics${nome ? " di " + nome : ""}">
<meta name="robots" content="noindex">
<style>
*,::before,::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;min-height:100dvh;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px 24px;width:100%;max-width:480px}
.header{margin-bottom:20px}
.title{font-size:22px;font-weight:700;color:#e6edf3;line-height:1.2}
.since{font-size:13px;color:#8b949e;margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:16px;margin-bottom:16px}
.divider{border:none;border-top:1px solid #30363d;margin:16px 0}
.spark{margin-bottom:4px}
.meta{font-size:11px;color:#8b949e}
.badge{display:inline-flex;align-items:center;gap:5px;background:#21262d;border:1px solid #30363d;border-radius:6px;padding:4px 10px;font-size:12px;color:#8b949e;text-decoration:none;margin-top:16px}
.badge svg{opacity:.7}
</style>
</head>
<body>
<main class="card">
  <div class="header">
    ${nome ? `<h1 class="title">${esc(nome)}</h1>` : `<h1 class="title">Profilo Topics</h1>`}
    ${da ? `<p class="since">Su Topics da ${esc(da)}</p>` : ""}
  </div>

  <div class="grid">
    ${cifra(compatto(stats.sessions.total), "sessioni", `${compatto(stats.sessions.open)} aperte`)}
    ${cifra(compatto(stats.tasks.done), "task completati", `di ${compatto(stats.tasks.total)}`)}
    ${cifra(compatto(stats.tokens.total), "token", "cache inclusa")}
    ${cifra(compatto(Math.round(stats.agentHours)), "ore agente", `${stats.activity.activeDays} giorni attivi`)}
    ${cifra(compatto(stats.projects), "progetti", stats.activity.streakDays > 0 ? `${stats.activity.streakDays} giorni di fila` : "")}
  </div>

  ${spark ? `<div class="spark">${spark}</div><p class="meta">Attivita' negli ultimi 30 giorni</p>` : ""}

  ${mostraCosto && stats.cost.measuredUsd > 0 ? `
  <hr class="divider">
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <span style="font-size:13px;color:#8b949e">Spesa misurata: <strong style="color:#e6edf3">$${stats.cost.measuredUsd.toFixed(2)}</strong></span>
    ${stats.cost.uncertainRows > 0 ? `<span style="font-size:11px;color:#6e7681">${stats.cost.uncertainRows} righe escluse (pre-cache)</span>` : ""}
  </div>` : ""}

  <a class="badge" href="https://github.com/armonia/topics-app" target="_blank" rel="noopener noreferrer">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    armonia/topics-app
  </a>
</main>
</body>
</html>`;
}

export function createPublicProfileHandler(
  ctx: AppContext,
): (pathname: string, method: string) => Response | null {
  return function publicProfileHandler(pathname: string, method: string): Response | null {
    if (pathname !== "/public/profile") return null;
    if (method !== "GET" && method !== "HEAD") return null;

    try {
      const html = buildPublicProfilePage(ctx);
      return new Response(method === "HEAD" ? null : html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // Dati freschi: i numeri cambiano durante la giornata.
          "Cache-Control": "no-store",
          // La pagina non e' indicizzabile: e' un'URL personale condivisa a scelta.
          "X-Robots-Tag": "noindex",
        },
      });
    } catch (err) {
      console.error("[PublicProfile]", err);
      return new Response("Errore nel calcolo delle statistiche", { status: 500 });
    }
  };
}
