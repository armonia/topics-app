import { CircleAlert, Clock, PenLine, Send, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Chip } from '../primitives/Chip';
import type { Tone } from '../types';

/** The glyph each state wears, by its tone: the same state reads the same in the list, the head and the versions. */
const STATE_ICON: Partial<Record<Tone, LucideIcon>> = {
  green: ShieldCheck,
  amber: Clock,
  blue: Send,
  red: CircleAlert,
  neutral: PenLine,
};

/** The state of a contract, a version or a variation: a chip with its glyph, always the same shape. */
export function StateChip({ tone = 'neutral', strong, children }: { tone?: Tone; strong?: boolean; children: ReactNode }) {
  return <Chip tone={tone} icon={STATE_ICON[tone] ?? PenLine} strong={strong}>{children}</Chip>;
}
