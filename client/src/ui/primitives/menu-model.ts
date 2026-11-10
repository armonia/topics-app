/**
 * The data of a menu: its items and the optional header of someone's menu.
 * Kept apart from `Menu.tsx` so plain-data models (`ui/types.ts`, read by the
 * server's type check too) can name them without pulling in a component file.
 */
import type { LucideIcon } from 'lucide-react';

export interface MenuItemModel {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Quiet text on the right: a shortcut, a count, a note. */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Why the item is off, or what it does, on hover. */
  title?: string;
  /** A hairline between groups; its label is not shown. */
  separator?: boolean;
  /**
   * Set (true or false) the item is a choice among its neighbours: it becomes a
   * `menuitemradio`, ticked when true. Left out, it is a plain action.
   */
  checked?: boolean;
  /** A caption over the items that follow, not a thing to pick. */
  heading?: boolean;
}

/** The top of a menu that belongs to someone: their avatar, name and one line under it. */
export interface MenuHeaderModel {
  /** Present: the header is itself an item and is picked like one. */
  id?: string;
  /** The initials in the avatar. */
  monogram: string;
  color: string;
  title: string;
  detail?: string;
}
