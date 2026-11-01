/**
 * Text of the always-visible effort chip (chat bar and task drawer).
 * With provider Automatic no tier is known: the chip says "auto" instead of
 * disappearing, so the effort in force never needs a menu to be read (card 067a1f5b).
 */
export function effortBadgeLabel(tier: string | null | undefined): string {
  return tier ? tier : "auto";
}
