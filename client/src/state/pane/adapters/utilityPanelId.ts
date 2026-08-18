/**
 * Utility-pane id adapter — pure helpers for the `__<type>__` pane-id form the
 * App-level utility tabs use (Board generale, Statistics, Cron).
 *
 * CANONICAL home of these helpers. They were colocated with the UtilityPanel
 * component, but pure libs (buildSidebarItems) must not import a component
 * module to parse an id — UtilityPanel.tsx re-exports these for its existing
 * importers, so both worlds read one implementation.
 */

/**
 * I tre tipi, come INSIEME e non solo come unione di tipi. Serve a runtime:
 * il bus `topics:open-utility` ha un mittente (il «+» delle tab) e un
 * ricevitore (il lifecycle di App), ed entrambi elencavano i tipi a mano. Il
 * mittente ne aveva UNO — quando Dashboard e Cron sono entrate nel menu «+», le
 * loro righe comparivano e non facevano niente: un no-op silenzioso.
 *
 * L'unione è derivata dall'insieme, non viceversa, così aggiungerne un quarto
 * è una modifica sola.
 */
export const UTILITY_PANEL_TYPES = ['dashboard', 'cron', 'board', 'profile'] as const;

export type UtilityPanelType = (typeof UTILITY_PANEL_TYPES)[number];

/** Il tipo è una pane utility? (Guardia a runtime per il bus.) */
export function isUtilityPanelType(type: string): type is UtilityPanelType {
  return (UTILITY_PANEL_TYPES as readonly string[]).includes(type);
}

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
