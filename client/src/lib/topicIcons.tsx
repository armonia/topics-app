import { memo } from 'react';
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
export const TOPIC_ICONS = [
  'MessageSquare', 'Lightbulb', 'Rocket', 'Flame', 'Star', 'Target',
  'Gem', 'Palette', 'Wrench', 'BookOpen', 'Sparkles', 'PenLine',
  'Music', 'Home', 'Heart', 'Lock', 'BarChart3', 'Globe',
  'Zap', 'Flower2', 'Code', 'Terminal', 'Briefcase', 'Camera',
  'Shield', 'Coffee', 'Bug', 'Cpu', 'Brain', 'Megaphone',
];

/** Get a Lucide component by icon name. Falls back to MessageSquare for unknown names (including legacy emoji). */
export function getTopicIcon(name: string): LucideIcon {
  return ICON_MAP[name] || ICON_MAP[DEFAULT_TOPIC_ICON];
}

/** Get a random icon name for new topics. */
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
  const Icon = getTopicIcon(name);
  return <Icon size={size} style={color ? { color } : undefined} className={className} />;
});
