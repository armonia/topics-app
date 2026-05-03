/**
 * StatusDot — sample component built on the Phase G dashboard tokens.
 *
 * Eight-state status indicator (online / offline / pending / etc.) using
 * the new `--color-functional-*` tokens and the standard radius ladder.
 * Demonstrates how new components opt into the design-system layer
 * without touching legacy --app-* tokens.
 *
 * Usage:
 *   <StatusDot state="online" />
 *   <StatusDot state="error" pulse />
 *   <StatusDot state="idle" size="sm" />
 */
import type { CSSProperties } from 'react';

type StatusState =
  | 'online'
  | 'offline'
  | 'pending'
  | 'busy'
  | 'idle'
  | 'error'
  | 'success'
  | 'unknown';

interface StatusDotProps {
  state: StatusState;
  /** Add a subtle dot-pulse animation (uses Phase G `dot-pulse` keyframe). */
  pulse?: boolean;
  size?: 'xs' | 'sm' | 'md';
  /** Accessible label. Defaults to the state name. */
  label?: string;
  className?: string;
}

const sizeClass: Record<NonNullable<StatusDotProps['size']>, string> = {
  xs: 'h-1.5 w-1.5',
  sm: 'h-2 w-2',
  md: 'h-2.5 w-2.5',
};

const stateColor: Record<StatusState, CSSProperties> = {
  online:  { backgroundColor: 'hsl(var(--color-functional-positive))' },
  success: { backgroundColor: 'hsl(var(--color-functional-positive))' },
  pending: { backgroundColor: 'hsl(var(--color-functional-warning))' },
  busy:    { backgroundColor: 'hsl(var(--color-functional-warning))' },
  error:   { backgroundColor: 'hsl(var(--color-functional-negative))' },
  offline: { backgroundColor: 'hsl(var(--dashboard-text-muted) / 0.5)' },
  idle:    { backgroundColor: 'hsl(var(--dashboard-text-muted) / 0.3)' },
  unknown: { backgroundColor: 'hsl(var(--dashboard-text-muted) / 0.4)' },
};

export function StatusDot({
  state,
  pulse = false,
  size = 'sm',
  label,
  className = '',
}: StatusDotProps) {
  const ariaLabel = label ?? state;
  const klass = `inline-block rounded-full ${sizeClass[size]} ${pulse ? 'animate-dot-pulse' : ''} ${className}`.trim();
  return (
    <span
      role="status"
      aria-label={ariaLabel}
      title={ariaLabel}
      className={klass}
      style={stateColor[state]}
    />
  );
}
