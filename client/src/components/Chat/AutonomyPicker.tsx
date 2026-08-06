import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, ShieldOff, ClipboardList, Check } from 'lucide-react';
import { useDismissable } from '@/hooks/useDismissable';
import { POPOVER_PANEL, POPOVER_MARGIN, Z_POPOVER } from '@/lib/popoverStyles';
import type { AutonomyLevel } from '../../types';

/**
 * Quanto può fare da sé questa chat — nel composer, SEMPRE in vista.
 *
 * Stava solo nel modale delle impostazioni, dietro un tasto destro su una tab:
 * un permesso che decide se l'agente può toccare i tuoi file, raggiungibile per
 * caso. Ed era stato tolto di proposito da questa superficie quando non faceva
 * niente («un controllo che appare impostato e non fa niente è peggio di un
 * controllo assente», chat.spec.ts). Adesso fa: decide `--permission-mode`
 * della sessione CLI, quindi torna dov'è la mano di chi scrive.
 *
 * Il livello si legge SEMPRE, anche chiuso: è il punto: la differenza fra «fa e
 * basta» e «prima chiede» non si scopre aprendo un menu.
 */
/**
 * Le tre icone sono UNA SCALA, e prima non lo erano.
 *
 * «Agisce» portava un lampo — che in questa app vuol dire velocità, ed era il
 * terzo lampo con il terzo significato nella stessa riga del composer — e
 * «Nessun freno» portava uno scudo SPUNTATO, cioè il segno della protezione
 * proprio sul livello che la toglie: il glifo diceva il contrario della voce.
 *
 * Adesso i tre glifi raccontano una cosa sola, quanta rete c'è sotto: il piano
 * da approvare, lo scudo dei permessi, lo scudo tolto.
 */
const LEVELS: { value: AutonomyLevel; label: string; short: string; desc: string; icon: typeof ShieldCheck }[] = [
  {
    value: 'auto-apply',
    label: 'Agisce',
    short: 'Agisce',
    desc: 'Legge, scrive ed esegue senza chiedere. È il modo normale di lavorare.',
    icon: ShieldCheck,
  },
  {
    value: 'ask',
    label: 'Propone prima',
    short: 'Propone',
    desc: 'Scrive un piano e aspetta il tuo Approva sopra il campo di testo. Non tocca niente finché non dici di sì.',
    icon: ClipboardList,
  },
  {
    value: 'yolo',
    label: 'Nessun freno',
    short: 'Libero',
    desc: 'Come «agisce», ma senza nessuna barriera di permessi. Serve raramente.',
    icon: ShieldOff,
  },
];

/** Larghezza del pannello: serve a tenerlo dentro lo schermo quando il
 *  composer è vicino al bordo destro. */
const PANEL_W = 268;

export function AutonomyPicker({ value, onChange }: {
  value: AutonomyLevel | null | undefined;
  onChange: (level: AutonomyLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  // Il pannello va in PORTAL sul body, come ogni altro popover di questa
  // superficie: aperto in flusso finiva sotto il contenitore dei messaggi, che
  // intercetta i click — visibile e non cliccabile, che è il modo peggiore di
  // esistere. Si apre verso l'ALTO perché il composer sta in fondo alla pane.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDismissable({ open, onClose: () => setOpen(false), refs: [panelRef, triggerRef] });

  // Un topic senza scelta AGISCE — è l'invariante che la migration 081 ha
  // rimesso in piedi; qui si limita a mostrarla per quello che è.
  const current = LEVELS.find((l) => l.value === value) ?? LEVELS[0];
  const Icon = current.icon;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="composer-autonomy"
        data-level={current.value}
        onClick={() => {
          const r = triggerRef.current?.getBoundingClientRect();
          if (r) {
            setPos({
              top: Math.max(POPOVER_MARGIN, r.top - 8),
              left: Math.max(POPOVER_MARGIN, Math.min(r.left, window.innerWidth - PANEL_W - POPOVER_MARGIN)),
            });
          }
          setOpen((o) => !o);
        }}
        title={`Autonomia: ${current.label} — ${current.desc}`}
        // Il nome accessibile diceva solo «Agisce»: fuori contesto non è il nome
        // di niente. Chi ascolta sente adesso di che cosa è il livello — ed è
        // anche l'unico modo di agganciarlo dal ruolo, che è come si distingue
        // il composer VISIBILE da quello di una pane nascosta (l'albero di
        // accessibilità la esclude, un selettore CSS no).
        aria-label={`Autonomia: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`h-7 px-2 inline-flex items-center gap-1 rounded-lg text-[11px] font-medium transition-colors ${
          current.value === 'ask'
            ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
            : 'text-app-text-tertiary hover:text-app-text hover:bg-app-hover'
        }`}
      >
        <Icon size={13} className="flex-shrink-0" />
        <span>{current.short}</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          data-testid="composer-autonomy-panel"
          className={`fixed ${POPOVER_PANEL} p-1`}
          style={{
            top: pos.top,
            left: pos.left,
            width: PANEL_W,
            // Tutto il pannello sopra il grilletto, senza doverne misurare
            // prima l'altezza.
            transform: 'translateY(-100%)',
            zIndex: Z_POPOVER,
          }}
        >
          {LEVELS.map((l) => {
            const LIcon = l.icon;
            const active = l.value === current.value;
            return (
              <button
                key={l.value}
                type="button"
                data-testid={`composer-autonomy-${l.value}`}
                onClick={() => { onChange(l.value); setOpen(false); }}
                className={`w-full text-left rounded-md px-2 py-1.5 flex items-start gap-2 transition-colors ${
                  active ? 'bg-app-hover' : 'hover:bg-app-hover'
                }`}
              >
                <LIcon size={13} className="mt-0.5 flex-shrink-0 text-app-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium text-app-text">{l.label}</span>
                  <span className="block text-[11px] text-app-text-muted leading-snug">{l.desc}</span>
                </span>
                {active && <Check size={13} className="mt-0.5 flex-shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
