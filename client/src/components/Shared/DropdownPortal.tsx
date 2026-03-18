import { useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useMobile } from '../../hooks/useMobile';

interface DropdownPortalProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: React.ReactNode;
  align?: 'left' | 'right';
}

export function DropdownPortal({ open, anchorRef, onClose, children, align = 'right' }: DropdownPortalProps) {
  const { isMobile } = useMobile();
  const menuRef = useRef<HTMLDivElement>(null);

  const stableClose = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return;
    const h = (e: Event) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      stableClose();
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { stableClose(); e.stopPropagation(); } };
    document.addEventListener('mousedown', h);
    document.addEventListener('touchstart', h, { passive: true });
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('touchstart', h); document.removeEventListener('keydown', k); };
  }, [open, stableClose, anchorRef]);

  if (!open || !anchorRef.current) return null;

  const rect = anchorRef.current.getBoundingClientRect();

  return createPortal(
    <>
      {isMobile && <div className="fixed inset-0 z-[9998]" onClick={stableClose} />}
      <div
        ref={menuRef}
        className={isMobile
          ? 'fixed bottom-0 left-0 right-0 bg-surface border-t border-app-border rounded-t-xl shadow-lg py-2 z-[9999] bottom-sheet'
          : 'bg-surface border border-app-border rounded-lg shadow-lg py-1 min-w-[150px]'}
        style={isMobile
          ? { paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 8px)' }
          : { position: 'fixed', top: rect.bottom + 4, ...(align === 'left' ? { left: rect.left } : { right: window.innerWidth - rect.right }), zIndex: 9999 }}
      >
        {children}
      </div>
    </>,
    document.body
  );
}
