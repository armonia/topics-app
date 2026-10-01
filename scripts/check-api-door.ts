#!/usr/bin/env bun
/**
 * EVERY `/api` REQUEST OF THE CLIENT GOES THROUGH ONE DOOR.
 *
 * The door is `apiFetch` in `client/src/lib/shell/net.ts`: it owns the data
 * server's origin (absolute under Tauri) and the identity refusal (a 401 from
 * the server's identity gate flips the pairing screen, whichever call met it).
 * Before it existed the client sent `/api` requests from 173 raw `fetch`
 * calls in 81 files (145 with a literal URL, 28 with a URL built at runtime,
 * `api.ts::request` among them), and only the calls that went through
 * `request` noticed a refusal.
 *
 * WHAT THIS GATE REJECTS: a literal `fetch('/api…')`, `fetch(\`/api…\`)`,
 * `fetch(\`/api${p}\`)`, `fetch(\`${x}/api…\`)` or `fetch(\`${API_BASE}…\`)`
 * in client source, outside the door's own file. Use `apiFetch(path, init)`:
 * same signature, same `Response`, nothing the callsite sends changes.
 *
 * WHAT IT CANNOT SEE: a URL built at runtime (`fetch(url)`,
 * `fetch(...route())`). The 28 that existed when the door was cut were moved
 * to `apiFetch` by hand; a new one is a review matter. The global shim is NOT
 * a safety net here: it is installed only under Tauri (NETSHIM-01), so on the
 * web and on a LAN device a raw fetch really bypasses the door.
 *
 * Tests are out of scope (they stub `fetch` on purpose), and so is the demo
 * bundle under `client/src/demo/`, which never talks to a real server.
 *
 * Run: `bun run check:api-door`  (exit 1 listing each offending line)
 *      `bun run scripts/check-api-door.ts path/to/file.ts …`  (scan those)
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const DOOR = "client/src/lib/shell/net.ts";

/** A literal `/api` URL handed straight to `fetch` (also `window.fetch`). */
const RAW_API_FETCH = /\bfetch\(\s*(?:(['"`])(?:\$\{[^}]*\})?\/api(?=[/?'"`$])|`\$\{API_BASE\})/g;

export interface RawFetchHit {
  file: string;
  line: number;
  text: string;
}

function isOutOfScope(rel: string): boolean {
  return (
    rel === DOOR ||
    rel.startsWith("client/src/demo/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)
  );
}

/** Every literal raw `/api` fetch in `source`, comments excluded. */
export function findRawApiFetches(file: string, source: string): RawFetchHit[] {
  const lines = source.split("\n");
  const hits: RawFetchHit[] = [];
  RAW_API_FETCH.lastIndex = 0;
  for (let m = RAW_API_FETCH.exec(source); m; m = RAW_API_FETCH.exec(source)) {
    const line = source.slice(0, m.index).split("\n").length;
    const text = lines[line - 1] ?? "";
    const before = text.slice(0, text.indexOf("fetch(") >= 0 ? text.indexOf("fetch(") : 0).trim();
    // A line comment or a JSDoc line quoting the old form is prose, not a call.
    if (before.startsWith("//") || before.startsWith("*") || before.startsWith("/*")) continue;
    hits.push({ file, line, text: text.trim() });
  }
  return hits;
}

function listClientSources(): string[] {
  const out: string[] = [];
  for (const rel of new Glob("client/src/**/*.{ts,tsx,js,jsx,mjs}").scanSync({ cwd: ROOT })) {
    if (!isOutOfScope(rel)) out.push(rel);
  }
  return out.sort();
}

function main(): number {
  const args = process.argv.slice(2);
  const files = args.length
    ? args.map((p) => relative(ROOT, resolve(process.cwd(), p))).filter((rel) => !isOutOfScope(rel))
    : listClientSources();
  const hits: RawFetchHit[] = [];
  for (const rel of files) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    hits.push(...findRawApiFetches(rel, readFileSync(abs, "utf8")));
  }
  if (hits.length === 0) {
    console.log(`check:api-door: ok, no raw fetch('/api…') outside ${DOOR} (${files.length} files)`);
    return 0;
  }
  console.error(`check:api-door: ${hits.length} raw fetch('/api…') outside the door. Use apiFetch() from ${DOOR}:`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text}`);
  return 1;
}

if (import.meta.main) process.exit(main());
