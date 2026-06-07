import { useState, useEffect, useMemo } from 'react';
import { basename } from '@/lib/path-utils';

/** A single line item in the `/api/context` token breakdown. */
interface ContextBreakdownEntry {
  label?: string;
  description?: string;
  tokens?: number;
}

interface ContextTokenResponse {
  breakdown?: ContextBreakdownEntry[];
}

/** Hook to fetch token estimates for context files */
export function useContextFileTokens(sessionKey: string, filePaths: string[]): Map<string, number> {
  const [tokenMap, setTokenMap] = useState<Map<string, number>>(new Map());
  const filePathsKey = useMemo(() => filePaths.join(','), [filePaths]);

  useEffect(() => {
    if (!filePaths.length) { setTokenMap(new Map()); return; }

    fetch(`/api/context?sessionKey=${encodeURIComponent(sessionKey)}`)
      .then(r => r.json() as Promise<ContextTokenResponse>)
      .then((data) => {
        const map = new Map<string, number>();
        // Try to extract per-file tokens from breakdown description
        const contextBreakdown = data.breakdown?.find((b) =>
          b.label === 'Context files' && b.description
        );
        if (contextBreakdown?.description) {
          const parts = contextBreakdown.description.split(', ');
          for (const part of parts) {
            const match = part.match(/^(.+?):\s*~?(\d+)\s*tokens?$/);
            if (match) {
              const fname = match[1];
              const tokens = parseInt(match[2], 10);
              const matchingPath = filePaths.find(p => p.endsWith(fname) || basename(p) === fname);
              if (matchingPath) map.set(matchingPath, tokens);
            }
          }
        }
        // Fallback: distribute evenly if no per-file info
        if (map.size === 0 && contextBreakdown?.tokens && filePaths.length > 0) {
          const perFile = Math.round(contextBreakdown.tokens / filePaths.length);
          for (const p of filePaths) map.set(p, perFile);
        }
        setTokenMap(map);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally key on the joined `filePathsKey` (not the `filePaths` array identity) so a new-but-equal array does not re-trigger the fetch
  }, [sessionKey, filePathsKey]);

  return tokenMap;
}
