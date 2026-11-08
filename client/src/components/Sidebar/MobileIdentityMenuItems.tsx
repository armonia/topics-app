/**
 * THE IDENTITY BLOCK ON THE PHONE, at the top of the title menu (USERMENU-09).
 *
 * The phone has no user card, so its title menu is the user menu: this mounts
 * the same `IdentityMenuItems` the desktop card's menu holds, with its data read
 * here, which means only while the title menu is open.
 */
import { useIdentityMenuData } from '@/hooks/useIdentityMenuData';
import type { UserMenuLevel } from '@/lib/openUserMenu';
import { IdentityMenuItems } from './IdentityMenuItems';

/** The width the identity block's levels are laid out for (the desktop
 *  menu's floor); on the phone they open as sheets, full width. */
const LEVEL_WIDTH = 288;

export function MobileIdentityMenuItems({ onClose, openLevel = null }: {
  onClose: () => void;
  openLevel?: UserMenuLevel | null;
}) {
  const identity = useIdentityMenuData();
  if (identity.session.status !== 'paired') return null;
  return <IdentityMenuItems data={identity} width={LEVEL_WIDTH} onClose={onClose} openLevel={openLevel} />;
}
