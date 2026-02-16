import type { PaneType } from '../types';

export interface PaneConfig {
  icon: string;      // Lucide icon name
  label: string;
  color: string;     // Accent color
  singleton?: boolean; // Only one instance allowed per project
}

export const PANE_CONFIG: Record<PaneType, PaneConfig> = {
  chat:     { icon: 'MessageSquare', label: 'Chat',     color: '#0066ff' },
  file:     { icon: 'FileCode',      label: 'File',     color: '#f59e0b' },
  files:    { icon: 'FolderTree',    label: 'Files',    color: '#f59e0b', singleton: true },
  browser:  { icon: 'Globe',         label: 'Browser',  color: '#10b981' },
  terminal: { icon: 'Terminal',      label: 'Terminal',  color: '#8b5cf6' },
  git:      { icon: 'GitBranch',     label: 'Git',      color: '#ef4444', singleton: true },
  activity: { icon: 'Activity',      label: 'Activity', color: '#06b6d4', singleton: true },
  journal:  { icon: 'BookOpen',      label: 'Journal',  color: '#f97316', singleton: true },
  agents:   { icon: 'Cpu',           label: 'Agents',   color: '#8b5cf6', singleton: true },
};

export function createPaneId(type: PaneType, topicId?: string): string {
  if (type === 'chat' && topicId) return `chat:${topicId}`;
  return `${type}:${Date.now()}`;
}

export function parsePaneId(id: string): { type: PaneType; key: string } {
  const [type, ...rest] = id.split(':');
  return { type: type as PaneType, key: rest.join(':') };
}

let _groupCounter = 0;
export function createGroupId(): string {
  return `group:${Date.now()}-${++_groupCounter}`;
}
