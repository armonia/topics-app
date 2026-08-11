/**
 * Le 10 pagine del banco, e dove vivono.
 *
 * Fuori dal repo di proposito: sono testo di terzi, e il repo deve portare il
 * MANIFEST di ciò che è stato misurato (url, byte, sha256), non le pagine.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Documentazione pubblica, stabile, di taglia realistica. */
export const PAGES = [
  "https://bun.sh/docs/installation",
  "https://bun.sh/docs/runtime/env",
  "https://bun.sh/docs/api/sqlite",
  "https://bun.sh/docs/api/http",
  "https://bun.sh/docs/cli/test",
  "https://bun.sh/docs/api/file-io",
  "https://bun.sh/docs/api/spawn",
  "https://bun.sh/docs/api/websockets",
  "https://bun.sh/docs/bundler",
  "https://bun.sh/docs/api/globals",
];

/**
 * `TOPICS_BENCH_DIR` non è un vezzo: il server MCP del banco lo spawna la CLI,
 * e la CLI gli passa la HOME PULITA del banco. Con la sola `homedir()` il
 * server andava a cercare le pagine dentro la home finta, `readFileSync`
 * lanciava, il processo moriva e dal lato CLI si leggeva «MCP error -32000:
 * Connection closed» — un guasto che sembra di trasporto ed è di percorso.
 */
export const BENCH_DIR =
  process.env.TOPICS_BENCH_DIR || join(homedir(), ".topics", "media", "mcp-cap-bench");
export const PAGES_DIR = join(BENCH_DIR, "pages");
export const MANIFEST_PATH = join(BENCH_DIR, "manifest.json");
export const RESULTS_PATH = join(BENCH_DIR, "results.json");

export function pageFile(n: number): string {
  return join(PAGES_DIR, `page-${String(n).padStart(2, "0")}.txt`);
}

/**
 * Il marcatore che ogni pagina si porta in coda. Una parola che non esiste in
 * rete: se il modello la sa dire, l'ha LETTA — non indovinata.
 */
export function markerFor(n: number): string {
  const words = [
    "vermiglio", "quarzite", "brumaio", "salmastro", "ginepraio",
    "tramoggia", "fulmicotone", "arenaria", "ventaglio", "solstizio",
  ];
  return `MARCATORE-PAGINA-${n}: ${words[n - 1]}-${1000 + n * 7}`;
}
