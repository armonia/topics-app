/**
 * Which Claude models the INSTALLED CLI actually accepts.
 *
 * `listModels()` used to return a list typed by hand in this repo. That list is
 * wrong the day Anthropic ships a model and stays wrong until someone notices:
 * on 2026-07-29 it still advertised `claude-opus-4-8` as the newest Opus and
 * knew nothing about the 1M-context variants (`claude-opus-5[1m]`), so no path
 * through the app could put a session on a 1M window — the picker simply had no
 * such entry.
 *
 * The CLI has no `models list` command and no manifest, but it does ship the
 * table: the model ids are string literals inside the binary. So we scan it.
 * Ugly on paper, but it is the ONLY source that (a) matches the binary we are
 * about to spawn and (b) knows about the `[1m]` suffix, which is a CLI-side
 * convention and does not exist in the public `/v1/models` API listing.
 *
 * Everything here is defensive: a binary we cannot read, a future layout, a
 * scan that finds nothing → `FALLBACK_MODELS`. The picker is never empty.
 */

import { createReadStream, statSync } from "fs";

/** Used when the scan cannot run or comes back empty. Newest-known-first. */
export const FALLBACK_MODELS = [
  "claude-opus-5[1m]",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-fable-5",
];

/** Family order in the picker: strongest first, matching the CLI's own order. */
const FAMILY_ORDER = ["opus", "sonnet", "haiku", "fable"];

/** How many versions per family survive the cut (newest first). */
const GENERATIONS_PER_FAMILY = 2;

interface ParsedModel {
  id: string;
  family: string;
  major: number;
  minor: number;
  /** true = the 1M-context beta variant of the same version. */
  long: boolean;
  /** true = `claude-opus-4` — a bare-major alias with no minor component. */
  bare: boolean;
}

function parseModelId(id: string): ParsedModel | null {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(\[1m\])?$/.exec(id.trim());
  if (!m) return null;
  return {
    id,
    family: m[1]!,
    major: Number(m[2]),
    minor: m[3] === undefined ? 0 : Number(m[3]),
    long: Boolean(m[4]),
    bare: m[3] === undefined,
  };
}

/**
 * Il modello più recente di una famiglia fra quelli passati, o `null` se quella
 * famiglia non c'è.
 *
 * Sta qui perché è la stessa domanda del resto del file — quale id di questa
 * famiglia — e perché i chiamanti l'alternativa ce l'avevano già e faceva
 * danni: scrivere l'id a mano. `claude-opus-4-8` inchiodato nel dispatcher ha
 * mandato ogni agente su Opus 4.8 per settimane dopo l'arrivo di Opus 5, senza
 * un errore né un log.
 *
 * Le varianti `[1m]` sono lo stesso modello servito con la finestra lunga —
 * una MODALITÀ, non una capacità superiore — quindi vincono solo se di quella
 * versione manca l'id nudo: scegliere «il più recente» non deve decidere di
 * nascosto anche quanta finestra (e quanta spesa) usa una sessione.
 */
export function newestOfFamily(family: string, available: readonly string[]): string | null {
  let best: ParsedModel | null = null;
  for (const id of available) {
    const p = parseModelId(id);
    if (!p || p.family !== family) continue;
    if (
      best === null ||
      p.major > best.major ||
      (p.major === best.major && p.minor > best.minor) ||
      (p.major === best.major && p.minor === best.minor && best.long && !p.long)
    ) {
      best = p;
    }
  }
  return best?.id ?? null;
}

/** La famiglia di un id (`claude-opus-5[1m]` → `opus`), o `null` se non è un
 *  id Claude riconoscibile. */
export function familyOf(id: string): string | null {
  return parseModelId(id)?.family ?? null;
}

/**
 * Raw ids → the shortlist a human should see. Pure, so the messy part is
 * testable without a 256MB binary on disk.
 *
 * Two rules do the work:
 *  • a bare-major id is dropped when a minor of the SAME major exists
 *    (`claude-opus-4` is just an alias for the 4.x series once `claude-opus-4-8`
 *    is on the list — but `claude-opus-5` stays, since there is no `5-x`);
 *  • only the newest `GENERATIONS_PER_FAMILY` versions per family survive, each
 *    followed by its `[1m]` variant when the CLI knows one.
 */
export function selectCurrentModels(ids: Iterable<string>): string[] {
  const parsed: ParsedModel[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const p = parseModelId(raw);
    if (p) parsed.push(p);
  }
  if (parsed.length === 0) return [];

  // A version is "real" if any id for it carries a minor component.
  const hasMinor = new Set(parsed.filter((p) => !p.bare).map((p) => `${p.family}-${p.major}`));
  const kept = parsed.filter((p) => !(p.bare && hasMinor.has(`${p.family}-${p.major}`)));

  const out: string[] = [];
  for (const family of FAMILY_ORDER) {
    const versions = new Map<string, ParsedModel[]>();
    for (const p of kept) {
      if (p.family !== family) continue;
      const key = `${p.major}.${p.minor}`;
      const bucket = versions.get(key);
      if (bucket) bucket.push(p);
      else versions.set(key, [p]);
    }
    const ordered = [...versions.entries()]
      .sort((a, b) => {
        const [aMaj, aMin] = a[0].split(".").map(Number) as [number, number];
        const [bMaj, bMin] = b[0].split(".").map(Number) as [number, number];
        return bMaj - aMaj || bMin - aMin;
      })
      .slice(0, GENERATIONS_PER_FAMILY);
    for (const [, bucket] of ordered) {
      // Base id before its long-window twin, so the plain model leads.
      for (const p of bucket.sort((a, b) => Number(a.long) - Number(b.long))) out.push(p.id);
    }
  }
  return out;
}

/** Comfortably longer than any model id, so a hit is never truncated. */
const WINDOW = 48;

/**
 * A model id, anchored at a hit. The boundary guards matter: without the
 * trailing one, `claude-opus-4-20250514` (a dated alias) would yield the bogus
 * prefix `claude-opus-4-20`, and `claude-fable-5.md` (a doc filename) would
 * yield `claude-fable-5` from a match that is not a model reference. Minor
 * versions are capped at two digits for the same reason.
 */
const MODEL_ID_AT_START = /^claude-(?:opus|sonnet|haiku|fable)-\d{1,2}(?:-\d{1,2})?(?:\[1m\])?(?![\w.\-[])/;

const NEEDLE = Buffer.from("claude-", "latin1");

/**
 * Collect ids from one buffer. `final` = this is the last buffer, so a match
 * running to the very end is real; mid-stream those are left to the next chunk
 * (which re-scans them with their trailing bytes attached) — otherwise a hit
 * cut by the chunk edge could match a bogus prefix like `claude-opus-4-2` out
 * of `claude-opus-4-20250514`.
 */
function collectFrom(buf: Buffer, final: boolean, into: Set<string>): void {
  let from = 0;
  for (;;) {
    const idx = buf.indexOf(NEEDLE, from);
    if (idx === -1) break;
    from = idx + 1;
    if (!final && idx + WINDOW > buf.length) break;
    // The char BEFORE the hit decides whether this is an id or the tail of a
    // longer token (`claude-fable-5-mythos-5`, a path, a dated alias).
    if (idx > 0) {
      const prev = String.fromCharCode(buf[idx - 1]!);
      if (/[\w.\-[]/.test(prev)) continue;
    }
    const m = MODEL_ID_AT_START.exec(buf.subarray(idx, idx + WINDOW).toString("latin1"));
    if (m) into.add(m[0]);
  }
}

/**
 * Scan a CLI binary (or JS bundle) for model-id literals. Never throws.
 *
 * Runs `Buffer.indexOf("claude-")` (native memchr-class search) and only
 * decodes the ~48 bytes around each hit. Regexing the whole file as latin1
 * text instead costs ~18s on the 256MB native binary — long enough that the
 * first provider-snapshot request would visibly hang.
 */
export async function scanCliForModelIds(cliPath: string): Promise<string[]> {
  const found = new Set<string>();

  await new Promise<void>((resolve) => {
    let stream: ReturnType<typeof createReadStream>;
    try {
      stream = createReadStream(cliPath, { highWaterMark: 8 * 1024 * 1024 });
    } catch {
      resolve();
      return;
    }
    // Carry the tail of each chunk into the next one: an id straddling a chunk
    // boundary would otherwise be split in half and lost.
    let tail: Buffer = Buffer.alloc(0);
    stream.on("data", (chunk: string | Buffer) => {
      const incoming = Buffer.from(chunk as Buffer);
      const buf = tail.length ? Buffer.concat([tail, incoming]) : incoming;
      collectFrom(buf, false, found);
      tail = Buffer.from(buf.subarray(Math.max(0, buf.length - WINDOW)));
    });
    stream.on("error", () => resolve());
    stream.on("close", () => { collectFrom(tail, true, found); resolve(); });
    stream.on("end", () => { collectFrom(tail, true, found); resolve(); });
  });
  return [...found];
}

interface CacheEntry {
  /** Identity of the scanned file: a CLI upgrade must invalidate this. */
  key: string;
  models: string[];
}

let cache: CacheEntry | null = null;
let inflight: Promise<string[]> | null = null;

function cacheKeyFor(cliPath: string): string {
  try {
    const st = statSync(cliPath);
    return `${cliPath}:${st.size}:${st.mtimeMs}`;
  } catch {
    return `${cliPath}:missing`;
  }
}

/**
 * The models the installed CLI accepts, newest-first, cached until the binary
 * changes (a CLI upgrade swaps path/mtime, so the next call rescans).
 *
 * The scan reads a few hundred MB once per CLI version; concurrent callers
 * share the same in-flight promise instead of each starting their own.
 */
export async function discoverClaudeModels(cliPath: string): Promise<string[]> {
  const key = cacheKeyFor(cliPath);
  if (cache && cache.key === key) return cache.models;
  if (inflight) return inflight;

  inflight = (async () => {
    let models: string[] = [];
    try {
      models = selectCurrentModels(await scanCliForModelIds(cliPath));
    } catch {
      models = [];
    }
    if (models.length === 0) models = [...FALLBACK_MODELS];
    cache = { key, models };
    return models;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

// Niente `resetClaudeModelCache()`: era nato come test seam e nessun test l'ha
// mai chiamato (`claude-models.test.ts` costruisce il suo scenario e legge il
// risultato). Un seam senza test non è un'interfaccia, è una funzione che
// azzera una cache di produzione e che nessuno controlla.
