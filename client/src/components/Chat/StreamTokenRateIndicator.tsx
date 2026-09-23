import { memo, useCallback, useSyncExternalStore } from 'react';
import { useT } from '../../hooks/useT';
import { getStreamTokenRate, subscribeStreamTokenRate } from '../../state/streamTokenRate';

interface StreamTokenRateIndicatorProps {
  sessionKey: string;
}

function formatRate(rate: number): string {
  return rate.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function StreamTokenRateIndicatorComponent({ sessionKey }: StreamTokenRateIndicatorProps) {
  const tr = useT();
  const subscribe = useCallback(
    (listener: () => void) => subscribeStreamTokenRate(sessionKey, listener),
    [sessionKey],
  );
  const getSnapshot = useCallback(() => getStreamTokenRate(sessionKey), [sessionKey]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (snapshot.mode === 'hidden' || snapshot.tokensPerSecond == null) return null;

  const rate = formatRate(snapshot.tokensPerSecond);
  const seconds = (snapshot.elapsedMs / 1_000).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const actual = snapshot.mode === 'actual';
  const title = actual
    ? tr('chat.tokenRate.actualTitle', {
        tokens: snapshot.actualTokens ?? 0,
        seconds,
        estimated: snapshot.estimatedTokens,
        difference: snapshot.differencePercent ?? 0,
      })
    : tr(snapshot.streaming ? 'chat.tokenRate.estimatedTitle' : 'chat.tokenRate.finalEstimateTitle');

  return (
    <span
      data-testid="stream-token-rate"
      data-rate-source={actual ? 'usage' : 'text-estimate'}
      data-streaming={snapshot.streaming ? 'true' : 'false'}
      className={`inline-flex h-8 flex-shrink-0 items-center rounded-lg px-2 text-mini font-medium tabular-nums ${
        actual ? 'text-emerald-600 dark:text-emerald-400' : 'text-app-text-muted'
      }`}
      title={title}
      aria-label={tr(actual ? 'chat.tokenRate.actualAria' : 'chat.tokenRate.estimatedAria', { rate })}
    >
      {actual ? `${rate} tok/s · usage` : `≈ ${rate} tok/s`}
    </span>
  );
}

export const StreamTokenRateIndicator = memo(StreamTokenRateIndicatorComponent);
