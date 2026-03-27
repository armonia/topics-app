import { useState, useEffect, useRef, useCallback } from 'react';
import { PenLine, Smile, Palette, Bot, Kanban, Trash2, type LucideIcon } from 'lucide-react';
import type { Topic, UpdateTopicRequest } from '@/types';
import { TOPIC_ICONS, getTopicIcon } from '@/lib/topicIcons';

interface ContextMenuProps {
  x: number;
  y: number;
  topic: Topic;
  onClose: () => void;
  onUpdate: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  onDelete: (id: string) => Promise<boolean>;
  onAssignAgents?: (topicId: string, topicName: string) => void;
  onOpenBoard?: (projectPath: string) => void;
}

const COLOR_OPTIONS = [
  '#0066cc', '#059669', '#dc2626', '#7c3aed',
  '#ea580c', '#0891b2', '#be185d', '#4338ca',
  '#16a34a', '#eab308',
];

type SubMenu = 'none' | 'rename' | 'icon' | 'color' | 'confirm-delete';

export function ContextMenu({ x, y, topic, onClose, onUpdate, onDelete, onAssignAgents, onOpenBoard }: ContextMenuProps) {
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
      role="menu"
      aria-label={`Actions for ${topic.name}`}
      className="fixed z-50 bg-surface rounded-xl shadow-xl border border-app-border-light py-1 min-w-[200px]"
      style={{ left: pos.left, top: pos.top }}
    >
      {subMenu === 'none' && (
        <>
          <MenuItem icon={PenLine} label="Rename" onClick={() => setSubMenu('rename')} />
          <MenuItem icon={Smile} label="Change icon" onClick={() => setSubMenu('icon')} />
          <MenuItem icon={Palette} label="Change color" onClick={() => setSubMenu('color')} />
          {onAssignAgents && (
            <>
              <div className="border-t border-app-border my-1" />
              <MenuItem icon={Bot} label="Assign Agents" onClick={() => { onAssignAgents(topic.id, topic.name); onClose(); }} />
            </>
          )}
          {onOpenBoard && topic.projectPath && (
            <MenuItem icon={Kanban} label="Open Board" onClick={() => { onOpenBoard(topic.projectPath!); onClose(); }} />
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

    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: LucideIcon; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`w-full text-left px-4 py-2.5 text-[13px] flex items-center gap-2.5 hover:bg-app-hover transition-colors ${
        danger ? 'text-red-600 hover:bg-red-600/10' : 'text-app-text'
      }`}
    >
      <Icon size={14} className={danger ? 'text-red-500' : 'text-app-text-tertiary'} />
      {label}
    </button>
  );
}
