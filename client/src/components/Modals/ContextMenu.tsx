import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { PenLine, Smile, Palette, Bot, Trash2, Pin, PinOff, ExternalLink, type LucideIcon } from 'lucide-react';
import type { Topic, UpdateTopicRequest } from '@/types';
import { TOPIC_ICONS, getTopicIcon } from '@/lib/topicIcons';
import { POPOVER_SURFACE, POPOVER_ITEM, POPOVER_ITEM_DANGER, Z_CONTEXT_MENU } from '@/lib/popoverStyles';
import { useDismissable } from '@/hooks/useDismissable';

interface ContextMenuProps {
  x: number;
  y: number;
  topic: Topic;
  onClose: () => void;
  onUpdate: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  onDelete: (id: string) => Promise<boolean>;
  onAssignAgents?: (topicId: string, topicName: string) => void;
  /** Pinning (Fissati) — current pin state + toggle ("Fissa" / "Rimuovi dai
   *  Fissati"). Optional so legacy hosts render without the entry. */
  isPinned?: boolean;
  onTogglePin?: () => void;
  /** Pop the topic into its own OS window (parity with the pane-header /
   *  tab-menu pop-out). Optional so legacy hosts render without the entry. */
  onPopOut?: () => void;
}

const COLOR_OPTIONS = [
  '#0066cc', '#059669', '#dc2626', '#7c3aed',
  '#ea580c', '#0891b2', '#be185d', '#4338ca',
  '#16a34a', '#eab308',
];

type SubMenu = 'none' | 'rename' | 'icon' | 'color' | 'confirm-delete';

export function ContextMenu({ x, y, topic, onClose, onUpdate, onDelete, onAssignAgents, isPinned, onTogglePin, onPopOut }: ContextMenuProps) {
  const [subMenu, setSubMenu] = useState<SubMenu>('none');
  const [renameValue, setRenameValue] = useState(topic.name);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ONE dismissal contract: capture-phase outside-pointer + Escape close. The
  // rename input's ref is included so clicking into it (it lives inside menuRef
  // anyway) can never dismiss. No persistent trigger for a cursor-positioned
  // menu → restoreFocus:false (an open rename input keeps its own focus).
  useDismissable({ open: true, onClose, refs: [menuRef, inputRef], restoreFocus: false });

  useEffect(() => {
    if (subMenu === 'rename') {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [subMenu]);

  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measure the REAL menu and clamp it inside the viewport (same MARGIN=8
  // technique as ContextMenuPortal), replacing the old hardcoded 220×260
  // guess — the subMenus differ wildly in height (rename ~80px vs the icon
  // grid ~200px), so a single fixed size over/under-shot depending on which
  // one was open. Re-measures whenever the subMenu changes.
  useLayoutEffect(() => {
    const el = menuRef.current;
    const w = el?.offsetWidth ?? 220;
    const h = el?.offsetHeight ?? 260;
    const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
    setPos({ left, top });
  }, [x, y, subMenu]);

  const handleRename = async () => {
    if (renameValue.trim() && renameValue.trim() !== topic.name) {
      await onUpdate(topic.id, { name: renameValue.trim() });
    }
    onClose();
  };

  const handleIconChange = async (icon: string) => { await onUpdate(topic.id, { icon }); onClose(); };
  const handleColorChange = async (color: string) => { await onUpdate(topic.id, { color }); onClose(); };

  const handleDelete = async () => { await onDelete(topic.id); onClose(); };

  // Portaled to <body> so position:fixed escapes any transformed / overflow /
  // stacking-context ancestor, and Z_CONTEXT_MENU keeps it on the shared
  // popover plane (above portaled dropdowns / the project menu).
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Actions for ${topic.name}`}
      className={`fixed ${POPOVER_SURFACE} min-w-[200px]`}
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        zIndex: Z_CONTEXT_MENU,
        // Hidden for the one pre-measure pass so it never flashes unclamped.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {subMenu === 'none' && (
        <>
          <MenuItem icon={PenLine} label="Rename" onClick={() => setSubMenu('rename')} />
          <MenuItem icon={Smile} label="Change icon" onClick={() => setSubMenu('icon')} />
          <MenuItem icon={Palette} label="Change color" onClick={() => setSubMenu('color')} />
          {onTogglePin && (
            <MenuItem
              icon={isPinned ? PinOff : Pin}
              label={isPinned ? 'Rimuovi dai Fissati' : 'Fissa'}
              onClick={() => { onTogglePin(); onClose(); }}
            />
          )}
          {onPopOut && (
            <MenuItem
              icon={ExternalLink}
              label="Apri in nuova finestra"
              onClick={() => { onPopOut(); onClose(); }}
            />
          )}
          {onAssignAgents && (
            <>
              <div className="border-t border-app-border my-1" />
              <MenuItem icon={Bot} label="Assign Agents" onClick={() => { onAssignAgents(topic.id, topic.name); onClose(); }} />
            </>
          )}
          <div className="border-t border-app-border my-1" />
          <MenuItem icon={Trash2} label="Archive / Delete" onClick={() => setSubMenu('confirm-delete')} danger />
        </>
      )}

      {subMenu === 'rename' && (
        <div className="p-3">
          <div className="text-[11px] font-semibold text-app-text-muted mb-2">Rename topic</div>
          <input
            ref={inputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') onClose(); }}
            className="w-full px-2 py-1.5 border border-app-border-light rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary bg-surface dark:bg-elevated text-app-text transition-colors"
          />
          <div className="flex justify-end gap-2 mt-2">
            <button onClick={onClose} className="text-[12px] text-app-text-muted hover:text-app-text px-2 py-1 transition-colors">Cancel</button>
            <button onClick={handleRename} className="text-[12px] bg-primary text-white px-3 py-1 rounded-lg hover:bg-primary-hover transition-colors">Save</button>
          </div>
        </div>
      )}

      {subMenu === 'icon' && (
        <div className="p-3">
          <div className="text-[11px] font-semibold text-app-text-muted mb-2">Choose icon</div>
          <div className="grid grid-cols-6 gap-1">
            {TOPIC_ICONS.map((name) => {
              const Icon = getTopicIcon(name);
              return (
                <button
                  key={name}
                  onClick={() => handleIconChange(name)}
                  aria-label={`Icon ${name}`}
                  className={`w-10 h-10 md:w-8 md:h-8 flex items-center justify-center rounded-lg hover:bg-app-hover transition-colors ${
                    topic.icon === name ? 'bg-primary/10 ring-2 ring-primary/50' : ''
                  }`}
                >
                  <Icon size={16} className="text-app-text-secondary" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {subMenu === 'color' && (
        <div className="p-3">
          <div className="text-[11px] font-semibold text-app-text-muted mb-2">Choose color</div>
          <div className="grid grid-cols-5 gap-2">
            {COLOR_OPTIONS.map((color) => (
              <button
                key={color}
                onClick={() => handleColorChange(color)}
                aria-label={`Color ${color}`}
                className={`w-10 h-10 md:w-8 md:h-8 rounded-full border-2 transition-transform hover:scale-110 ${
                  topic.color === color ? 'border-[#1a1a1a] dark:border-[#e5e5e5] scale-110' : 'border-transparent'
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>
      )}

      {subMenu === 'confirm-delete' && (
        <div className="p-3">
          <div className="text-[11px] font-semibold text-red-600 mb-2">Delete topic?</div>
          <p className="text-[12px] text-app-text-secondary mb-3">
            Are you sure you want to delete <strong>{topic.name}</strong>? This will archive the topic.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="text-[12px] text-app-text-muted hover:text-app-text px-2 py-1 transition-colors">Cancel</button>
            <button onClick={handleDelete} className="text-[12px] bg-red-600 text-white px-3 py-1 rounded-lg hover:bg-red-700 transition-colors">Delete</button>
          </div>
        </div>
      )}

    </div>,
    document.body
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: LucideIcon; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`${danger ? POPOVER_ITEM_DANGER : POPOVER_ITEM}`}
    >
      <Icon size={14} className={danger ? 'text-red-500' : 'text-app-text-tertiary'} />
      {label}
    </button>
  );
}
