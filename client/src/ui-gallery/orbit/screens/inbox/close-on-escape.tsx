import { useEffect } from 'react';

/** Escape closes the flow read beside the card; the listener leaves with the panel, so navigating adds none. */
export function CloseOnEscape({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return null;
}
