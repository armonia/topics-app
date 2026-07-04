import { Menu } from './Menu';

interface DropdownPortalProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: React.ReactNode;
  align?: 'left' | 'right';
}

/**
 * DropdownPortal — retained as a thin, API-compatible wrapper over the `Menu`
 * primitive. Its five call-sites (TopicTree, TopicItem, BrowserToolbar,
 * BreadcrumbNav) keep the exact same props but now inherit, for free, the flip/
 * clamp placement, Escape + capture-phase outside-close, roving keyboard nav,
 * `role="menu"`, focus-restore and the `Z_POPOVER` token that `Menu` provides.
 * New code should import `Menu` directly; this shim exists so the migration
 * needs no changes at those call-sites.
 */
export function DropdownPortal({ open, anchorRef, onClose, children, align = 'right' }: DropdownPortalProps) {
  return (
    <Menu open={open} anchorRef={anchorRef} onClose={onClose} align={align} minWidth={150}>
      {children}
    </Menu>
  );
}
