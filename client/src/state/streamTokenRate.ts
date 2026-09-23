export const TOKEN_RATE_WINDOW_MS = 2_500;
export const TOKEN_RATE_PUBLISH_MS = 250;

export interface StreamTokenRateSnapshot {
  mode: 'hidden' | 'estimated' | 'actual';
  streaming: boolean;
  tokensPerSecond: number | null;
  estimatedTokens: number;
  actualTokens: number | null;
  differencePercent: number | null;
  elapsedMs: number;
}

interface TokenSample {
  at: number;
  total: number;
}

interface TokenRateEntry {
  live: boolean;
  firstChunkAt: number | null;
  totalCharacters: number;
  samples: TokenSample[];
  snapshot: StreamTokenRateSnapshot;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

const HIDDEN_SNAPSHOT: StreamTokenRateSnapshot = Object.freeze({
  mode: 'hidden',
  streaming: false,
  tokensPerSecond: null,
  estimatedTokens: 0,
  actualTokens: null,
  differencePercent: null,
  elapsedMs: 0,
});

const entries = new Map<string, TokenRateEntry>();

function entryFor(sessionKey: string): TokenRateEntry {
  let entry = entries.get(sessionKey);
  if (!entry) {
    entry = {
      live: false,
      firstChunkAt: null,
      totalCharacters: 0,
      samples: [],
      snapshot: HIDDEN_SNAPSHOT,
      listeners: new Set(),
      timer: null,
    };
    entries.set(sessionKey, entry);
  }
  return entry;
}

function notify(entry: TokenRateEntry): void {
  for (const listener of entry.listeners) listener();
}

function estimatedTokenCount(characters: number): number {
  return Math.round(characters / 4);
}

function roundedRate(tokens: number, elapsedMs: number): number | null {
  if (elapsedMs < TOKEN_RATE_PUBLISH_MS) return null;
  return Math.round((tokens * 1_000 / elapsedMs) * 10) / 10;
}

export function refreshStreamTokenRate(sessionKey: string, now = Date.now()): void {
  const entry = entries.get(sessionKey);
  if (!entry?.live || entry.firstChunkAt == null) return;

  const cutoff = now - TOKEN_RATE_WINDOW_MS;
  while (entry.samples.length > 1 && entry.samples[1].at <= cutoff) entry.samples.shift();

  const baseline = entry.samples[0] ?? { at: entry.firstChunkAt, total: 0 };
  const total = estimatedTokenCount(entry.totalCharacters);
  const elapsedMs = Math.max(0, now - Math.max(baseline.at, cutoff));
  const tokensInWindow = Math.max(0, total - baseline.total);
  const next: StreamTokenRateSnapshot = {
    mode: 'estimated',
    streaming: true,
    tokensPerSecond: roundedRate(tokensInWindow, elapsedMs),
    estimatedTokens: total,
    actualTokens: null,
    differencePercent: null,
    elapsedMs: Math.max(0, now - entry.firstChunkAt),
  };
  const previous = entry.snapshot;
  if (
    previous.mode !== next.mode ||
    previous.streaming !== next.streaming ||
    previous.tokensPerSecond !== next.tokensPerSecond ||
    previous.estimatedTokens !== next.estimatedTokens ||
    previous.elapsedMs !== next.elapsedMs
  ) {
    entry.snapshot = next;
    notify(entry);
  }
}

function schedulePublish(sessionKey: string): void {
  const entry = entries.get(sessionKey);
  if (!entry?.live || entry.timer != null) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    refreshStreamTokenRate(sessionKey);
    schedulePublish(sessionKey);
  }, TOKEN_RATE_PUBLISH_MS);
}

/** Start a turn without waking subscribers until the first generated text arrives. */
export function beginStreamTokenRate(sessionKey: string): void {
  const entry = entryFor(sessionKey);
  if (entry.live) return;
  if (entry.timer != null) clearTimeout(entry.timer);
  entry.live = true;
  entry.firstChunkAt = null;
  entry.totalCharacters = 0;
  entry.samples = [];
  entry.timer = null;
  if (entry.snapshot !== HIDDEN_SNAPSHOT) {
    entry.snapshot = HIDDEN_SNAPSHOT;
    notify(entry);
  }
}

/**
 * Count generated text, not transport chunks. Providers split chunks at
 * different boundaries, while the text-length estimate stays comparable.
 */
export function recordStreamText(sessionKey: string, text: string, at = Date.now()): void {
  if (!text) return;
  const entry = entries.get(sessionKey);
  if (!entry?.live) return;
  if (entry.firstChunkAt == null) {
    entry.firstChunkAt = at;
    entry.samples.push({ at, total: 0 });
    entry.snapshot = {
      mode: 'estimated',
      streaming: true,
      tokensPerSecond: null,
      estimatedTokens: 0,
      actualTokens: null,
      differencePercent: null,
      elapsedMs: 0,
    };
    notify(entry);
  }
  entry.totalCharacters += text.length;
  entry.samples.push({ at, total: estimatedTokenCount(entry.totalCharacters) });
  schedulePublish(sessionKey);
}

/** Replace the live text estimate with provider-reported output usage. */
export function finishStreamTokenRate(
  sessionKey: string,
  actualOutputTokens?: number | null,
  at = Date.now(),
): void {
  const entry = entries.get(sessionKey);
  if (!entry) return;
  if (!entry.live && entry.snapshot.mode === 'actual') return;
  if (!entry.live && actualOutputTokens == null) return;
  if (entry.timer != null) clearTimeout(entry.timer);
  entry.timer = null;

  const firstChunkAt = entry.firstChunkAt;
  const elapsedMs = firstChunkAt == null ? 0 : Math.max(0, at - firstChunkAt);
  const estimatedTokens = estimatedTokenCount(entry.totalCharacters);
  const hasActual = typeof actualOutputTokens === 'number' && Number.isFinite(actualOutputTokens) && actualOutputTokens >= 0;
  const actualTokens = hasActual ? actualOutputTokens : null;
  const tokens = actualTokens ?? estimatedTokens;
  const differencePercent = actualTokens != null && actualTokens > 0
    ? Math.round((Math.abs(actualTokens - estimatedTokens) / actualTokens) * 1_000) / 10
    : null;
  entry.live = false;
  entry.snapshot = firstChunkAt == null
    ? HIDDEN_SNAPSHOT
    : {
        mode: actualTokens == null ? 'estimated' : 'actual',
        streaming: false,
        tokensPerSecond: roundedRate(tokens, elapsedMs),
        estimatedTokens,
        actualTokens,
        differencePercent,
        elapsedMs,
      };
  notify(entry);
}

export function subscribeStreamTokenRate(sessionKey: string, listener: () => void): () => void {
  const entry = entryFor(sessionKey);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

export function getStreamTokenRate(sessionKey: string): StreamTokenRateSnapshot {
  return entries.get(sessionKey)?.snapshot ?? HIDDEN_SNAPSHOT;
}

export function forgetStreamTokenRate(sessionKey: string): void {
  const entry = entries.get(sessionKey);
  if (entry?.timer != null) clearTimeout(entry.timer);
  entries.delete(sessionKey);
}
