import { useState, useEffect, useRef, useCallback } from 'react';
import type { Topic, UpdateTopicRequest } from '@/types';

interface ContextMenuProps {
  x: number;
  y: number;
  topic: Topic;
  onClose: () => void;
  onUpdate: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  onDelete: (id: string) => Promise<boolean>;
}

const EMOJI_OPTIONS = [
  '💬', '💡', '🚀', '🔥', '⭐', '🎯', '💎', '🎨',
  '🔧', '📚', '🌟', '📝', '🎵', '🏠', '❤️', '🔒',
  '📊', '🌍', '🎮', '🍕', '🐱', '🌺', '⚡', '🎪',
];

const COLOR_OPTIONS = [
  '#0066cc', '#059669', '#dc2626', '#7c3aed',
  '#ea580c', '#0891b2', '#be185d', '#4338ca',
  '#16a34a', '#eab308',
];

type SubMenu = 'none' | 'rename' | 'icon' | 'color';

export function ContextMenu({ x, y, topic, onClose, onUpdate, onDelete }: ContextMenuProps) {
  const [subMenu, setSubMenu] = useState<SubMenu>('none');
  const [renameValue, setRenameValue] = useState(topic.name);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  useEffect(() => {
    if (subMenu === 'rename') {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [subMenu]);

  const adjustedStyle = useCallback(() => {
    const menuWidth = 220;
    const menuHeight = 260;
    let adjustedX = x;
    let adjustedY = y;
    if (x + menuWidth > window.innerWidth) adjustedX = window.innerWidth - menuWidth - 8;
    if (y + menuHeight > window.innerHeight) adjustedY = window.innerHeight - menuHeight - 8;
    return { left: adjustedX, top: adjustedY };
  }, [x, y]);

  const handleRename = async () => {
    if (renameValue.trim() && renameValue.trim() !== topic.name) {
      await onUpdate(topic.id, { name: renameValue.trim() });
    }
    onClose();
  };

  const handleIconChange = async (icon: string) => { await onUpdate(topic.id, { icon }); onClose(); };
  const handleColorChange = async (color: string) => { await onUpdate(topic.id, { color }); onClose(); };

  const handleDelete = async () => { await onDelete(topic.id); onClose(); };

  const pos = adjustedStyle();

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white dark:bg-[#1e1e1e] rounded-xl shadow-xl border border-[#e0e0e0] dark:border-[#333] py-1 min-w-[200px]"
      style={{ left: pos.left, top: pos.top }}
    >
      {subMenu === 'none' && (
        <>
          <MenuItem label="✏️ Rename" onClick={() => setSubMenu('rename')} />
          <MenuItem label="😀 Change icon" onClick={() => setSubMenu('icon')} />
          <MenuItem label="🎨 Change color" onClick={() => setSubMenu('color')} />
          <div className="border-t border-[#f0f0f0] dark:border-[#2a2a2a] my-1" />
          <MenuItem label="🗑️ Archive / Delete" onClick={handleDelete} danger />
        </>
      )}

      {subMenu === 'rename' && (
        <div className="p-3">
          <div className="text-[11px] font-semibold text-[#888] dark:text-[#666] mb-2">Rename topic</div>
          <input
            ref={inputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') onClose(); }}
            className="w-full px-2 py-1.5 border border-[#e0e0e0] dark:border-[#333] rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--primary)] bg-white dark:bg-[#222] text-[#1a1a1a] dark:text-[#e5e5e5] transition-colors"
          />
          <div className="flex justify-end gap-2 mt-2">
            <button onClick={onClose} className="text-[12px] text-[#888] hover:text-[#555] dark:hover:text-[#ccc] px-2 py-1 transition-colors">Cancel</button>
            <button onClick={handleRename} className="text-[12px] bg-[var(--primary)] text-white px-3 py-1 rounded-lg hover:bg-[#0055dd] transition-colors">Save</button>
          </div>
        </div>
      )}

      {subMenu === 'icon' && (
        <div className="p-3">
          <div className="text-[11px] font-semibold text-[#888] dark:text-[#666] mb-2">Choose icon</div>
          <div className="grid grid-cols-6 gap-1">
            {EMOJI_OPTIONS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => handleIconChange(emoji)}
                className={`w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] text-lg transition-colors ${
                  topic.icon === emoji ? 'bg-[var(--primary)]/10 ring-2 ring-[var(--primary)]/50' : ''
                }`}
              >{emoji}</button>
            ))}
          </div>
        </div>
      )}

      {subMenu === 'color' && (
        <div className="p-3">
          <div className="text-[11px] font-semibold text-[#888] dark:text-[#666] mb-2">Choose color</div>
          <div className="grid grid-cols-5 gap-2">
            {COLOR_OPTIONS.map((color) => (
              <button
                key={color}
                onClick={() => handleColorChange(color)}
                className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${
                  topic.color === color ? 'border-[#1a1a1a] dark:border-[#e5e5e5] scale-110' : 'border-transparent'
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-2 text-[13px] hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] transition-colors ${
        danger ? 'text-[#dc2626] hover:bg-[#dc2626]/10' : 'text-[#444] dark:text-[#ccc]'
      }`}
    >{label}</button>
  );
}
