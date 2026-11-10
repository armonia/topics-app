import {
  BookOpen, CalendarDays, ChartColumn, Database, Eye, File, Folder, Hash, IdCard, Inbox, Kanban, Link, Mail,
  MessageSquare, Plug, Scale, Settings, User, Workflow, Zap, FileText, Plus, Construction, Sun, Headset, Search, Building2, Handshake, Users, type LucideIcon,
} from 'lucide-react';
import type { FieldKind, NavKind, UiTabKind, Tone } from './types';

/** One glyph per kind of data, the only icon system of the layer (Lucide). */
export const FIELD_ICON: Record<FieldKind, LucideIcon> = {
  mail: Mail,
  file: File,
  legal: Scale,
  record: IdCard,
  number: Hash,
  folder: Folder,
  calendar: CalendarDays,
  person: User,
  link: Link,
  bolt: Zap,
};

/** The tint a field glyph takes, so a kind is recognised before it is read. */
export const FIELD_TONE: Record<FieldKind, Tone> = {
  mail: 'blue',
  file: 'neutral',
  legal: 'violet',
  record: 'amber',
  number: 'neutral',
  folder: 'red',
  calendar: 'blue',
  person: 'amber',
  link: 'neutral',
  bolt: 'neutral',
};

export const NAV_ICON: Record<NavKind, LucideIcon> = {
  inbox: Inbox,
  flows: Workflow,
  data: Database,
  knowledge: BookOpen,
  views: Eye,
  channels: Mail,
  programs: Plug,
  overview: ChartColumn,
  settings: Settings,
  assistant: MessageSquare,
  records: FileText,
  today: Sun,
  callcenter: Headset,
  contracts: Handshake,
  team: Users,
};

export const TAB_ICON: Record<UiTabKind, LucideIcon> = {
  flows: Workflow,
  record: FileText,
  board: Kanban,
  data: Database,
  knowledge: BookOpen,
  overview: ChartColumn,
  views: Eye,
  inbox: Inbox,
  new: Plus,
  other: Construction,
  today: Sun,
  settings: Settings,
  channels: Mail,
  programs: Plug,
  chat: MessageSquare,
  callcenter: Headset,
  search: Search,
  org: Building2,
  contracts: Handshake,
  team: Users,
};
