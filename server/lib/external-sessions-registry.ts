/**
 * The census of **all** the external sessions, whichever CLI opened them.
 *
 * WHY IT EXISTS
 * Until 08/23 the census was a single function, which knew how to read Claude
 * Code's format. It looked generic because it was called «external sessions»,
 * but it answered a narrower question: «which CLAUDE CODE sessions are open».
 * The jcode sessions — 1375 on disk, seven live processes — showed up neither
 * in the total nor among the ones at work, and presence declared «no agent at
 * work» while the user was looking at three of them.
 *
 * The defect was not «jcode is missing»: it was that one provider was written
 * inside the function instead of next to the others. Here the providers are a
 * LIST, and adding one is adding a line.
 *
 * HOW TO ADD A PROVIDER
 * It takes a function that returns `ExternalClaudeSession[]` by reading where
 * that CLI keeps its sessions, and one line in `PROVIDERS`. Two rules that
 * cost dearly if skipped:
 *
 *  1. **Freshness is read where that CLI writes it.** Claude Code writes one
 *     event per line, so the file's mtime says «just now». jcode rewrites a
 *     JSON at the end of a turn, so the mtime says «when it finished»:
 *     measured, ZERO jcode sessions look touched in the last 15 minutes while
 *     they are working. Copying the neighbour's criterion produces a provider
 *     that always looks idle.
 *
 *  2. **A provider that blows up must not switch off the others.** Every
 *     scanner runs inside a try: a half-installed CLI makes its own sessions
 *     disappear, not the census.
 */

import type { ExternalClaudeSession, ScanOptions } from "./external-claude-sessions";
import { scanExternalClaudeSessions } from "./external-claude-sessions";
import { scanCodexSessions } from "./external-codex-sessions";
import { scanJcodeSessions } from "./external-jcode-sessions";

/** One scanner: from common options to the sessions that CLI has opened. */
export interface SessionProvider {
  /** The name that shows up in the diagnostics. */
  name: string;
  scan: (opts: ScanOptions) => ExternalClaudeSession[];
}

export const PROVIDERS: SessionProvider[] = [
  { name: "claude-code", scan: scanExternalClaudeSessions },
  {
    name: "jcode",
    scan: (opts) =>
      scanJcodeSessions({
        now: opts.nowMs,
        activeMs: opts.activeMs,
        windowMs: opts.windowMs,
        candidatePaths: opts.candidatePaths,
        projectIdFor: opts.projectIdFor,
      }),
  },
  {
    name: "codex",
    scan: (opts) =>
      scanCodexSessions({
        now: opts.nowMs,
        activeMs: opts.activeMs,
        windowMs: opts.windowMs,
        knownSessionIds: opts.knownSessionIds,
        candidatePaths: opts.candidatePaths,
        projectIdFor: opts.projectIdFor,
      }),
  },
];

export interface ScanAllOptions extends ScanOptions {
  /** The providers to query. Injectable for the tests. */
  providers?: SessionProvider[];
  /** Where a single provider's errors end up. */
  log?: (msg: string, err?: unknown) => void;
}

/**
 * Queries every provider and returns the union, most recent first.
 *
 * The sessions Topics already owns (`knownSessionIds`) stay out: «external»
 * are only the ones that no other Topics surface is already showing.
 */
export function scanAllExternalSessions(opts: ScanAllOptions): ExternalClaudeSession[] {
  const providers = opts.providers ?? PROVIDERS;
  const log = opts.log ?? (() => {});

  const out: ExternalClaudeSession[] = [];
  const seen = new Set<string>();

  for (const p of providers) {
    let found: ExternalClaudeSession[] = [];
    try {
      found = p.scan(opts);
    } catch (err) {
      // A broken provider costs ITS OWN sessions, not all the others.
      log(`scanner "${p.name}" fallito`, err);
      continue;
    }
    for (const s of found) {
      // Same session seen by two providers: whoever found it first wins, that
      // is the order of PROVIDERS. It does not happen today, but a duplicated
      // id would silently inflate the count.
      if (seen.has(s.sessionId)) continue;
      if (opts.knownSessionIds.has(s.sessionId)) continue;
      seen.add(s.sessionId);
      out.push(s);
    }
  }

  return out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}
