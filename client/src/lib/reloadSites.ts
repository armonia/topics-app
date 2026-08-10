/**
 * Censimento dei siti di reload nel guscio nativo (Rust), per la guardia in
 * `reloadFlash.test.ts`.
 *
 * Perché un censimento e non una regex sul modo in cui il reload è scritto: la
 * guardia precedente cercava `eval("…location.reload()…")`, cioè UNA forma
 * sintattica. Il giorno in cui il recupero-finestra ha estratto la chiamata in
 * `eval_in_main_webview(&h, …)` la regex ha smesso di trovare qualsiasi cosa —
 * e una guardia che non trova più niente non protegge più niente, comunque la
 * si faccia tornare verde. Qui si parte dal fatto grezzo e inaggirabile («in
 * questo file c'è scritto `location.reload()`») e si chiede a chi lo scrive di
 * dichiarare in QUALE categoria sta.
 */

/** Un'occorrenza di `location.reload()` nel sorgente Rust. */
export interface ReloadSite {
  /** Nome del file (`lib.rs`). */
  file: string;
  /** Riga 1-based nel file originale. */
  line: number;
  /** `fn` o `const` che la contiene — la chiave con cui la guardia la riconosce. */
  owner: string;
}

const FN_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/;
const CONST_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)/;

/**
 * Le righe che NON sono codice di produzione: commenti (i doc-comment parlano
 * dei reload, e citarli non è farne uno) e i moduli `#[cfg(test)]` (dove i
 * `location.reload()` stanno dentro le asserzioni dei test Rust, che sono
 * guardie a loro volta). Si azzerano invece di toglierle, così i numeri di riga
 * restano quelli veri del file.
 */
export function codeOnlyLines(source: string): string[] {
  const out = source.split("\n");
  for (let i = 0; i < out.length; i++) {
    const t = out[i].trim();
    if (t.startsWith("//")) out[i] = "";
    if (t !== "#[cfg(test)]") continue;
    // Il modulo di test va da qui alla prima `}` in colonna 0: i `mod` di test
    // sono top-level, quindi la chiusura non è ambigua.
    let j = i;
    while (j < out.length && out[j] !== "}") j++;
    for (let k = i; k <= Math.min(j, out.length - 1); k++) out[k] = "";
    i = j;
  }
  return out;
}

/**
 * Ogni `location.reload()` del sorgente, con il `fn`/`const` che lo contiene.
 * L'owner è l'ultimo `fn`/`const` dichiarato prima della riga: un reload dentro
 * una closure annidata resta attribuito all'elemento che lo ospita, che è
 * esattamente il livello a cui si decide se quel reload è lecito.
 */
export function findReloadSites(file: string, source: string): ReloadSite[] {
  const lines = codeOnlyLines(source);
  const sites: ReloadSite[] = [];
  let owner = "<top-level>";
  for (let i = 0; i < lines.length; i++) {
    const m = FN_RE.exec(lines[i]) ?? CONST_RE.exec(lines[i]);
    if (m) owner = m[1];
    const hits = lines[i].split("location.reload()").length - 1;
    for (let h = 0; h < hits; h++) sites.push({ file, line: i + 1, owner });
  }
  return sites;
}

/** Conteggio per owner, nell'ordine in cui compaiono nel file. */
export function countByOwner(sites: ReloadSite[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sites) out[s.owner] = (out[s.owner] ?? 0) + 1;
  return out;
}
