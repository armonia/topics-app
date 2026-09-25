import { memo, useCallback, useSyncExternalStore } from 'react';
import { useT } from '../../hooks/useT';
import { getStreamTokenRate, subscribeStreamTokenRate } from '../../state/streamTokenRate';

/**
 * One item of the turn's meta row, next to the timer, the tokens and the cost,
 * with its own leading `·`. That is where it was asked to live (23/09): under
 * the composer it was a number about the ANSWER sitting where you write the
 * next question.
 */
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
      className={`flex-shrink-0 text-mini tabular-nums ${
        actual ? 'text-emerald-600 dark:text-emerald-400' : 'text-app-text-muted'
      }`}
      title={title}
      aria-label={tr(actual ? 'chat.tokenRate.actualAria' : 'chat.tokenRate.estimatedAria', { rate })}
    >
      {actual ? `· ${rate} tok/s` : `· ≈ ${rate} tok/s`}
    </span>
  );
}

export const StreamTokenRateIndicator = memo(StreamTokenRateIndicatorComponent);
