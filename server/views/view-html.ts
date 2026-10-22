/**
 * A view as ONE self-contained HTML document, for hosts that are not Topics
 * (GENUI-08): OpenClaw, Claude, ChatGPT, any MCP Apps host. They render a
 * `ui://` resource in a sandboxed iframe that cannot load the Topics client,
 * so the document carries its own CSS, its own markup and the few lines of
 * the MCP Apps bridge (postMessage JSON-RPC: `ui/initialize`, theme from the
 * host, size reports, links through `ui/open-link`).
 *
 * The data and its rules are the shared ones (`shared/views*.ts`): ranking,
 * grouping, formatting and the words come from the same modules the client
 * components use. Only the drawing is a second implementation, and it is
 * plain on purpose: semantic HTML, a few tokens, no script needed to read it.
 *
 * Every value is escaped here. The spec came from a model: a title is text,
 * never markup.
 */
import { rankMetrics, metricLabelsInOrder, type CompareViewSpec, type ViewSpec } from "../../shared/views";
import { rankColumns, type TableViewSpec } from "../../shared/views-table";
import { groupStepsByDay, type TimelineStep, type TimelineViewSpec } from "../../shared/views-timeline";
import { cellText, formatPrice, formatPriceNote } from "../../shared/views-format";
import { VIEWS_IT } from "../../shared/i18n-views-it";
import { VIEWS_EN } from "../../shared/i18n-views-en";

export type ViewLanguage = "it" | "en";

/** The `ui://` address of the generic app (fed by the tool result) and of one stored view. */
export const VIEW_APP_URI = "ui://topics/view";
export const viewResourceUri = (id: string): string => `${VIEW_APP_URI}/${id}`;
export const MCP_APP_MIME = "text/html;profile=mcp-app";
/** The key of the tool result's `_meta` that carries the drawn view to the generic app. */
export const VIEW_META_KEY = "topics/view";

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function words(language: ViewLanguage): (key: string, vars?: Record<string, string | number>) => string {
  const dict = language === "en" ? VIEWS_EN : VIEWS_IT;
  return (key, vars) => {
    let s = dict[key] ?? VIEWS_IT[key] ?? key;
    for (const [k, v] of Object.entries(vars ?? {})) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}

export interface RenderOpts {
  language?: ViewLanguage;
  /** What an image `src` becomes in the document; undefined drops the image. */
  imageUrl?: (src: string) => string | undefined;
  /** The view's page in Topics, linked at the bottom. */
  pageUrl?: string;
}

type T = ReturnType<typeof words>;

function link(url: string, label: string, cls = "lnk"): string {
  return `<a class="${cls}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} <span aria-hidden="true">↗</span></a>`;
}

function header(spec: { title: string; subtitle?: string; verdict?: string }, t: T): string {
  return `<header><h1>${escapeHtml(spec.title)}</h1>${spec.subtitle ? `<p class="sub">${escapeHtml(spec.subtitle)}</p>` : ""}</header>` +
    (spec.verdict ? `<p class="verdict"><strong>${escapeHtml(t("views.verdict"))}:</strong> ${escapeHtml(spec.verdict)}</p>` : "");
}

function compareBody(spec: CompareViewSpec, t: T, language: ViewLanguage, o: RenderOpts): string {
  const ranks = rankMetrics(spec.options);
  const order = metricLabelsInOrder(spec.options);
  const cards = spec.options.map((opt, i) => {
    const cover = opt.images?.[0];
    const img = cover && o.imageUrl ? o.imageUrl(cover.src) : undefined;
    const metrics = order.map((label) => {
      const m = opt.metrics?.find((x) => x.label === label);
      const rank = ranks[i][label];
      const val = m ? `${escapeHtml(String(m.value))}${m.unit ? ` <small>${escapeHtml(m.unit)}</small>` : ""}` : `<span class="muted">${escapeHtml(t("views.metric.missing"))}</span>`;
      const sr = rank ? `<span class="sr">, ${escapeHtml(t(rank === "best" ? "views.metric.best" : "views.metric.worst"))}</span>` : "";
      return `<div class="m${rank ? ` ${rank}` : ""}"><dt>${escapeHtml(label)}</dt><dd>${val}${sr}</dd></div>`;
    }).join("");
    const points = [
      ...(opt.pros ?? []).map((p) => `<li class="pro"><span class="sr">${escapeHtml(t("views.pro"))}: </span>${escapeHtml(p)}</li>`),
      ...(opt.cons ?? []).map((c) => `<li class="con"><span class="sr">${escapeHtml(t("views.con"))}: </span>${escapeHtml(c)}</li>`),
    ].join("");
    return `<article class="card${opt.recommended ? " rec" : ""}">` +
      (img ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(cover?.caption ?? opt.title)}" loading="lazy">` : "") +
      `<div class="pad">` +
      (opt.recommended ? `<span class="badge">${escapeHtml(t("views.recommended"))}</span>` : "") +
      `<div class="row"><h2>${escapeHtml(opt.title)}</h2>${opt.price ? `<span class="price">${escapeHtml(formatPrice(opt.price.amount, opt.price.currency, language))}</span>` : ""}</div>` +
      (opt.price?.note ? `<p class="note r">${escapeHtml(opt.price.note)}</p>` : "") +
      (opt.subtitle ? `<p class="sub">${escapeHtml(opt.subtitle)}</p>` : "") +
      (metrics ? `<dl class="metrics">${metrics}</dl>` : "") +
      (points ? `<ul class="points">${points}</ul>` : "") +
      (opt.link ? link(opt.link.url, opt.link.label ?? t("views.openLink"), "btn") : "") +
      `</div></article>`;
  }).join("");
  return `<div class="cards">${cards}</div>`;
}

function tableBody(spec: TableViewSpec, t: T, language: ViewLanguage): string {
  const ranks = rankColumns(spec);
  const head = spec.columns.map((c) => `<th scope="col"${c.align === "end" ? ' class="num"' : ""}>${escapeHtml(c.label)}</th>`).join("");
  const rows = spec.rows.map((r, i) => {
    const cells = r.cells.map((v, j) => {
      const col = spec.columns[j];
      const text = cellText(v, col, language);
      const rank = ranks[i][j];
      const inner = text === null
        ? `<span class="muted">${escapeHtml(t("views.metric.missing"))}</span>`
        : `<span${rank === "best" ? ' class="best"' : ""}>${escapeHtml(text)}${rank === "best" ? `<span class="sr">, ${escapeHtml(t("views.metric.best"))}</span>` : ""}</span>`;
      const extra = j === 0
        ? (r.recommended ? `<span class="badge">${escapeHtml(t("views.recommended"))}</span> ` : "")
        : "";
      const tail = j === 0
        ? (r.note ? `<small class="note">${escapeHtml(r.note)}</small>` : "") + (r.link ? `<div>${link(r.link.url, r.link.label ?? t("views.openLink"))}</div>` : "")
        : "";
      const tag = j === 0 ? 'th scope="row"' : "td";
      return `<${tag}${col.align === "end" ? ' class="num"' : ""}>${extra}${inner}${tail}</${tag.split(" ")[0]}>`;
    }).join("");
    return `<tr${r.recommended ? ' class="rec"' : ""}>${cells}</tr>`;
  }).join("");
  return `<div class="scroll" tabindex="0" role="region" aria-label="${escapeHtml(spec.title)}"><table><caption class="sr">${escapeHtml(spec.title)}</caption><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>` +
    (spec.footnote ? `<p class="note">${escapeHtml(spec.footnote)}</p>` : "");
}

function stepFacts(s: { duration?: string; price?: TimelineStep["price"] }, language: ViewLanguage): string[] {
  return [...(s.duration ? [s.duration] : []), ...(s.price ? [formatPriceNote(s.price, language)] : [])];
}

function timelineBody(spec: TimelineViewSpec, t: T, language: ViewLanguage): string {
  return groupStepsByDay(spec.steps).map((g) => {
    const steps = g.steps.map((s) => {
      const facts = stepFacts(s, language);
      const alts = (s.alternatives ?? []).map((a) => {
        const meta = [...stepFacts(a, language), ...(a.detail ? [a.detail] : [])];
        return `<li><span class="muted">${escapeHtml(t("views.timeline.or"))}</span> <strong>${escapeHtml(a.title)}</strong>${meta.length ? ` · ${escapeHtml(meta.join(" · "))}` : ""}</li>`;
      }).join("");
      const kind = s.deadline ? t("views.timeline.deadline") : t(`views.mode.${s.mode ?? "other"}`);
      return `<li class="step${s.deadline ? " deadline" : ""}"><time>${escapeHtml(s.time ?? "")}</time><div>` +
        `<p class="what"><span class="kind">${escapeHtml(kind)}</span> ${escapeHtml(s.title)}</p>` +
        (facts.length ? `<p class="facts">${escapeHtml(facts.join(" · "))}</p>` : "") +
        (s.detail ? `<p>${escapeHtml(s.detail)}</p>` : "") +
        (alts ? `<ul class="alts">${alts}</ul>` : "") +
        (s.link ? link(s.link.url, s.link.label ?? t("views.openLink")) : "") +
        `</div></li>`;
    }).join("");
    return `<section class="day">${g.day ? `<h2>${escapeHtml(g.day)}</h2>` : ""}<ol class="steps">${steps}</ol></section>`;
  }).join("");
}

/** The view's markup, without the document around it: what the generic app injects. */
export function renderViewFragment(spec: ViewSpec, o: RenderOpts = {}): string {
  const language = o.language ?? "it";
  const t = words(language);
  const body = spec.view === "compare" ? compareBody(spec, t, language, o)
    : spec.view === "table" ? tableBody(spec, t, language)
    : timelineBody(spec, t, language);
  const foot = o.pageUrl ? `<footer>${link(o.pageUrl, t("views.page.openInTopics"))}</footer>` : "";
  return `<div class="view" data-view="${spec.view}">${header(spec, t)}${body}${foot}</div>`;
}

const CSS = `
:root{--bg:var(--color-background-primary,#fff);--surface:var(--color-background-secondary,#f5f6f8);--text:var(--color-text-primary,#1b1d21);--muted:var(--color-text-secondary,#555b66);--border:var(--color-border-primary,#dfe2e7);--accent:#0058db;--good-bg:rgba(16,185,129,.14);--good:#065f46;--bad-bg:rgba(239,68,68,.12);--bad:#991b1b;color-scheme:light dark;font-family:var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif)}
:root[data-theme=dark]{--bg:var(--color-background-primary,#17181b);--surface:var(--color-background-secondary,#212328);--text:var(--color-text-primary,#e9eaee);--muted:var(--color-text-secondary,#a6abb4);--border:var(--color-border-primary,#363940);--accent:#7aa7ff;--good:#6ee7b7;--bad:#fca5a5}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:var(--color-background-primary,#17181b);--surface:var(--color-background-secondary,#212328);--text:var(--color-text-primary,#e9eaee);--muted:var(--color-text-secondary,#a6abb4);--border:var(--color-border-primary,#363940);--accent:#7aa7ff;--good:#6ee7b7;--bad:#fca5a5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-size:14px;line-height:1.45}
.view{padding:16px;max-width:72rem;margin:0 auto}h1{font-size:19px;margin:0;line-height:1.25}h2{font-size:15px;margin:0}
p{margin:2px 0}.sub,.muted,.note{color:var(--muted)}.note{font-size:12px}.r{text-align:right}small{font-size:11px}
.verdict{margin:10px 0 14px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.badge{display:inline-block;background:var(--accent);color:#fff;font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;margin-bottom:4px}
:root[data-theme=dark] .badge{color:#0b1220}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:12px}
.card{border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface)}.card.rec{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.card img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}.pad{padding:12px}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:12px}.price{font-weight:700;font-size:17px;font-variant-numeric:tabular-nums}
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0 0}.m{display:flex;flex-direction:column-reverse;padding:5px 8px;border-radius:6px;background:var(--bg)}
.m dt{font-size:11px;color:var(--muted)}.m dd{margin:0;font-weight:700;font-variant-numeric:tabular-nums}.m.best{background:var(--good-bg)}.m.best dd,.m.best dt{color:var(--good)}.m.worst{background:var(--bad-bg)}.m.worst dd,.m.worst dt{color:var(--bad)}
.points{margin:10px 0 0;padding-left:18px}.points li{margin:2px 0}.pro::marker{content:"+ ";color:var(--good)}.con::marker{content:"- ";color:var(--bad)}
.btn{display:inline-flex;align-items:center;gap:4px;min-height:36px;margin-top:10px;padding:0 12px;border:1px solid var(--border);border-radius:6px;color:var(--text);text-decoration:none;font-weight:600}
.lnk{display:inline-flex;align-items:center;gap:4px;min-height:36px;color:var(--accent);font-weight:600;text-decoration:none;margin-right:8px}
.scroll{overflow-x:auto;border:1px solid var(--border);border-radius:10px}table{border-collapse:collapse;width:100%;min-width:34rem}
th,td{padding:8px 12px;text-align:left;vertical-align:top;border-top:1px solid var(--border)}thead th{border-top:0;background:var(--surface);font-size:12px;color:var(--muted)}
.num{text-align:right;font-variant-numeric:tabular-nums}tr.rec{box-shadow:inset 3px 0 0 var(--accent)}th[scope=row] small{display:block;font-weight:400}
.best{background:var(--good-bg);color:var(--good);font-weight:700;border-radius:4px;padding:0 4px}
.day{margin-top:14px}.day h2{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:6px}
.steps{list-style:none;margin:0;padding:0}.step{display:grid;grid-template-columns:3.5rem minmax(0,1fr);gap:10px;padding:0 0 12px;border-left:0}
.step time{font-weight:700;text-align:right;font-variant-numeric:tabular-nums}.step>div{border-left:2px solid var(--border);padding-left:12px}
.what{font-weight:600}.kind{display:inline-block;font-size:11px;font-weight:600;color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:0 5px;margin-right:4px}
.facts{color:var(--muted);font-variant-numeric:tabular-nums}.alts{list-style:none;padding:0;margin:6px 0 0}.alts li{border:1px dashed var(--border);border-radius:6px;padding:3px 8px;margin-top:4px}
.deadline time,.deadline .what{color:var(--bad)}.deadline>div{border-left-color:var(--bad)}
footer{margin-top:16px;padding-top:8px;border-top:1px solid var(--border)}
`;

/**
 * The MCP Apps side of the page, written by hand (no SDK in a sandbox with no
 * network). It does four things: asks the host for its context and adopts its
 * theme and colour variables; reports its size so the host sizes the frame;
 * routes link clicks through `ui/open-link` (a sandboxed frame may not open
 * windows); and, in the generic app, draws the view the tool result carries.
 * Outside an iframe it does nothing and the page reads as a plain document.
 */
const BRIDGE = `(function(){
if(window.parent===window)return;
var seq=0,initId=0,root=document.documentElement;
function post(m){window.parent.postMessage(m,"*")}
function req(method,params){var id=++seq;post({jsonrpc:"2.0",id:id,method:method,params:params});return id}
function note(method,params){post({jsonrpc:"2.0",method:method,params:params})}
function ctx(c){if(!c)return;if(c.theme==="dark"||c.theme==="light")root.setAttribute("data-theme",c.theme);var v=c.styles&&c.styles.variables;if(v)for(var k in v)if(v[k])root.style.setProperty(k,v[k])}
function size(){var r=document.body.getBoundingClientRect();note("ui/notifications/size-changed",{width:Math.ceil(r.width),height:Math.ceil(r.height)})}
window.addEventListener("message",function(e){if(e.source!==window.parent)return;var m=e.data;if(!m||m.jsonrpc!=="2.0")return;
if(m.id===initId&&m.result){ctx(m.result.hostContext);note("ui/notifications/initialized",{});size();return}
if(m.method==="ui/notifications/host-context-changed"){ctx(m.params);return}
if(m.method==="ui/notifications/tool-result"){var v=m.params&&m.params._meta&&m.params._meta["${VIEW_META_KEY}"];var slot=document.getElementById("view");if(v&&typeof v.html==="string"&&slot){slot.innerHTML=v.html;slot.removeAttribute("aria-busy");size()}}});
document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;e.preventDefault();req("ui/open-link",{url:a.href})});
initId=req("ui/initialize",{protocolVersion:"2026-01-26",appInfo:{name:"topics-view",version:"1.0.0"},appCapabilities:{availableDisplayModes:["inline"]}});
if(window.ResizeObserver)new ResizeObserver(size).observe(document.body);
})();`;

export function documentOf(title: string, language: ViewLanguage, inner: string): string {
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main id="view">${inner}</main><script>${BRIDGE}</script></body></html>`;
}

/** One stored view as a whole document (`ui://topics/view/<id>`, `/api/views/:id/app`). */
export function renderViewDocument(spec: ViewSpec, o: RenderOpts = {}): string {
  return documentOf(spec.title, o.language ?? "it", renderViewFragment(spec, o));
}

/** The generic app (`ui://topics/view`): empty until the tool result brings a view. */
export function renderViewAppShell(language: ViewLanguage = "it"): string {
  return documentOf("Topics", language, "").replace('<main id="view">', '<main id="view" aria-busy="true">');
}
