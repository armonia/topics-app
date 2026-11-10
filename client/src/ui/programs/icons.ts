import { Database, FileInput, Globe, Link, Monitor, Plug, type LucideIcon } from 'lucide-react';
import type { ConnectionKind } from './model';

/** One glyph per way of connecting, the same in the list, the chips and the tabs. */
export const CONNECTION_ICON: Record<ConnectionKind, LucideIcon> = {
  browser: Globe,
  'pc-agent': Monitor,
  api: Link,
  'mcp-official': Plug,
  'mcp-open': Plug,
  database: Database,
  imap: Link,
  file: FileInput,
};
