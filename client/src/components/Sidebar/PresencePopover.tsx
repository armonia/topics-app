/**
 * IL PANNELLO DEI CHIP DELL'IDENTITA' — un guscio solo per i tre dropdown.
 *
 * I chip in fondo alla colonna (io, ogni organizzazione, gli amici) aprono la
 * STESSA superficie: intestazione, elenco di persone, azioni in fondo. Scriverla
 * tre volte avrebbe voluto dire tre larghezze, tre modi di chiudersi e tre
 * risposte diverse alla domanda «cosa succede quando l'elenco e' lungo» —  che
 * e' esattamente come nascono i menu che sembrano di app diverse.
 *
 * SI APRE VERSO L'ALTO, ma non perche' lo decide questo file: `computeMenuPosition`
 * prova sotto e ribalta sopra quando sotto non ci sta. Questi chip stanno
 * appoggiati al bordo inferiore della finestra, quindi il ribaltamento e' la
 * regola e non l'eccezione; se un giorno il blocco si spostasse in cima, il
 * pannello scenderebbe da solo senza toccare niente qui.
 *
 * LA CHIUSURA NON E' SCRITTA QUI. `useDismissable` porta il click fuori, Escape,
 * il ritorno del fuoco al chip e la regola «uno alla volta», che e' quella che
 * impedisce di ritrovarsi il pannello di due organizzazioni aperti insieme.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissable } from '@/hooks/useDismissable';
import { computeMenuPosition } from '@/lib/popoverPosition';
import { POPOVER_PANEL, Z_POPOVER } from '@/lib/popoverStyles';

/** La larghezza del pannello. Uguale per i tre, e piu' larga della colonna:
 *  l'elenco delle persone porta nomi interi, che nella sidebar sarebbero
 *  troncati — un pannello che tronca come la riga che lo apre non serve. */
const LARGHEZZA = 244;

export function PresencePopover({
  anchorEl,
  onClose,
  titolo,
  children,
  testId,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  /** L'intestazione: di chi o di cosa parla questo pannello. */
  titolo: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  const pannello = useRef<HTMLDivElement>(null);
  const ancora = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // L'ancora e' un elemento grezzo: si rispecchia in un ref (in un effetto, non
  // in render) perche' `useDismissable` conta come «dentro» solo dei ref, ed e'
  // anche il bersaglio a cui torna il fuoco alla chiusura.
  useEffect(() => { ancora.current = anchorEl; }, [anchorEl]);

  useDismissable({ open: anchorEl !== null, onClose, refs: [ancora, pannello] });

  // Misurare PRIMA del paint: con `useEffect` il pannello si vedrebbe per un
  // frame in alto a sinistra e poi saltare al suo posto.
  useLayoutEffect(() => {
    if (!anchorEl || !pannello.current) return;
    const a = anchorEl.getBoundingClientRect();
    const p = pannello.current.getBoundingClientRect();
    setPos(computeMenuPosition(
      { top: a.top, right: a.right, bottom: a.bottom, left: a.left },
      { width: LARGHEZZA, height: p.height },
      { align: 'left', gap: 6 },
    ));
  }, [anchorEl]);

  if (!anchorEl) return null;

  return createPortal(
    <div
      ref={pannello}
      data-testid={testId}
      role="dialog"
      className={`fixed ${POPOVER_PANEL} overflow-hidden`}
      style={{
        width: LARGHEZZA,
        zIndex: Z_POPOVER,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // Finche' non e' misurato resta invisibile invece di lampeggiare
        // nell'angolo: un frame nel posto sbagliato si vede, e si ricorda.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <div className="flex items-center gap-2 border-b border-app-border px-3 py-2 text-[11px] font-medium text-app-text">
        {titolo}
      </div>
      {children}
    </div>,
    document.body,
  );
}
