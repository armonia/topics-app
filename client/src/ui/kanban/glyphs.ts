/**
 * The glyphs of the kanban: one per stage (the family of the Board's column
 * glyphs) and one per kind of original a card carries.
 */
import { Monitor, CircleCheck, CircleDashed, CircleDot, Circle, ClipboardList, FileText, Gavel, Image as ImageIcon, Mail, Phone, Receipt, Sheet, type LucideIcon } from 'lucide-react';
import type { OriginalModel, StageGlyph } from './model';

export const STAGE_GLYPH: Record<StageGlyph, { icon: LucideIcon; className: string }> = {
  incoming: { icon: CircleDashed, className: 'text-app-text-tertiary' },
  working: { icon: CircleDot, className: 'text-sky-600 dark:text-sky-400' },
  check: { icon: CircleDot, className: 'text-amber-600 dark:text-amber-400' },
  approve: { icon: Circle, className: 'text-violet-600 dark:text-violet-400' },
  done: { icon: CircleCheck, className: 'text-emerald-600 dark:text-emerald-400' },
};

export const ORIGINAL_ICON: Record<OriginalModel['kind'], LucideIcon> = {
  mail: Mail,
  photo: ImageIcon,
  screen: Monitor,
  form: ClipboardList,
  invoice: Receipt,
  tender: Gavel,
  sheet: Sheet,
  letter: FileText,
  call: Phone,
};
