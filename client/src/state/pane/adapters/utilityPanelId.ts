/**
 * Utility-pane id adapter — pure helpers for the `__<type>__` pane-id form the
 * App-level utility tabs use (Board generale, Statistics, Activity, Journal,
 * Agents, Cron).
 *
 * CANONICAL home of these helpers. They were colocated with the UtilityPanel
 * component, but pure libs (buildSidebarItems) must not import a component
 * module to parse an id — UtilityPanel.tsx re-exports these for its existing
 * importers, so both worlds read one implementation.
 */

export type UtilityPanelType = 'activity' | 'agents' | 'dashboard' | 'journal' | 'cron' | 'board';

export const UTILITY_PREFIX = '__';

export function isUtilityPanelId(id: string): boolean {
  return id.startsWith(UTILITY_PREFIX) && id.endsWith('__');
}

export function utilityPanelId(type: UtilityPanelType): string {
  return `${UTILITY_PREFIX}${type}__`;
}

export function parseUtilityPanelType(id: string): UtilityPanelType | null {
  if (!isUtilityPanelId(id)) return null;
  return id.slice(UTILITY_PREFIX.length, -2) as UtilityPanelType;
}
