import { Menu, type MenuHeaderModel, type MenuItemModel } from '../primitives/Menu';

/**
 * The menu of the person at the foot of the sidebar: what is theirs alone (how
 * the app looks, what reaches them, who they are using it as). It stands over
 * the identity row, 8px from the left and 48px from the bottom, as the persona
 * menu does; a header with their avatar, name and team opens their profile.
 * Arrows move, Enter picks, Escape or a click outside closes; the choices
 * (theme) are items with `checked`.
 */
export function UserMenu({ header, items, onSelect, onClose, ariaLabel }: {
  header: MenuHeaderModel;
  items: MenuItemModel[];
  onSelect: (id: string) => void;
  onClose: () => void;
  ariaLabel: string;
}) {
  return (
    /* A zero-height anchor on the window: the menu stands on top of it, growing upward. */
    <div className="fixed bottom-12 left-2 h-0 w-0">
      <Menu header={header} items={items} ariaLabel={ariaLabel} side="above" className="w-[272px]" onSelect={onSelect} onClose={onClose} />
    </div>
  );
}
