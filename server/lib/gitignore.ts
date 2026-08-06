/**
 * Un `.gitignore` letto come lo legge git, non come una lista di nomi.
 *
 * ── Cosa faceva prima ───────────────────────────────────────────────────────
 * Le righe venivano ridotte a un nome secco (`replace(/^\//, "")`,
 * `replace(/\/$/, "")`) e confrontate col SOLO basename di ogni voce. Tre modi
 * di sbagliare, tutti visibili su questo repo:
 *
 * - `/data/` è ancorato alla radice, ma perso l'ancoraggio diventava «una
 *   cartella che si chiama data, ovunque»: spariva `landing/src/data/`, che git
 *   TRACCIA (`changelog.json`, `compare.ts`). File tracciati invisibili
 *   nell'albero.
 * - `!tests/` è una NEGAZIONE — «questa però tienila» — e finiva nel set come
 *   un pattern chiamato letteralmente `!tests`, mentre `tests/` restava
 *   escluso da una riga precedente.
 * - `tabbar-*.png` non ha mai matchato niente: gli unici rami erano
 *   `startsWith("*.")` ed `endsWith("*")`, quindi una wildcard IN MEZZO al
 *   nome cadeva fuori. Grep li trovava, l'albero giurava che non esistessero.
 *
 * ── Cosa fa adesso ──────────────────────────────────────────────────────────
 * Regole vere: ancoraggio, negazione, solo-cartelle, glob con `*` che non
 * attraversa `/` e `**` che lo attraversa, e l'ULTIMA regola che matcha vince
 * (è così che una negazione può riaprire ciò che una riga prima aveva chiuso).
 * Il confronto è sul path RELATIVO alla radice, non sul basename.
 *
 * Anche i `.gitignore` annidati contano: `addFile` si chiama scendendo, e le
 * regole di una sottocartella valgono solo da lì in giù.
 */

export interface IgnoreRule {
  /** Regex sul path relativo alla radice del set. */
  re: RegExp;
  /** `!pattern`: rimette dentro ciò che una regola precedente aveva escluso. */
  negated: boolean;
  /** `pattern/`: vale solo per le cartelle. */
  dirOnly: boolean;
}

/** Un carattere che in regex ha un significato e qui non deve averlo. */
function esc(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
}

/**
 * Un pattern gitignore → regex.
 *
 * `*` non attraversa `/` (è la differenza che rende `src/*.ts` diverso da
 * `src/**\/*.ts`), `**` sì, `?` è un carattere qualsiasi tranne `/`.
 */
function patternToRegex(pattern: string, anchored: boolean): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        // `**/` iniziale o intermedio: zero o più segmenti.
        if (pattern[i + 1] === "/") { i++; out += "(?:.*/)?"; }
        else out += ".*";
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) { out += "\\["; }
      else { out += pattern.slice(i, close + 1); i = close; }
    } else {
      out += esc(c);
    }
  }
  // Non ancorato = «a qualunque profondità», che è la regola di git per i
  // pattern senza `/` dentro.
  const head = anchored ? "^" : "^(?:.*/)?";
  // La coda copre anche i DISCENDENTI: escludere `dist` esclude `dist/a/b`.
  return new RegExp(`${head}${out}(?:/.*)?$`);
}

/** Una riga di `.gitignore` → regola, o `null` se è vuota/commento. */
export function parseIgnoreLine(raw: string, base = ""): IgnoreRule | null {
  let line = raw;
  // Uno spazio finale conta solo se preceduto da backslash: git lo scarta.
  line = line.replace(/(?<!\\)\s+$/, "");
  if (!line || line.startsWith("#")) return null;

  let negated = false;
  if (line.startsWith("!")) { negated = true; line = line.slice(1); }
  else if (line.startsWith("\\!")) line = line.slice(1);

  let dirOnly = false;
  if (line.endsWith("/")) { dirOnly = true; line = line.slice(0, -1); }
  if (!line) return null;

  // Ancorato se comincia con `/` oppure se ha uno `/` in mezzo: entrambi i casi
  // significano «relativo a QUESTA cartella», non «ovunque».
  let anchored = false;
  if (line.startsWith("/")) { anchored = true; line = line.slice(1); }
  else if (line.includes("/")) anchored = true;
  if (!line) return null;

  const prefix = base ? `${base}/` : "";
  const re = anchored
    ? patternToRegex(prefix + line, true)
    : prefix
      // Una regola non ancorata di un `.gitignore` annidato vale a qualunque
      // profondità, ma SOLO dentro la sua cartella.
      ? new RegExp(`^${prefix.replace(/[.+^${}()|[\]\\]/g, "\\$&")}(?:.*/)?${patternToRegex(line, true).source.slice(1)}`)
      : patternToRegex(line, false);
  return { re, negated, dirOnly };
}

/**
 * L'insieme delle regole in vigore, con la radice a cui sono relative.
 *
 * L'ordine conta: vince l'ULTIMA che matcha.
 */
export class IgnoreSet {
  private rules: IgnoreRule[] = [];

  /** Le righe di un `.gitignore`; `base` è la sua cartella, relativa alla radice. */
  addFile(content: string, base = ""): this {
    for (const line of content.split("\n")) {
      const rule = parseIgnoreLine(line, base);
      if (rule) this.rules.push(rule);
    }
    return this;
  }

  /** Una copia, per scendere in una sottocartella senza sporcare il padre. */
  clone(): IgnoreSet {
    const c = new IgnoreSet();
    c.rules = [...this.rules];
    return c;
  }

  get size(): number { return this.rules.length; }

  /** `relPath` è relativo alla radice, con `/` come separatore e senza `./`. */
  ignores(relPath: string, isDir: boolean): boolean {
    // Le cartelle antenate: una regola `solo-cartelle` che colpisce `data/`
    // esclude anche `data/topics.db`, che cartella non è. Nella camminata il
    // caso non si presenta (in una cartella esclusa non si scende), ma chi
    // chiama questa funzione su un path qualsiasi deve avere la stessa
    // risposta di git.
    const ancestors: string[] = [];
    for (let i = relPath.indexOf("/"); i !== -1; i = relPath.indexOf("/", i + 1)) {
      ancestors.push(relPath.slice(0, i));
    }
    let ignored = false;
    for (const r of this.rules) {
      let hit = (isDir || !r.dirOnly) && r.re.test(relPath);
      if (!hit && r.dirOnly) hit = ancestors.some(a => r.re.test(a));
      if (!hit) continue;
      ignored = !r.negated;
    }
    return ignored;
  }
}
