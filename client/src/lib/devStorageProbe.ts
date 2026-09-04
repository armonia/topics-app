/**
 * Storage probe of the renderer: WHO writes to localStorage, measured instead
 * of guessed.
 *
 * WHY IT EXISTS. The WebKit localStorage of the desktop app keeps its journal
 * in WAL mode and WebKit never checkpoints it while the webview lives: on
 * 2026-09-05 `localstorage.sqlite3-wal` weighed **5.92 GB**, growing about
 * 100 MB a day. That number is not "how much we store" (the quota is 5 MB and
 * we live inside it), it is "how many times we rewrote it", and from outside
 * nothing says WHICH key does the rewriting. Guessing the hot key means fixing
 * the wrong one and measuring nothing.
 *
 * HOW. It wraps `localStorage.setItem`/`removeItem` and counts calls and bytes
 * PER KEY, sampling once a minute so the answer is a rate (bytes per minute)
 * and not a total, because a total cannot tell a boot from an hour of use. Key
 * names are reported with their volatile tail folded (`messages-cache-<id>`
 * becomes `messages-cache-*`), otherwise a thousand topics produce a thousand
 * rows and no answer.
 *
 * SAFETY. It never starts by itself: it reads `dev-storage-probe` from ui-state
 * and runs only if `{"armed": true}`, one shot, exactly like `devLayoutProbe`
 * and `devHeapProbe`. Nothing is wrapped when it is not armed, so the write
 * path of a normal session is untouched. The cost of that choice is that the
 * writes of the first few hundred milliseconds of boot (before the flag comes
 * back) are not counted: the boot is not the problem, the hour after it is.
 *
 * Use:
 *   curl -sk -X PUT https://localhost:3333/api/ui-state/dev-storage-probe \
 *        -H 'content-type: application/json' -d '{"armed":true}'
 *   (reload the window, then use the app normally for ten minutes)
 *   curl -sk https://localhost:3333/api/ui-state/dev-storage-probe-result
 */

const FLAG_KEY = 'dev-storage-probe';
const RESULT_KEY = 'dev-storage-probe-result';

/** One minute per sample, ten minutes of normal use plus the sample at T0. */
const SAMPLE_EVERY_MS = 60_000;
const SAMPLES = 11;

/** What one key cost during the run. */
export interface StorageKeyCost {
  /** How many `setItem` calls landed on this key. */
  writes: number;
  /** Sum of the lengths written. This is what gets appended to the journal. */
  bytes: number;
  /** How many `removeItem` calls: they touch the journal too. */
  removals: number;
  /** The largest single value written, in characters. */
  largest: number;
}

type CostTable = Record<string, StorageKeyCost>;

/**
 * Folds the volatile tail of a key family into one row.
 *
 * `messages-cache-<sessionKey>` and `board-rows-<projectId>` are one WRITER
 * each, not one per id: reported separately they hide the very thing the probe
 * is looking for, which is which writer is hot.
 */
export function foldKey(key: string): string {
  const families = ['messages-cache-', 'board-rows-', 'draft-', 'ask-draft-', 'composer-memory-'];
  for (const family of families) {
    if (key.startsWith(family)) return `${family}*`;
  }
  return key;
}

function blankCost(): StorageKeyCost {
  return { writes: 0, bytes: 0, removals: 0, largest: 0 };
}

/** A snapshot of the table, so a sample cannot be mutated after it is taken. */
function cloneTable(table: CostTable): CostTable {
  const out: CostTable = {};
  for (const [key, cost] of Object.entries(table)) out[key] = { ...cost };
  return out;
}

/** Total bytes across every key of a table. */
export function totalBytes(table: CostTable): number {
  let sum = 0;
  for (const cost of Object.values(table)) sum += cost.bytes;
  return sum;
}

/** Total `setItem` calls across every key of a table. */
export function totalWrites(table: CostTable): number {
  let sum = 0;
  for (const cost of Object.values(table)) sum += cost.writes;
  return sum;
}

async function readFlag(): Promise<boolean> {
  try {
    const r = await fetch(`/api/ui-state/${FLAG_KEY}`);
    if (!r.ok) return false;
    const body = (await r.json()) as { value?: { armed?: boolean } };
    return body?.value?.armed === true;
  } catch {
    return false;
  }
}

async function write(key: string, value: unknown): Promise<void> {
  try {
    await fetch(`/api/ui-state/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch {
    /* the probe must never make noise when the server does not answer */
  }
}

/**
 * Installs the counters on the live `localStorage`. Returns the table being
 * filled and the function that puts the original methods back.
 */
function instrument(): { table: CostTable; restore: () => void } {
  const table: CostTable = {};
  const proto = Storage.prototype;
  const originalSet = proto.setItem;
  const originalRemove = proto.removeItem;

  proto.setItem = function patchedSetItem(this: Storage, key: string, value: string): void {
    if (this === localStorage) {
      const row = (table[foldKey(key)] ??= blankCost());
      row.writes += 1;
      row.bytes += value.length;
      if (value.length > row.largest) row.largest = value.length;
    }
    originalSet.call(this, key, value);
  };

  proto.removeItem = function patchedRemoveItem(this: Storage, key: string): void {
    if (this === localStorage) {
      const row = (table[foldKey(key)] ??= blankCost());
      row.removals += 1;
    }
    originalRemove.call(this, key);
  };

  return {
    table,
    restore: () => {
      proto.setItem = originalSet;
      proto.removeItem = originalRemove;
    },
  };
}

/**
 * Starts the probe if it is armed. Returns an idempotent stop function.
 *
 * It samples in TIME and not once: one photograph says how much has been
 * written since boot, a series says how much is written PER MINUTE, and that
 * rate is the number the journal grows with.
 */
export function initDevStorageProbe(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let restore: (() => void) | null = null;
  let stopped = false;

  const shutdown = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (restore) {
      restore();
      restore = null;
    }
  };

  void readFlag().then((armed) => {
    if (!armed || stopped) return;
    void write(FLAG_KEY, { armed: false }); // one shot: never two runs in a row
    const probe = instrument();
    restore = probe.restore;
    const startedAt = Date.now();
    const series: {
      at: string;
      minute: number;
      writes: number;
      bytes: number;
      perKey: CostTable;
    }[] = [];
    let n = 0;

    const tick = (): void => {
      const minute = (Date.now() - startedAt) / 60_000;
      series.push({
        at: new Date().toISOString(),
        minute: Math.round(minute * 100) / 100,
        writes: totalWrites(probe.table),
        bytes: totalBytes(probe.table),
        perKey: cloneTable(probe.table),
      });
      n += 1;
      const elapsedMinutes = Math.max(minute, 1 / 60);
      void write(RESULT_KEY, {
        samples: n,
        startedAt: new Date(startedAt).toISOString(),
        bytesPerMinute: Math.round(totalBytes(probe.table) / elapsedMinutes),
        writesPerMinute: Math.round(totalWrites(probe.table) / elapsedMinutes),
        perKey: cloneTable(probe.table),
        series,
      });
      if (n >= SAMPLES) shutdown();
    };

    tick();
    timer = setInterval(tick, SAMPLE_EVERY_MS);
  });

  return () => {
    stopped = true;
    shutdown();
  };
}
