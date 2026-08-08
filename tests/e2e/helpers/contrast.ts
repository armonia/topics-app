/**
 * La MISURA del contrasto, in un posto solo.
 *
 * Questo metodo era nato dentro `board-theme.spec.ts` e ne esisteva già una
 * seconda copia in `empty-state.spec.ts`: due sorgenti per la stessa aritmetica,
 * che è il modo in cui un cancello smette in silenzio di misurare quello che
 * crede. Sta qui perché ora serve a un terzo posto — l'albero dei file e la
 * barra di stato — e perché un cancello sul contrasto lo si PUNTA su nodi
 * nuovi, non lo si riscrive.
 *
 * Due cose non ovvie, entrambe pagate una volta:
 *
 * · IL COLORE LO NORMALIZZA IL BROWSER, non una regex. `getComputedStyle` non
 *   restituisce sempre `rgb()`: per la palette interna di Tailwind v4 torna
 *   `oklch(0.97 0 0)`, e una regex su `rgba?\(` lo leggeva come [0,0,0,0] —
 *   nero trasparente. Con quella lettura il controllo della Board dava 21:1 in
 *   chiaro (nero su bianco) invece di ~1:1: il test giurava che una superficie
 *   illeggibile fosse a posto. Un canvas 1×1 accetta qualunque sintassi CSS che
 *   il browser sappia parsare e restituisce RGBA veri, alpha compresa.
 *
 * · GLI SFONDI SI COMPOSITANO risalendo gli antenati fino al primo OPACO. Un
 *   chip `bg-white/10` non ha un fondo suo: quello che l'occhio vede sotto il
 *   testo è la pila, e misurare contro il colore dichiarato del nodo darebbe un
 *   numero che non esiste su nessuno schermo.
 *
 * Le due funzioni girano NEL browser (Playwright ne serializza il sorgente):
 * non devono riferirsi a niente di questo modulo, per questo l'aritmetica è
 * ripetuta dentro entrambe invece di stare in un aiutante condiviso.
 */
import type { Page } from "@playwright/test";

export interface ContrastReading {
  /** Rapporto WCAG 2.1 fra il colore del testo e lo sfondo compositato. */
  ratio: number;
  /** Il colore del testo, in rgb() (fra quadre la sintassi originale, se altra). */
  color: string;
  /** Lo sfondo effettivo, cioè quello che l'occhio vede sotto il testo. */
  bg: string;
}

/**
 * Contrasto WCAG 2.1 fra il testo di un elemento e il primo sfondo OPACO
 * risalendo gli antenati.
 */
export async function contrastOf(page: Page, selector: string, index = 0): Promise<ContrastReading> {
  return page.evaluate(([sel, i]: [string, number]) => {
    const el = document.querySelectorAll(sel)[i];
    if (!el) throw new Error(`nessun elemento #${i} per il selettore ${sel}`);

    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const ctx = probe.getContext("2d", { willReadFrequently: true })!;
    const parse = (s: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = s; // se `s` è impresentabile resta "#000": lo vediamo dal contrasto
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const effectiveBg = (start: Element): [number, number, number] => {
      const stack: [number, number, number, number][] = [];
      let node: Element | null = start;
      while (node) {
        const [r, g, b, a] = parse(getComputedStyle(node).backgroundColor);
        if (a > 0) {
          stack.push([r, g, b, a]);
          if (a >= 1) break;
        }
        node = node.parentElement;
      }
      // Nessuno sfondo opaco trovato: il fondo pagina fa da base.
      let [br, bg_, bb] = [255, 255, 255];
      for (let i = stack.length - 1; i >= 0; i--) {
        const [r, g, b, a] = stack[i];
        br = r * a + br * (1 - a);
        bg_ = g * a + bg_ * (1 - a);
        bb = b * a + bb * (1 - a);
      }
      return [br, bg_, bb];
    };
    const lum = (r: number, g: number, b: number) => {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };

    const cs = getComputedStyle(el);
    const [cr, cg, cb] = parse(cs.color);
    const [br, bg_, bb] = effectiveBg(el);
    const l1 = lum(cr, cg, cb);
    const l2 = lum(br, bg_, bb);
    return {
      ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05),
      color: `rgb(${Math.round(cr)}, ${Math.round(cg)}, ${Math.round(cb)})${cs.color.startsWith("rgb") ? "" : ` [${cs.color}]`}`,
      bg: `rgb(${Math.round(br)}, ${Math.round(bg_)}, ${Math.round(bb)})`,
    };
  }, [selector, index] as [string, number]);
}

/**
 * Solo lo sfondo effettivo di un elemento, in [r,g,b]. Serve a misurare la
 * VISIBILITÀ di un rialzo — un chip contro il suo genitore — dove il testo non
 * c'entra: là il numero è la distanza fra due fondi, non un rapporto WCAG.
 */
export async function effectiveBgOf(page: Page, selector: string): Promise<[number, number, number]> {
  return page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`nessun elemento per ${sel}`);
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const ctx = probe.getContext("2d", { willReadFrequently: true })!;
    const parse = (s: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = s;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const stack: [number, number, number, number][] = [];
    let node: Element | null = el;
    while (node) {
      const [r, g, b, a] = parse(getComputedStyle(node).backgroundColor);
      if (a > 0) {
        stack.push([r, g, b, a]);
        if (a >= 1) break;
      }
      node = node.parentElement;
    }
    let [br, bgc, bb] = [255, 255, 255];
    for (let i = stack.length - 1; i >= 0; i--) {
      const [r, g, b, a] = stack[i];
      br = r * a + br * (1 - a);
      bgc = g * a + bgc * (1 - a);
      bb = b * a + bb * (1 - a);
    }
    return [br, bgc, bb] as [number, number, number];
  }, selector);
}

/**
 * Rapporto WCAG 2.1 fra due colori GIÀ compositati. Gira in Node, non nella
 * pagina: serve alla grafica — un pallino di stato — dove i due termini sono
 * due SFONDI (`effectiveBgOf` del pallino e del suo contenitore) e non un testo
 * contro il suo fondo.
 */
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const lum = ([r, g, bl]: [number, number, number]) => {
    const f = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Le due soglie di WCAG 2.1, col nome del motivo per cui sono due.
 * Testo normale: 4,5:1 (AA). Grafica e componenti d'interfaccia — un pallino di
 * stato, il tratto di un'icona — 3:1, perché una forma si riconosce con meno
 * contrasto di quanto ne serva a leggere una parola.
 */
export const AA_TESTO = 4.5;
export const AA_GRAFICA = 3;
