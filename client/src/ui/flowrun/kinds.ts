import { Bot, Eye, Plug, Send, Sparkles, Split, User, Zap, type LucideIcon } from 'lucide-react';
import type { Tone } from '../types';
import type { StepKind } from './model';

/** The icon and the colour of each kind of step. */
export const KIND_ICON: Record<StepKind | 'trigger', LucideIcon> = {
  trigger: Zap, classify: Sparkles, ai: Sparkles, rule: Split, robot: Bot, person: User, program: Plug, view: Eye, send: Send,
};

export const KIND_TONE: Record<StepKind | 'trigger', Tone> = {
  trigger: 'neutral', classify: 'pink', ai: 'pink', rule: 'blue', robot: 'green', person: 'amber', program: 'green', view: 'neutral', send: 'blue',
};
