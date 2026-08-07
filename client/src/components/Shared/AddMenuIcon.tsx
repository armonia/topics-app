import { ClaudeIcon } from './ClaudeIcon';
import { CodexIcon } from './CodexIcon';
import type { AddMenuItem } from './addMenuItems';

/**
 * Dipinge l'icona di una voce del menu "New". Un solo punto, così le righe del
 * menu e le pill di ⌘K non possono più mostrare due glifi diversi per la stessa
 * cosa.
 *
 * Vive qui e non accanto a `buildAddMenuItems` per una ragione meccanica: un
 * file che esporta SIA un componente SIA altro spegne il fast refresh di Vite —
 * al salvataggio ricarica la pagina invece di sostituire il componente in posto
 * (`react-refresh/only-export-components`, che in CI è un errore, non un
 * consiglio). La separazione segue comunque il confine che il modulo dichiara
 * già da sé: lì c'è il MODELLO del menu, qui la RESA.
 */
export function AddMenuIcon({ item, size }: { item: AddMenuItem; size: number }) {
  const icon = item.icon;
  if (icon.kind === 'claude') {
    return <ClaudeIcon size={size} className="text-[#D97757] flex-shrink-0" />;
  }
  if (icon.kind === 'codex') {
    return <CodexIcon size={size} className="flex-shrink-0" />;
  }
  const Component = icon.Component;
  if (!Component) return null;
  return <Component size={size} className="flex-shrink-0" style={icon.color ? { color: icon.color } : undefined} />;
}
