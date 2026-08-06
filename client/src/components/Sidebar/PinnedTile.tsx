import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Globe, MessageSquare, TerminalSquare, Wrench, type LucideIcon } from 'lucide-react';
import { sidebarItemPaneId, type SidebarItem } from '../../lib/buildSidebarItems';
import type { AttentionTier } from '../../types';
import { attentionSurface, SELECTED_SURFACE } from '../../lib/selectionStyles';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { useProjectIcon } from '../Shared/projectIconStore';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { getPaneConfig, getTerminalSessionFromPaneId } from '../../state/pane/adapters/paneConfig';
import { useTerminalAttentionFill, useTopicAttentionFill } from '../../state/signals';
import { DND_TYPES } from '../../lib/dndTypes';
import { cachedIconPalette, cachedIconTint, sampleIconPalette, sampleIconTint } from '../../lib/iconTint';

const TYPE_ICONS: Record<SidebarItem['type'], LucideIcon> = {
  chat: MessageSquare,
  terminal: TerminalSquare,
  browser: Globe,
  project: FolderOpen,
  utility: Wrench,
};

/** Quanto della tinta si vede sul fondo. Basso di proposito: la tessera deve
 *  leggersi come una superficie dell'app tinta, non come una macchia di colore. */
const TINT_SURFACE = 0.22;

/**
 * Una tessera dei Fissati.
 *
 * ── L'identità è quella che la cosa HA GIÀ ──────────────────────────────────
 * Un progetto che spedisce una favicon si riconosce da QUELLA, e allora il
 * titolo non si ripete: sarebbe la stessa informazione due volte in uno spazio
 * che non ce l'ha. Un progetto senza icona mostra il nome — mai un'iniziale o
 * una tessera generata: «solo icona reale o zero ingombro» è una decisione già
 * presa, e un monogramma è già stato rifiutato una volta. Chat, terminali e
 * browser mostrano glifo di tipo + nome, perché lì il titolo È l'identità:
 * quattro icone-chat identiche non distinguono niente.
 *
 * ── Il bagliore dice CHI SEI, non COSA STAI FACENDO ─────────────────────────
 * La tinta è statica e viene dal colore dominante dell'icona (o dal colore di
 * tipo, che il repo già usa). Non si anima: l'animazione — la corona — è il
 * segnale di «sta lavorando», e due segnali sullo stesso canale sono un segnale
 * che non dice più niente. Se non c'è una sorgente di colore reale non si
 * inventa: la tessera resta neutra.
 *
 * ── Resta una riga, per chi non guarda ──────────────────────────────────────
 * `role="treeitem"` e il nome accessibile ci sono anche quando si vede la sola
 * icona: chi legge con uno screen reader, e i test che cercano la riga per nome,
 * non devono accorgersi che è diventata un quadrato.
 */
export function PinnedTile({
  item,
  expanded,
  focused,
  attention,
  onToggle,
  onContextMenu,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  item: SidebarItem;
  expanded: boolean;
  focused: boolean;
  /** Il tier che solo il chiamante può sapere: quello ROLLED-UP di un progetto
   *  (`projectAttentionTier` vuole topics, sessioni e visti, che vivono in
   *  TopicTree). Per chat e terminali si risolve qui sotto con gli stessi hook
   *  che usano le righe, così tessera e riga non possono dire cose diverse. */
  attention: AttentionTier | null;
  onToggle: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  dragging?: boolean;
}) {
  const projectPath = item.type === 'project' ? (item.projectPath ?? '') : '';
  const icon = useProjectIcon(projectPath);
  const hasRealIcon = icon.status === 'has';

  // Tinta: dall'icona per i progetti, dal colore di tipo per tutto il resto.
  // Nessun ripiego per un progetto senza icona — quello resta neutro.
  // `utility` non è un tipo di pane e non ha un colore in `PANE_CONFIG`: resta
  // senza tinta, come i progetti senza icona. Nessun colore inventato per
  // riempire il buco.
  const typeTint = item.type === 'chat' || item.type === 'terminal' || item.type === 'browser'
    ? getPaneConfig(item.type).color
    : undefined;
  // L'esito è tenuto INSIEME alla sorgente da cui viene, e la tinta si DERIVA
  // confrontando le due: così cambiare icona non ha bisogno di un setState di
  // azzeramento nell'effetto (che sarebbe un render a cascata), e una tinta
  // vecchia non può mai comparire su un'icona nuova.
  const [sampled, setSampled] = useState<{ src: string; tint: string | null } | null>(
    () => {
      const known = icon.src ? cachedIconTint(icon.src) : undefined;
      return icon.src && known !== undefined ? { src: icon.src, tint: known } : null;
    },
  );
  useEffect(() => {
    const src = icon.src;
    if (!src) return;
    let alive = true;
    void sampleIconTint(src).then(tint => { if (alive) setSampled({ src, tint }); });
    return () => { alive = false; };
  }, [icon.src]);
  const iconTint = icon.src !== null && sampled !== null && sampled.src === icon.src ? sampled.tint : null;
  const tint = iconTint ?? typeTint ?? null;

  // La PALETTE per settori: serve alla cornice, che non porta una tinta sola ma
  // i colori dell'icona DOVE stanno (verde in alto, blu in basso, come nel logo).
  const [palette, setPalette] = useState<{ src: string; colors: string[] | null } | null>(() => {
    const known = icon.src ? cachedIconPalette(icon.src) : undefined;
    return icon.src && known !== undefined ? { src: icon.src, colors: known } : null;
  });
  useEffect(() => {
    const src = icon.src;
    if (!src) return;
    let alive = true;
    void sampleIconPalette(src).then(colors => { if (alive) setPalette({ src, colors }); });
    return () => { alive = false; };
  }, [icon.src]);
  const sectorColors = icon.src !== null && palette !== null && palette.src === icon.src ? palette.colors : null;

  // Un'icona senza palette (o una tessera senza icona) ricade sulla tinta unica:
  // la cornice si accende lo stesso, di un colore solo. Niente palette e niente
  // tinta ⇒ niente cornice, come per il fondo.
  const ringStops = sectorColors ?? (tint ? [tint, tint] : null);
  const ringGradient = ringStops
    ? `conic-gradient(from 0deg, ${[...ringStops, ringStops[0]].join(', ')})`
    : null;

  // Gli stessi segnali delle righe, dagli stessi hook: una tessera non può
  // dire «tutto calmo» mentre la riga della stessa cosa è accesa.
  const topicTier = useTopicAttentionFill(item.type === 'chat' ? item.id : undefined);
  const termTier = useTerminalAttentionFill(
    item.type === 'terminal' ? getTerminalSessionFromPaneId(item.id) ?? undefined : undefined,
  );
  const tier = attention ?? topicTier ?? termTier;

  const Glyph = TYPE_ICONS[item.type];
  const showName = !hasRealIcon;

  const surface = useMemo(() => {
    // Precedenza invariata rispetto alle righe: attenzione batte selezione,
    // selezione batte riposo. La tinta d'identità vive SOTTO, come alone, così
    // non compete mai con il segnale di stato.
    if (tier) return attentionSurface(tier);
    if (focused) return SELECTED_SURFACE;
    return 'bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.07]';
  }, [tier, focused]);

  return (
    <button
      type="button"
      role="treeitem"
      aria-label={item.name}
      aria-selected={focused}
      aria-expanded={expanded}
      data-pinned="true"
      data-pinned-tile={item.id}
      data-testid="pinned-tile"
      title={item.name}
      draggable
      onDragStart={e => {
        // DUE tipi sullo stesso dataTransfer, di proposito: `PINNED_TILE` per la
        // griglia dei fissati (riordino), `PANEL_ID` per la griglia dei pane
        // (apri la cosa dove l'hai lasciata cadere). Chi riceve prende il tipo
        // che capisce, e trascinare un fissato dentro la griglia continua a
        // funzionare come prima che questa griglia esistesse.
        e.dataTransfer.setData(DND_TYPES.PINNED_TILE, item.id);
        e.dataTransfer.setData(DND_TYPES.PANEL_ID, item.id);
        // …e l'id della PANE, che per un progetto è un'altra stringa: la card
        // di un gruppo sposta una pane, non una riga.
        e.dataTransfer.setData(DND_TYPES.PINNED_PANE_ID, sidebarItemPaneId(item));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart?.();
      }}
      onDragEnd={() => onDragEnd?.()}
      onClick={onToggle}
      onContextMenu={onContextMenu}
      className={[
        'group/tile relative flex flex-col items-center justify-center gap-1',
        'h-14 w-full min-w-0 rounded-lg px-1.5 select-none',
        'transition-colors duration-100',
        // Senza colori da riflettere resta il filo neutro di prima: una tessera
        // senza icona non deve sembrare spenta, deve sembrare sobria.
        ringGradient ? '' : 'ring-1 ring-inset ring-black/5 dark:ring-white/5',
        surface,
        dragging ? 'opacity-40' : '',
      ].join(' ')}
      style={tint ? ({ '--tile-tint': tint } as React.CSSProperties) : undefined}
    >
      {/* LA CORNICE CHE RIFLETTE L'ICONA.
          Due strati dello stesso gradiente conico: uno sfocato che DEBORDA (la
          luce che cade attorno) e uno nitido ritagliato ad anello dalla maschera
          (il filo di luce sul bordo). I colori girano nell'ordine in cui stanno
          nell'icona, quindi il verde resta in alto e il blu in basso invece di
          fondersi in una tinta media — che è la differenza fra «colorato» e
          «illuminato da quella cosa lì».
          Statica: l'animazione è il segnale di «sta lavorando», e due segnali
          sullo stesso canale non ne fanno uno più forte, ne fanno uno muto. */}
      {ringGradient && (
        <>
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute -inset-1 rounded-[14px] transition-opacity duration-150 ${
              focused || expanded ? 'opacity-55' : 'opacity-0 group-hover/tile:opacity-25'
            }`}
            style={{ background: ringGradient, filter: 'blur(7px)' }}
          />
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 rounded-lg transition-opacity duration-150 ${
              focused || expanded ? 'opacity-90' : 'opacity-35 group-hover/tile:opacity-60'
            }`}
            style={{
              background: ringGradient,
              padding: 1.5,
              // La maschera tiene solo la cornice: `exclude` e' lo standard,
              // `xor` il nome che WebKit conosce da prima. Servono entrambi.
              WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
              WebkitMaskComposite: 'xor',
              mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
              maskComposite: 'exclude',
            }}
          />
        </>
      )}

      {/* L'alone d'identita' sul FONDO. Sta sotto il contenuto e sopra la
          superficie di stato, a bassa opacita': una tinta, non una vernice. */}
      {tint && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-lg"
          style={{
            background:
              `radial-gradient(120% 100% at 50% 115%, color-mix(in oklab, var(--tile-tint) ${Math.round(TINT_SURFACE * 100)}%, transparent) 0%, transparent 70%)`,
          }}
        />
      )}

      <span className="relative flex items-center justify-center">
        {hasRealIcon
          ? <ProjectFavicon path={projectPath} size={22} />
          : <Glyph size={16} className="text-app-text-secondary" aria-hidden="true" />}
      </span>

      {showName && (
        // 11px è il minimo di leggibilità imposto in tutta l'app: sotto non si
        // scende nemmeno per far entrare una parola in più.
        <span className="relative w-full truncate text-center text-[11px] leading-none text-app-text-secondary">
          {item.name}
        </span>
      )}

      {item.notificationCount > 0 && (
        <NotificationBadge count={item.notificationCount} className="absolute top-1 right-1" />
      )}
    </button>
  );
}
