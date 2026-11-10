import type { LucideIcon } from 'lucide-react';
import type { Tone } from '../types';

/** The five columns of the Board, in order. */
export type BoardColumnId = 'backlog' | 'todo' | 'progress' | 'review' | 'done';

export interface BoardChipModel {
  id: string;
  text: string;
  tone: Tone;
  icon?: LucideIcon;
}

export interface BoardCardModel {
  id: string;
  /** The organization that owns it: its monogram and colour open the card's line. */
  org: { id: string; name: string; monogram: string; color: string };
  /** The kind of work, after the organization name. */
  area: string;
  title: string;
  chips: BoardChipModel[];
  /** The columns the card may be moved to (never its own). */
  moveTo: BoardColumnId[];
}

export interface BoardColumnModel {
  id: BoardColumnId;
  label: string;
  cards: BoardCardModel[];
}

/** One filter chip: an organization, with how many cards it has under the current search. */
export interface BoardOrgChipModel {
  id: string;
  label: string;
  count: number;
  tone: Tone;
}
