import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useT } from '@/hooks/useT';
import { createPortal } from 'react-dom';
import { PenLine, Palette, Archive, ArchiveRestore, Pin, PinOff, ExternalLink, Link2, type LucideIcon } from 'lucide-react';
import type { Topic, UpdateTopicRequest } from '@/types';
import { POPOVER_ITEM, POPOVER_ITEM_DANGER, POPOVER_SURFACE, Z_CONTEXT_MENU } from '@/lib/popoverStyles';
import { useDismissable } from '@/hooks/useDismissable';
import { useCopyTabLink } from '@/hooks/useCopyTabLink';

interface ContextMenuProps {
  x: number;
  y: number;
  topic: Topic;
  onClose: () => void;
  onUpdate: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  /** Archivia o RIPRISTINA. Il secondo argomento c'era già nell'implementazione
   *  (`archiveTopic(id, archived = true)`) ma non nel tipo, quindi da qui si
   *  poteva solo archiviare — ed era il motivo per cui la riga doveva montarsi
   *  un bottone «Ripristina» tutto suo: il menu, che è la porta buona per
   *  gestire lo stato, quella parola non ce l'aveva. */
  onDelete: (id: string, archived?: boolean) => Promise<boolean>;
  /** Pinning (Fissati) — current pin state + toggle ("Fissa" / "Rimuovi dai
   *  Fissati"). Optional so legacy hosts render without the entry. */
  isPinned?: boolean;
  onTogglePin?: () => void;
  /** Sfissare questa chat la archivia anche (semantica «se non la stai
   *  guardando e la togli dai Fissati, non ti serve» — vedi `handleTogglePin`
   *  in App). Cambia le PAROLE della voce, non quello che fa: «Rimuovi dai
   *  Fissati» da solo lascia credere che la riga resti in lista, e invece
   *  sparisce finché non accendi «Mostra archiviate». */
  unpinAlsoArchives?: boolean;
  /** Pop the topic into its own OS window (parity with the pane-header /
   *  tab-menu pop-out). Optional so legacy hosts render without the entry. */
  onPopOut?: () => void;
}

const COLOR_OPTIONS = [
  '#0066cc', '#059669', '#dc2626', '#7c3aed',
  '#ea580c', '#0891b2', '#be185d', '#4338ca',
  '#16a34a', '#eab308',
];

type SubMenu = 'none' | 'rename' | 'color' | 'confirm-delete';

export function ContextMenu({ x, y, topic, onClose, onUpdate, onDelete, isPinned, onTogglePin, unpinAlsoArchives, onPopOut }: ContextMenuProps) {
  const tr = useT();
  const [subMenu, setSubMenu] = useState<SubMenu>('none');
  const [renameValue, setRenameValue] = useState(topic.name);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Stesso gesto, stesse parole della tab e della palette ⌘K: due superfici che
  // dicono cose diverse sullo stesso soggetto, qui, sono un bug.
  const { copyTabLink } = useCopyTabLink();

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
    // Position depends on the MOUNTED menu's measured size (offsetWidth/Height),
    // unknowable during render — this is the canonical measure-then-place, which
    // legitimately commits state from a layout effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos({ left, top });
  }, [x, y, subMenu]);

  const handleRename = async () => {
    if (renameValue.trim() && renameValue.trim() !== topic.name) {
      await onUpdate(topic.id, { name: renameValue.trim() });
    }
    onClose();
  };

  const handleColorChange = async (color: string) => { await onUpdate(topic.id, { color }); onClose(); };

  const handleDelete = async () => { await onDelete(topic.id); onClose(); };

  // Portaled to <body> so position:fixed escapes any transformed / overflow /
  // stacking-context ancestor, and Z_CONTEXT_MENU keeps it on the shared
  // popover plane (above portaled dropdowns / the project menu).
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Azioni per ${topic.name}`}
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
          <MenuItem icon={PenLine} label="Rinomina" onClick={() => setSubMenu('rename')} />
          <MenuItem icon={Palette} label="Cambia colore" onClick={() => setSubMenu('color')} />
          {/* Il soggetto è il TOPIC, non la pane: la stessa chat ha due id di
              pane (`<topicId>` in alto, `chat:<topicId>` dentro un progetto) e
              un link con l'id della pane aprirebbe una SECONDA tab della stessa
              chat sulla superficie sbagliata. Qui la riga di sidebar E' il
              topic, quindi il target si costruisce direttamente. */}
          <MenuItem
            icon={Link2}
            label="Copia link"
            onClick={() => { void copyTabLink({ kind: 'chat', key: topic.id }); onClose(); }}
          />
          {onTogglePin && (
            <MenuItem
              icon={isPinned ? PinOff : Pin}
              label={isPinned
                ? (unpinAlsoArchives ? 'Rimuovi dai Fissati e archivia' : 'Rimuovi dai Fissati')
                : 'Fissa'}
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
          <div className="border-t border-app-border my-1" />
          {/* NON È UN CESTINO, e per tre anni lo ha detto: `Trash2` in rosso,
              con la stessa grammatica di «elimina». Archiviare qui è la stessa
              identica cosa che fa il cerchio in coda alla riga — «fatto, togli
              dalla lista» — e quel gesto è reversibile, ha tre secondi di
              ripensamento e la sua controparte «Ripristina». Dipingerlo come
              distruttivo faceva evitare la voce che invece serve.
              Il glifo d'archivio resta legittimo QUI: in un menu accompagna
              un'etichetta scritta, non deve dire uno stato da solo (che era il
              suo problema quando stava in testa alla riga). */}
          <MenuItem
            icon={topic.archived ? ArchiveRestore : Archive}
            label={topic.archived ? 'Ripristina' : 'Archivia'}
            onClick={() => {
              // Ripristinare è sicuro: nessuna conferma, come ovunque nell'app.
              if (topic.archived) { void onDelete(topic.id, false); onClose(); return; }
              setSubMenu('confirm-delete');
            }}
          />
        </>
      )}

      {subMenu === 'rename' && (
        <div className="p-3">
          <div className="text-[11px] font-semibold text-app-text-muted mb-2">{tr('ctx.renameTopic')}</div>
          <input
            ref={inputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') onClose(); }}
            className="w-full px-2 py-1.5 border border-app-border-light rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary bg-surface dark:bg-elevated text-app-text transition-colors"
          />
          <div className="flex justify-end gap-2 mt-2">
            <button onClick={onClose} className="text-[12px] text-app-text-muted hover:text-app-text px-2 py-1 transition-colors">{tr('common.cancel')}</button>
            <button onClick={handleRename} className="text-[12px] bg-primary text-white px-3 py-1 rounded-lg hover:bg-primary-hover transition-colors">{tr('common.save')}</button>
          </div>
        </div>
      )}

      {subMenu === 'color' && (
        <div className="p-3">
          <div className="text-[11px] font-semibold text-app-text-muted mb-2">{tr('ctx.pickColour')}</div>
          <div className="grid grid-cols-5 gap-2">
            {COLOR_OPTIONS.map((color) => (
              <button
                key={color}
                onClick={() => handleColorChange(color)}
                aria-label={`Colore ${color}`}
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
          {/* IL ROSSO SE NE VA ANCHE DA QUI, e non è una questione di gusto: il
              testo che sta due righe sotto dice «puoi riaprirlo quando vuoi»,
              cioè dichiara che l'azione è reversibile, mentre il titolo in rosso
              e il bottone rosso dicono il contrario. Delle due, quella vera è la
              frase. Il colore d'allarme resta per ciò che non si può disfare. */}
          <div className="text-[11px] font-semibold text-app-text mb-2">Archiviare il topic?</div>
          <p className="text-[12px] text-app-text-secondary mb-3">
            {tr('ctx.archive.q1')} <strong>{topic.name}</strong>{tr('ctx.archive.q2')}
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="text-[12px] text-app-text-muted hover:text-app-text px-2 py-1 transition-colors">{tr('common.cancel')}</button>
            <button onClick={handleDelete} className="text-[12px] bg-primary text-white px-3 py-1 rounded-lg hover:bg-primary-hover transition-colors">Archivia</button>
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
      {/* Sul ramo distruttivo l'icona NON si dipinge: lucide usa
          `stroke="currentColor"`, quindi eredita il rosso del bottone. Dandogli
          un `text-red-500` suo si avevano due rossi diversi a otto pixel di
          distanza. */}
      <Icon size={14} className={danger ? undefined : 'text-app-text-tertiary'} />
      {label}
    </button>
  );
}
