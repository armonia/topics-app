/**
 * 4.2 — la descrizione di UN elemento: quanto serve a MODIFICARLO, non solo a
 * nominarlo.
 *
 * Prima il click-to-edit mandava in chat una riga sola («cssPath @ path +
 * bbox»). Con quella riga un modello sa dove hai cliccato ma non cosa hai
 * cliccato: non vede il markup, non vede lo stile applicato, non vede com'è
 * venuto fuori. Quindi o indovina, o va a cercarsi il sorgente per tentativi.
 * Qui la selezione diventa un blocco di contesto completo: HTML potato, stile
 * CALCOLATO (quello vero, non quello scritto nel CSS) e un ritaglio dello
 * schermo che l'host allega come immagine.
 *
 * Le scelte non ovvie:
 *
 *  • **Una sonda sola per due host.** `DESCRIBE_ELEMENT_FN` gira sia dentro
 *    Playwright (`page.evaluate`) sia dentro la WKWebView nativa
 *    (`browser_eval_js` + `Function.prototype.toString()`), esattamente come i
 *    `*_FN` di `browser-snapshot-core`. Le due pane avevano già due picker
 *    diversi che producevano due formati diversi: quel disallineamento è il
 *    motivo per cui questo file esiste.
 *
 *  • **Nessun riferimento allo scope esterno dentro la FN.** Viene serializzata
 *    con `toString()`: qualunque identificatore di modulo diventerebbe un
 *    `ReferenceError` nella pagina. Costanti e helper stanno DENTRO.
 *
 *  • **L'HTML si pota, non si tronca e basta.** Un `outerHTML` crudo di un
 *    contenitore è mezza pagina; tagliarlo a N caratteri dà markup a metà. Qui
 *    i figli oltre `maxDepth` si collassano in un commento, i testi lunghi si
 *    accorciano, e i tag di chiusura si scrivono SEMPRE — anche fuori budget —
 *    così quello che arriva resta HTML valido.
 *
 *  • **Lo stile calcolato si filtra.** `getComputedStyle` ha ~340 proprietà,
 *    quasi tutte al default: mandarle tutte è rumore che paghi a token. Si
 *    tiene una lista curata, e di quella solo i valori che dicono qualcosa.
 */

export interface ElementBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElementDescription {
  /** Percorso stile XPath `/html/body[1]/div[2]/…`: verboso ma non ambiguo. */
  path: string;
  /** Etichetta breve `tag#id.c1.c2.c3` — quella che si legge a colpo d'occhio. */
  cssPath: string;
  /** Selettore CSS risalente (`main > div.card > button.cta`), interrotto al
   *  primo `#id` incontrato. Serve a RITROVARE l'elemento, non a descriverlo. */
  selector: string;
  /** Riquadro in CSS px relativi al viewport (come `getBoundingClientRect`). */
  bbox: ElementBox;
  /** Testo dell'elemento, normalizzato e accorciato. */
  text?: string;
  /** `outerHTML` potato (vedi `maxDepth`/`maxHtml`). */
  html: string;
  /** Vero se qualcosa è stato omesso: figli collassati o budget esaurito. */
  htmlTruncated: boolean;
  /** Antenati dall'esterno verso l'interno, target ESCLUSO. */
  ancestors: string[];
  /** Stile calcolato, solo le proprietà che non sono al default. */
  styles: Record<string, string>;
  /** Viewport della pagina in CSS px: serve a chi deve ritagliare lo screenshot. */
  viewport: { w: number; h: number };
  /** URL della pagina al momento del click. */
  url: string;
  /** Ritaglio dell'elemento. Non lo produce la sonda: lo aggiunge l'host
   *  (Playwright con `clip`, la pane nativa con un canvas). */
  screenshot?: { dataUrl: string; w: number; h: number };
}

export interface DescribeElementOptions {
  /** Punto nel viewport, in CSS px. */
  x: number;
  y: number;
  /** Tetto di caratteri per l'HTML potato (default 4000). */
  maxHtml?: number;
  /** Profondità oltre la quale i figli si collassano (default 3). */
  maxDepth?: number;
}

/**
 * Sonda IN-PAGINA. Nessun riferimento allo scope di modulo: viene serializzata
 * e valutata nella pagina remota. Torna `null` se sotto il punto non c'è nulla.
 */
export const DESCRIBE_ELEMENT_FN = (p: DescribeElementOptions): ElementDescription | null => {
  const target = document.elementFromPoint(p.x, p.y);
  if (!target) return null;

  const maxHtml = p.maxHtml && p.maxHtml > 0 ? p.maxHtml : 4000;
  const maxDepth = p.maxDepth && p.maxDepth > 0 ? p.maxDepth : 3;

  const label = (el: Element): string => {
    let out = el.tagName.toLowerCase();
    if (el.id) out += '#' + el.id;
    const ca = el.getAttribute('class');
    if (ca) {
      const parts = ca.split(/\s+/).filter(Boolean).slice(0, 3);
      if (parts.length) out += '.' + parts.join('.');
    }
    return out;
  };

  // --- percorso stile XPath ---
  const segments: string[] = [];
  let cur: Element | null = target;
  while (cur && cur !== document.documentElement) {
    const node: Element = cur;
    const parent: Element | null = node.parentElement;
    const siblings = parent
      ? Array.prototype.filter.call(parent.children, (c: Element) => c.tagName === node.tagName)
      : [];
    const idx = parent ? (siblings as Element[]).indexOf(node) + 1 : 1;
    segments.unshift(node.tagName.toLowerCase() + '[' + idx + ']');
    cur = parent;
  }
  const path = '/html/' + segments.join('/');

  // --- selettore risalente: si ferma al primo #id, che è già univoco ---
  const chain: string[] = [];
  let walk: Element | null = target;
  let hops = 0;
  while (walk && walk !== document.documentElement && hops < 8) {
    hops++;
    const el: Element = walk;
    if (el.id) {
      chain.unshift(el.tagName.toLowerCase() + '#' + CSS.escape(el.id));
      break;
    }
    let seg = el.tagName.toLowerCase();
    const ca = el.getAttribute('class');
    if (ca) {
      const first = ca.split(/\s+/).filter(Boolean)[0];
      if (first) seg += '.' + CSS.escape(first);
    }
    const parent = el.parentElement;
    if (parent) {
      const same = Array.prototype.filter.call(
        parent.children,
        (c: Element) => c.tagName === el.tagName,
      ) as Element[];
      if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    chain.unshift(seg);
    walk = parent;
  }
  const selector = chain.join(' > ');

  // --- antenati ---
  const ancestors: string[] = [];
  let up: Element | null = target.parentElement;
  while (up && up !== document.documentElement && ancestors.length < 8) {
    ancestors.unshift(label(up));
    up = up.parentElement;
  }

  // --- HTML potato ---
  const VOID = ',area,base,br,col,embed,hr,img,input,link,meta,param,source,track,wbr,';
  const escText = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s: string): string => escText(s).replace(/"/g, '&quot;');
  const parts: string[] = [];
  let budget = maxHtml;
  let truncated = false;
  const push = (s: string): void => {
    if (budget <= 0) {
      truncated = true;
      return;
    }
    if (s.length > budget) {
      parts.push(s.slice(0, budget));
      budget = 0;
      truncated = true;
      return;
    }
    parts.push(s);
    budget -= s.length;
  };
  const serialize = (el: Element, depth: number): void => {
    const tag = el.tagName.toLowerCase();
    let open = '<' + tag;
    const attrs = Array.prototype.slice.call(el.attributes) as Attr[];
    for (const at of attrs) {
      const v = at.value.length > 160 ? at.value.slice(0, 160) + '…' : at.value;
      open += ' ' + at.name + '="' + escAttr(v) + '"';
    }
    push(open + '>');
    if (VOID.indexOf(',' + tag + ',') >= 0) return;
    if (el.children.length > 0 && depth >= maxDepth) {
      push('<!-- ' + el.children.length + ' figli omessi -->');
      truncated = true;
    } else {
      const kids = Array.prototype.slice.call(el.childNodes) as Node[];
      for (const k of kids) {
        if (budget <= 0) {
          truncated = true;
          break;
        }
        if (k.nodeType === 1) serialize(k as Element, depth + 1);
        else if (k.nodeType === 3) {
          const t = (k.nodeValue || '').replace(/\s+/g, ' ');
          if (t.trim()) push(escText(t.length > 200 ? t.slice(0, 200) + '…' : t));
        }
      }
    }
    // La chiusura si scrive SEMPRE, budget o no: HTML valido troncato è
    // leggibile, HTML mozzato a metà tag no.
    parts.push('</' + tag + '>');
  };
  serialize(target, 0);

  // --- stile calcolato, filtrato ---
  const props = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'margin', 'padding', 'border', 'border-radius', 'box-shadow',
    'background-color', 'background-image', 'color',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
    'text-align', 'text-transform', 'text-decoration',
    'opacity', 'overflow', 'flex', 'flex-direction', 'flex-wrap',
    'justify-content', 'align-items', 'gap',
    'grid-template-columns', 'grid-template-rows',
    'transform', 'transition', 'cursor', 'white-space',
  ];
  const defaults: Record<string, string> = {
    'font-weight': '400',
    'text-align': 'start',
    flex: '0 1 auto',
    'flex-direction': 'row',
    'flex-wrap': 'nowrap',
    opacity: '1',
  };
  const cs = getComputedStyle(target);
  const styles: Record<string, string> = {};
  for (const prop of props) {
    const v = (cs.getPropertyValue(prop) || '').trim();
    if (!v) continue;
    if (defaults[prop] === v) continue;
    if (
      v === 'none' || v === 'normal' || v === 'auto' || v === 'static' ||
      v === 'visible' || v === '0px' || v === '0s' || v === 'nonzero' ||
      v === 'rgba(0, 0, 0, 0)' || v === 'all 0s ease 0s'
    ) continue;
    // `border` e `text-decoration` non impostati tornano una tripletta, non ''.
    if (v.indexOf('0px none') === 0 || v.indexOf('none solid') === 0) continue;
    styles[prop] = v;
  }

  const r = target.getBoundingClientRect();
  const txt = (target.textContent || '').replace(/\s+/g, ' ').trim();

  return {
    path,
    cssPath: label(target),
    selector,
    bbox: {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    },
    ...(txt ? { text: txt.slice(0, 200) } : {}),
    html: parts.join(''),
    htmlTruncated: truncated,
    ancestors,
    styles,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    url: location.href,
  };
};

/**
 * Il blocco che finisce nel composer. Markdown, perché è quello che il modello
 * legge meglio e l'umano rilegge senza fatica prima di premere invio.
 *
 * Scritto qui e non nel componente perché lo usano DUE chiamanti (pane web e
 * pane nativa) e perché un formato di contesto è la cosa che più facilmente
 * diverge in silenzio quando vive in due copie.
 */
export function formatElementContext(
  d: ElementDescription,
  opts?: { screenshotAttached?: boolean },
): string {
  const lines: string[] = [];
  lines.push(`**Elemento selezionato** · \`${d.cssPath}\``);
  if (d.selector) lines.push(`- selettore: \`${d.selector}\``);
  lines.push(`- percorso: \`${d.path}\``);
  lines.push(`- riquadro: ${d.bbox.x},${d.bbox.y} · ${d.bbox.w}×${d.bbox.h} px`);
  if (d.url) lines.push(`- pagina: ${d.url}`);
  if (d.ancestors.length) lines.push(`- antenati: ${d.ancestors.join(' › ')}`);
  if (d.text) lines.push(`- testo: "${d.text}"`);
  if (opts?.screenshotAttached) lines.push("- ritaglio dell'elemento allegato come immagine");

  if (d.html) {
    lines.push('', '```html', d.html, '```');
    if (d.htmlTruncated) lines.push('_(markup potato: figli profondi collassati)_');
  }

  const styleKeys = Object.keys(d.styles);
  if (styleKeys.length) {
    lines.push('', '```css', `/* stile calcolato di ${d.cssPath} */`);
    for (const k of styleKeys) lines.push(`${k}: ${d.styles[k]};`);
    lines.push('```');
  }

  return lines.join('\n');
}
