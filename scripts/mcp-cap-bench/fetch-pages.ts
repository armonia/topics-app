/**
 * Scarica UNA VOLTA le 10 pagine con cui il banco misura, e le mette in cache
 * fuori dal repo.
 *
 * Perché pagine vere e non lorem ipsum: la grandezza da misurare è quanto pesa
 * in contesto la risposta di un tool web, e quel peso dipende da com'è fatta
 * una pagina vera (markup ripulito, liste, blocchi di codice). Le misure di
 * riferimento — mediana 16,9 kB su `wigolo__search`, 17,4 kB su
 * `exa__web_search` — vengono da chiamate reali: il banco deve stare lì.
 *
 * Perché in cache e non a ogni run: le due misure (taglio spento / acceso)
 * devono vedere BYTE IDENTICI, altrimenti la differenza che leggo potrebbe
 * essere la rete che mi ha dato una pagina diversa. Il manifest porta sha256 e
 * dimensione di ciò che è stato misurato davvero.
 *
 * Ogni pagina si porta in coda una riga MARCATORE con una parola inventata:
 * serve al controllo del caso legittimo — a taglio acceso il modello deve
 * saperla ancora dire, andandosela a rileggere dal file su cui la CLI ha
 * versato il risultato.
 *
 *     bun scripts/mcp-cap-bench/fetch-pages.ts [--force]
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { PAGES, PAGES_DIR, MANIFEST_PATH, markerFor, pageFile } from "./pages";

const force = process.argv.includes("--force");

/** Da HTML a testo: via script/style, via i tag, entità minime, spazi normali. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

mkdirSync(PAGES_DIR, { recursive: true });

const manifest: Array<{ n: number; url: string; bytes: number; sha256: string; marker: string }> = [];

for (const [i, url] of PAGES.entries()) {
  const n = i + 1;
  const dest = pageFile(n);
  let text: string;
  if (existsSync(dest) && !force) {
    text = readFileSync(dest, "utf8");
    console.log(`  [${n}] cache  ${(text.length / 1000).toFixed(1)} kB  ${url}`);
  } else {
    const resp = await fetch(url, { headers: { "user-agent": "topics-mcp-cap-bench/1" } });
    if (!resp.ok) throw new Error(`[${n}] HTTP ${resp.status} su ${url}`);
    const body = htmlToText(await resp.text());
    // Taglio a 18 kB: la mediana misurata dei risultati web MCP reali è 16,9 kB
    // e la p90 è 24,3. Una pagina da 200 kB renderebbe il banco una caricatura.
    text = body.slice(0, 18_000) + `\n\n${markerFor(n)}\n`;
    writeFileSync(dest, text);
    console.log(`  [${n}] scaricata ${(text.length / 1000).toFixed(1)} kB  ${url}`);
  }
  manifest.push({ n, url, bytes: text.length, sha256: await sha256(text), marker: markerFor(n) });
}

writeFileSync(MANIFEST_PATH, JSON.stringify({ pagesDir: PAGES_DIR, pages: manifest }, null, 2) + "\n");
const tot = manifest.reduce((a, p) => a + p.bytes, 0);
console.log(`\n${manifest.length} pagine, ${(tot / 1000).toFixed(1)} kB in tutto → ${PAGES_DIR}`);
console.log(`manifest → ${MANIFEST_PATH}`);
