import { effortBadgeLabel } from '../../lib/effortBadgeLabel';

/**
 * The always-visible effort chip. It never disappears: with provider Automatic
 * no tier is known and it reads "auto" (card 067a1f5b). An override is the
 * user's choice and shows in the primary colour, the provider default is muted.
 */
export function EffortBadge({
  tier,
  overridden,
  testId = 'session-effort-badge',
  className = '',
}: {
  tier: string | null | undefined;
  overridden: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-effort-source={overridden ? 'override' : 'default'}
      className={`text-center text-mini uppercase tracking-wide px-1 py-0.5 rounded font-semibold tabular-nums ${
        overridden ? 'bg-primary/30 text-primary' : 'bg-app-hover/60 text-app-text-muted'
      } ${className}`}
    >
      {effortBadgeLabel(tier)}
    </span>
  );
}
