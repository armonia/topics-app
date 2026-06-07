import { createElement, memo } from 'react';
import {
  MessageSquare, Lightbulb, Rocket, Flame, Star, Target,
  Gem, Palette, Wrench, BookOpen, Sparkles, PenLine,
  Music, Home, Heart, Lock, BarChart3, Globe,
  Zap, Flower2, Code, Terminal, Briefcase, Camera,
  Shield, Coffee, Bug, Cpu, Brain, Megaphone,
  Search,
  type LucideIcon,
} from 'lucide-react';

export const DEFAULT_TOPIC_ICON = 'MessageSquare';

const ICON_MAP: Record<string, LucideIcon> = {
  MessageSquare,
  Lightbulb,
  Rocket,
  Flame,
  Star,
  Target,
  Gem,
  Palette,
  Wrench,
  BookOpen,
  Sparkles,
  PenLine,
  Music,
  Home,
  Heart,
  Lock,
  BarChart3,
  Globe,
  Zap,
  Flower2,
  Code,
  Terminal,
  Briefcase,
  Camera,
  Shield,
  Coffee,
  Bug,
  Cpu,
  Brain,
  Megaphone,
  Search,
};

/** All available icon names for the picker (excludes Search which is template-only) */
// eslint-disable-next-line react-refresh/only-export-components -- icon name list is colocated with TopicIcon (shares the lucide ICON_MAP); used by 6+ importers, splitting it out would fragment a cohesive module for a dev-only HMR hint
export const TOPIC_ICONS = [
  'MessageSquare', 'Lightbulb', 'Rocket', 'Flame', 'Star', 'Target',
  'Gem', 'Palette', 'Wrench', 'BookOpen', 'Sparkles', 'PenLine',
  'Music', 'Home', 'Heart', 'Lock', 'BarChart3', 'Globe',
  'Zap', 'Flower2', 'Code', 'Terminal', 'Briefcase', 'Camera',
  'Shield', 'Coffee', 'Bug', 'Cpu', 'Brain', 'Megaphone',
];

/** Get a Lucide component by icon name. Falls back to MessageSquare for unknown names (including legacy emoji). */
// eslint-disable-next-line react-refresh/only-export-components -- resolver colocated with TopicIcon over the shared ICON_MAP; idiomatic to keep with the component, dev-only HMR hint
export function getTopicIcon(name: string): LucideIcon {
  return ICON_MAP[name] || ICON_MAP[DEFAULT_TOPIC_ICON];
}

/** Get a random icon name for new topics. */
// eslint-disable-next-line react-refresh/only-export-components -- helper colocated with TopicIcon's icon set (reads TOPIC_ICONS); dev-only HMR hint, keeping it with the icon module is idiomatic
export function getRandomTopicIcon(): string {
  return TOPIC_ICONS[Math.floor(Math.random() * TOPIC_ICONS.length)];
}

/** Render a topic icon by name. Memoized for performance in lists. */
export const TopicIcon = memo(function TopicIcon({
  name,
  size = 14,
  color,
  className,
}: {
  name: string;
  size?: number;
  color?: string;
  className?: string;
}) {
  // Resolve the Lucide component from the static ICON_MAP and render via
  // createElement. `getTopicIcon` returns a stable module-level component
  // (never one defined during render), but aliasing it to a PascalCase local
  // and rendering `<Icon/>` trips react-hooks/static-components; createElement
  // is the equivalent, lint-clean form with identical output.
  const Icon = getTopicIcon(name);
  return createElement(Icon, { size, style: color ? { color } : undefined, className });
});
