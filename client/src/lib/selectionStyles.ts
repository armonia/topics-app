/**
 * Canonical "selected / current" surface — ONE neutral raised-card look shared
 * by the tab bar (the focused tab) and the sidebar (the focused row/folder), so
 * selection reads identically on both surfaces.
 *
 * Deliberately NEUTRAL (no blue/green tint, no coloured accent bar): the old
 * primary-blue sidebar highlight read as "random" next to near-invisible tabs.
 * Now the focused thing looks the same everywhere — a subtly raised card.
 *
 * Tabs are rounded pills and add their own `rounded-md`; sidebar rows apply
 * these classes full-width. The shared part is the fill + ring + shadow + text.
 */
import type { CSSProperties } from 'react';
import type { AttentionTier } from '../types';
// A clean FILL only — no ring/shadow. On full-width sidebar rows a ring+shadow
// bled onto neighbours (focused folder + its active child read as "overlapping"
// rows), and made merely-open rows look selected. A single solid fill is
// unambiguous and never collides with an adjacent row.
/* IL RAMO `max-md:` VA DATO A TUTTA LA SCALA, non a metà.
 *
 * Sotto i 768px il riposo sale a 0.08/0.10 (RESTING_FILL_MOBILE): là il fondo
 * della pagina collassa sul chrome e a 0.05 una card non si stacca più. Ma il
 * rialzo era arrivato solo al riposo, e la selezione era rimasta ai valori
 * pensati per un riposo TRASPARENTE — 0.06 in chiaro, cioè MENO del riposo
 * stesso: sul telefono, in tema chiaro, la riga selezionata era più chiara di
 * quelle a riposo. Il verso della scala si invertiva.
 *
 * I valori mobile non sono inventati: sono il gradino del desktop (dove il
 * riposo è trasparente, quindi selezione = 0.06 chiaro / 0.14 scuro) sommato al
 * riposo mobile. 0.08+0.06 = 0.14 e 0.10+0.14 = 0.24, arrotondato a 0.22 perché
 * oltre il bianco comincia a leggersi come un fill di attenzione. Stessa
 * aritmetica per il gradino «attiva ma non a fuoco».
 */
export const SELECTED_SURFACE =
  'bg-black/[0.06] dark:bg-white/[0.14] text-app-text ' +
  'max-md:bg-black/[0.14] max-md:dark:bg-white/[0.22]';

/**
 * Softer sibling of SELECTED_SURFACE: a tab that is the active one in a SPLIT
 * group that doesn't currently own focus. Visible within its group, but clearly
 * a step below the focused surface so only ONE thing reads as "current".
 */
export const SELECTED_SURFACE_SOFT =
  'bg-black/[0.03] dark:bg-white/[0.06] text-app-text-secondary ' +
  'max-md:bg-black/[0.11] max-md:dark:bg-white/[0.16]';

/**
 * The RESTING state of the same card grammar: an interactive surface that is
 * not selected (an inactive tab, a sidebar header button). One step quieter
 * than SELECTED_SURFACE_SOFT at rest, raising on hover. Extracted from the
 * tab bar's inline classes (PaneTabBar) so the sidebar header's Search / Add
 * buttons read as the exact same family of controls as the tabs.
 *
 * MISURATO, e alzato di una tacca il 2026-08-06. A riposo era 0.03/0.04: sul
 * chrome nuovo — più scuro in dark, più tinto in light — un rialzo così tenue
 * cade sotto la soglia di percettibilità (1,1:1) e la tessera fissata a riposo
 * smette di staccarsi dal fondo: dark 1,073:1, light 1,068:1. A 0.05/0.06
 * risale a 1,115 e 1,122. Sulla pagina (`--bg`, dove vivono le tab) il rialzo
 * diventa un filo più netto: è un guadagno, non un effetto collaterale.
 */
/**
 * IL FONDO DI UNA TAB A RIPOSO SUL TELEFONO, e adesso è UNO.
 *
 * Ce n'erano due, e non erano due gusti: erano lo stesso valore prima e dopo una
 * correzione, applicata a metà delle superfici. Il commento qui sotto lo dice
 * già — a 0.05/0.06 il fondo di una tab stacca di 1,10:1 in scuro e 1,12:1 in
 * chiaro, cioè è appoggiato sulla soglia di percettibilità, e a 0.08/0.10 sale
 * a 1,18 e 1,25. Quella correzione è arrivata a `RESTING_SURFACE`, quindi alle
 * tessere fissate e alle tab della barra; le RIGHE della colonna, che il fondo
 * mobile se lo scrivevano a mano dentro `sidebarRowCard`, sono rimaste a
 * 0.05/0.07 — cioè al valore già misurato come troppo debole su questo schermo.
 *
 * Misurato a 390×844 prima di toccare niente: tessera `oklab(0 0 0 / 0.08)`,
 * riga `oklab(0 0 0 / 0.05)`, una accanto all'altra nella stessa colonna. È «i
 * colori non sono coerenti fra le tab» (Attilio, 09/08), ed era vero.
 *
 * Sta qui come costante e non come stringa ricopiata perché il difetto era
 * esattamente la copia: due posti che dicono la stessa cosa divergono al primo
 * che viene corretto da solo.
 */
export const RESTING_FILL_MOBILE = 'max-md:bg-black/[0.08] max-md:dark:bg-white/[0.10]';
export const RESTING_SURFACE =
  'bg-black/[0.05] dark:bg-white/[0.06] hover:bg-black/[0.08] dark:hover:bg-white/[0.10] ' +
  // SOTTO I 768px IL RIALZO CRESCE, e prende il posto di una linea.
  //
  // Attilio ha chiesto «una linea separatrice per ogni tab principale, se ha
  // senso». Non ce l'ha: una tab è già una CARD — fondo suo, `gap-0.5` fra una
  // e l'altra, angoli arrotondati — e questo file vieta esplicitamente le
  // hairline fra card impilate («fra righe adiacenti i due capelli di un bordo
  // si leggono come LINEE DIVISORIE, esattamente ciò che stiamo togliendo»).
  // Una linea sarebbe una terza cosa che ripete quello che fill e gap dicono
  // già.
  //
  // Il problema vero era un altro, ed è MISURATO: da quando su mobile le tre
  // superfici collassano in una, il fondo di una tab a riposo stacca di
  // 1,10:1 in scuro e 1,12:1 in chiaro — cioè è appoggiato sulla soglia di
  // percettibilità, e i confini fra tab si perdono. Non manca un separatore:
  // manca il contrasto della card che il separatore avrebbe mascherato.
  // A 0.08/0.10 sale a 1,18:1 e 1,25:1, e i bordi si leggono senza aggiungere
  // un tratto. Solo sotto i 768px: sul desktop il fondo è più chiaro e il
  // rialzo attuale si vede già.
  RESTING_FILL_MOBILE + ' ' +
  'max-md:hover:bg-black/[0.12] max-md:dark:hover:bg-white/[0.14]';

/**
 * UN COMANDO, non una superficie: il «+», il cerca, il tasto che riapre la
 * colonna. Fondo OPACO, non un'alpha.
 *
 * Attilio, 07/08: «non dovrebbe essere trasparente il +, e a questo punto fare
 * uguale il relativo tasto di apertura sidebar». Aveva ragione due volte.
 *
 * · {@link RESTING_SURFACE} è un rialzo in ALPHA, e va benissimo per ciò che è
 *   una SUPERFICIE — una tab a riposo, una tessera fissata: cose che stanno sul
 *   piano e si distinguono appena. Un comando no: un comando deve leggersi come
 *   un oggetto separato da premere, e a 0,05 di nero su un chrome grigio è una
 *   sfumatura, non un bottone.
 * · E i due erano diversi fra loro senza motivo: il «+» in alpha, il tasto che
 *   riapre la colonna opaco (`bg-elevated`) — due controlli gemelli, due
 *   trattamenti.
 *
 * È una CLASSE (index.css) e non una coppia di utility Tailwind, e il motivo è
 * la shell mac: lì tutto il chrome è una lastra translucida, e un fondo opaco
 * appoggiato sopra non partecipa al vetro — «da app mi sembrano di uno schema
 * di colore diverso rispetto al grigio blur». Il colore lo deve decidere la
 * PIATTAFORMA (opaco sul web, alpha sotto vibrancy), e una decisione che dipende
 * dall'ambiente vive nel CSS, non in una stringa di classi che il chiamante
 * incolla. Il dettaglio, coi numeri, sta accanto alla regola.
 *
 * Fuori dalla shell il token è `--bg-elevated` e non `--bg-surface`:
 * quest'ultimo COLLASSA sul chrome sotto i 768px, quindi un comando dipinto con
 * quello sparirebbe nel fondo proprio sul telefono. Va accompagnato da
 * `edge-lit`, che gli dà il bordo: senza, su un fondo vicino, resta una macchia
 * senza contorno.
 */
export const RAISED_CONTROL = 'raised-control';

/**
 * LA COMPENSAZIONE OTTICA di un comando «glifo + scorciatoia».
 *
 * Attilio, 07/08: «il ⌘N ha la stessa distanza a destra e a sinistra? Mi sembra
 * che a destra sia un pochino più piccolo». Il box è simmetrico — misurato,
 * `padding: 0 8px` e i due bordi cadono esatti a 8,0 e 8,0 — ma l'INCHIOSTRO
 * no, ed è l'inchiostro che l'occhio misura:
 *
 *  · a sinistra c'è un'icona lucide, disegnata dentro un riquadro da 24 con il
 *    tratto che va da 4 a 20: due terzi del box, quindi a `size=14` porta con sé
 *    ~2,3px di aria per lato che il padding NON vede;
 *  · a destra c'è del TESTO («⌘N»), che il suo box lo riempie quasi tutto —
 *    resta meno di un pixel di margine laterale.
 *
 * Somma: ~10,3px di vuoto a sinistra contro ~8,8 a destra. Un pixel e mezzo, ed
 * era visibile. Si toglie dal padding sinistro quello che il glifo regala già:
 * 6 + 2,3 = 8,3 contro 8 + 0,8 = 8,8, cioè mezzo pixel di scarto invece di uno e
 * mezzo — sotto la soglia in cui un bordo si legge storto.
 *
 * Vale SOLO per il caso «icona a sinistra, testo a destra». Un comando con la
 * sola icona è centrato dal `justify-center` e non ha niente da compensare.
 */
export const GLYPH_KBD_PADDING = { paddingLeft: 6, paddingRight: 8 } as const;

/**
 * L'HOVER dentro la sidebar, e perché non è `hover:bg-app-hover`.
 *
 * `--bg-hover` è un colore OPACO calibrato su `--bg-surface` (le pane di
 * contenuto). La sidebar non è più quella superficie: dal 2026-08-06 è
 * `--chrome-bg`, un gradino SOTTO la pagina. Su un chrome più scuro un opaco
 * tarato per un fondo più chiaro si muove nel verso sbagliato — in tema chiaro
 * `#f5f5f5` su `#ebeef2` SCHIARISCE mentre la selezione (`bg-black/[0.06]`)
 * SCURISCE: due stati della stessa riga che vanno in direzioni opposte.
 *
 * Un rialzo in ALPHA non ha questo problema: si compone su qualunque fondo e
 * segue il tema da sé. La scala della riga è quindi una sola, in tre gradini:
 * riposo trasparente → hover 0.05/0.08 → selezionata 0.06/0.14
 * (SELECTED_SURFACE). Vale per ogni superficie che sta SUL chrome; le pane di
 * contenuto continuano a usare `hover:bg-app-hover`.
 *
 * I due numeri sono misurati sul chrome, non scelti: a 0.04/0.07 l'hover dava
 * 1,091:1 in chiaro — sotto la soglia di percettibilità di 1,1 — cioè una riga
 * in hover che non si accendeva. A 0.05/0.08 sono 1,115:1 e 1,182:1.
 */
export const SIDEBAR_HOVER =
  'hover:bg-black/[0.05] dark:hover:bg-white/[0.08]';

/**
 * Lo stesso rialzo di {@link SIDEBAR_HOVER}, ma ACCESO: il bottone di chrome
 * che tiene aperto il suo menu. È il gemello dell'idioma già in uso
 * (`aperto ? 'bg-app-hover' : 'hover:bg-app-hover'`) — un controllo aperto si
 * legge come se ci stessi sopra col mouse — riscritto in alpha per gli stessi
 * due numeri, così i due stati non possono divergere.
 */
export const SIDEBAR_ACTIVE = 'bg-black/[0.05] dark:bg-white/[0.08]';

/**
 * Two "needs you" surfaces, split by TIER so a permission gate never looks the
 * same as a finished turn (the fix for "one blue does two jobs, everything reads
 * equally urgent"). Both are the ACTUAL background of the tab/row (a solid fill
 * with white text), not a translucent overlay, and both breathe on the
 * compositor thread (an `::after` opacity pulse — see index.css).
 *
 *  - AWAITING_INPUT_SURFACE (LOUD amber): the session is blocked on a permission
 *    and needs an answer NOW → an assertive, faster/brighter pulse.
 *  - DONE_UNSEEN_SURFACE (calm blue): the turn finished / timed out → a gentle
 *    breathe that says "alive, look when you're ready".
 *
 * Pick by tier via {@link attentionSurface}. Shared by the tab bar AND the
 * sidebar so the two surfaces can't drift; change a hex here and every surface
 * of that tier moves together.
 *
 * NB: loading (running/tool-running) and awaiting are mutually exclusive in
 * time, so neither ever shows at the same instant as the loading spinner.
 */
// Each surface sets its OWN base text colour — dark on amber, white on blue —
// because white-on-amber is illegible (~2:1 contrast, the very grey-on-fill bug
// we're fixing) while black-on-amber is ~10:1, and blue wants white. Labels on a
// fill then just INHERIT this base (ON_FILL_TEXT = text-inherit), so the tier
// automatically gets the right text colour with no per-call-site branching.
/**
 * Le DUE tinte dei tier, in un posto solo.
 *
 * Erano scritte a mano in quattro punti — questo file, il pallino di
 * `SpaceSwitcher`, il chip della status bar, il pallino di `SessionActivityBar` —
 * e il quarto era GIÀ fuori sincrono: usava `bg-sky-500`, che è un blu diverso da
 * `#0a84ff`. Nessuno se ne accorge guardando un pixel per volta; si vede solo
 * mettendo due superfici accanto. Cambiare tinta richiedeva di trovarli tutti, e
 * uno era già perso.
 *
 * `#0a84ff` non è un blu qualsiasi: è il systemBlue di macOS, la stessa tinta con
 * cui il sistema segna "questo ti aspetta".
 */
export const TIER_DONE_BG = 'bg-[#0a84ff]';
export const TIER_DONE_TEXT = 'text-[#0a84ff]';
export const TIER_INPUT_BG = 'bg-amber-500';

export const AWAITING_INPUT_SURFACE =
  `${TIER_INPUT_BG} text-black animate-awaiting-attention`;
export const DONE_UNSEEN_SURFACE =
  `${TIER_DONE_BG} text-white animate-awaiting-pulse`;

/** The fill class for an attention tier: 'input' → loud amber, 'done' → calm blue. */
export function attentionSurface(tier: AttentionTier): string {
  return tier === 'input' ? AWAITING_INPUT_SURFACE : DONE_UNSEEN_SURFACE;
}

/**
 * Text classes for a label sitting ON an attention fill. They INHERIT the
 * surface's base colour (black on amber, white on blue — see above), which is
 * the fix for the "grey text on the fill" illegibility: a muted
 * `text-app-text-tertiary` timestamp / dark `text-app-text` name is swapped for
 * the surface's own high-contrast colour instead of a fixed tone that only
 * suited one tier. ON_FILL_TEXT for the primary label, ON_FILL_TEXT_SOFT
 * (dimmed) for secondary glyphs (timestamp, cloud, activity subline).
 */
export const ON_FILL_TEXT = 'text-inherit';
export const ON_FILL_TEXT_SOFT = 'text-inherit opacity-70';

/**
 * Canonical horizontal padding for a "row of content" — a tab-bar tab AND a
 * sidebar row — so the content inset reads identically on both surfaces. Tabs
 * used to be `px-2.5` (10px) while every sidebar row is `px-2` (8px), which made
 * the tabs look roomier on the left and right than the rows beneath them. One
 * shared value keeps them in lockstep; change it here and both surfaces move
 * together. (The sidebar PROJECT header is the one intentional exception — it
 * tightens its LEFT padding so the accordion chevron sits closer to the edge,
 * but keeps this value on the right so the trailing loaders stay aligned.)
 */
export const ROW_PX = 'px-2';

/**
 * IL TESTO DI UNA TAB, ovunque una tab si presenti: la barra delle pane, la
 * tessera fissata, la riga di un progetto nella colonna.
 *
 * Erano tre tipografie diverse per tre presentazioni della STESSA cosa —
 * misurate: la tab a 11px medium, la tessera a 11px normale, la riga di
 * progetto a 13px medium — più tre colori diversi a riposo. «Le tab progetti
 * sono ancora grige e sono diverse anche in peso, allineiamo tutto» (Attilio,
 * 08/08).
 *
 * Tre decisioni, e una sola ragione dietro tutte:
 *
 *  · **13px**, che è la misura più GRANDE delle tre e non un compromesso a
 *    metà: la lamentela era che i corpi sembrano piccoli, quindi si sale.
 *  · **medium** per tutte: il peso non è un modo di dire «questa è meno
 *    importante», è parte dell'identità del carattere.
 *  · **testo pieno** per tutte. A dire quale tab è quella corrente ci pensa la
 *    SUPERFICIE — è la regola che questo file già dichiara («at rest the card is
 *    transparent, so only the current/hovered/needy row reads as a filled
 *    tab»). Spegnere anche il testo diceva la stessa cosa due volte, e la
 *    seconda la diceva male: una tab a riposo diventava illeggibile da lontano.
 *
 * Chi ha bisogno di un tono diverso — un progetto tutto archiviato, una riga
 * dentro un fill di attenzione — lo aggiunge DOPO, sovrascrivendo: qui c'è la
 * base, non l'ultima parola.
 */
/*
 * E LA MISURA È DUE, PERCHÉ GLI SCHERMI SONO DUE — ma le superfici no.
 *
 * Sopra c'è scritto «13px, che è la misura più GRANDE delle tre». Era vero fra
 * quelle tre, ma ne mancava una: le RIGHE della colonna, che non passavano di
 * qui e stavano già a `text-[14px] md:text-[13px]` (TopicItem, TopicTree). Cioè
 * sul telefono una riga era 14 e la tessera fissata accanto a lei 13 — misurato
 * a 390×844, nella stessa colonna, una sopra l'altra.
 *
 * Si allinea verso l'ALTO, non verso il basso: la lamentela da cui viene questo
 * blocco era che i corpi sembrano piccoli, quindi a muoversi è la tessera che
 * sale a 14, non la riga che scende a 13. Sul desktop restano tutte 13, dove
 * quel numero era già stato scelto e misurato.
 */
export const TAB_LABEL = 'text-[14px] md:text-[13px] font-medium text-app-text';

/**
 * The single horizontal inset (px) of a list of tabs/rows from its panel edge —
 * SHARED by the sidebar AND the tab bar so the two lists line up at the sides
 * AND so a list item's side gap equals a tab's TOP/BOTTOM gap (the spacing reads
 * the same horizontally and vertically). 6px = the vertical breathing room
 * around a tab in the tab bar: the chrome row is 40px tall, a tab is 28px, so
 * (40 − 28) / 2 = 6px above and below each tab. Matching that exactly is why it
 * is 6 and not the old 4 (`py-1`, which is only part of that gap) or 8.
 * Used as: the sidebar card's edge margin (the `mx-1.5` class in `sidebarRowCard`
 * is its class-equivalent), the depth-0 base for sidebar row indentation, and
 * the tab strip's left/right padding (PaneTabBar). Keep them all in step here.
 */
export const ROW_INSET = 6;
/**
 * IL PASSO DELLA COLONNA, uno solo: la distanza fra due card è la stessa che le
 * separa dal bordo.
 *
 * Ce n'erano due. Le tessere fissate stavano a `TILE_GAP = 6`, le righe a
 * `my-px` — cioè 2px fra una card e l'altra: nella stessa colonna, due ritmi.
 * «I pinhead hanno uno spazio tra di loro diverso» (Attilio, 08/08), ed era
 * vero da entrambe le parti: a 2px due card col fondo si leggono quasi come una
 * fascia continua, che è il difetto da cui veniamo.
 *
 * Sei, e non due, perché è il numero che la colonna già usa lateralmente
 * (`ROW_INSET`): con lo stesso valore su tutti e quattro i lati l'aria attorno a
 * una card è quadrata, e il ritmo si legge come una griglia invece che come una
 * pila. Il valore vive qui e non in `PinnedTiles`, che ora lo importa: erano due
 * numeri d'accordo per caso.
 */
export const COLUMN_GAP = 6;
/**
 * LO STESSO PASSO, GIRATO DI NOVANTA GRADI — e adesso è davvero lo stesso.
 *
 * Fra due tab della barra c'era `gap-0.5`, cioè DUE pixel, e fra due card della
 * colonna sei. Non erano due scelte: erano lo stesso numero prima e dopo una
 * correzione applicata a metà. Il commento di `sidebarRowCard` lo dice ancora
 * («il ritmo verticale segue il passo stretto della tabbar, gap-0.5 = 2px»),
 * ma quel passo verticale è passato a `COLUMN_GAP` il 09/08 mentre l'orizzontale
 * è rimasto indietro: la stessa card, messa in fila, respirava un terzo di
 * quanto respira impilata.
 *
 * «Normalizza spaziature e dimensioni in tutte le tab sia verticali che
 * orizzontali» (Attilio, 09/08). È lo stesso valore, e per questo è la stessa
 * costante: un `gap-1.5` scritto a mano nella barra tornerebbe a poter divergere
 * al primo che tocca uno dei due.
 */
export const TAB_GAP_CLASS = 'gap-1.5';

/**
 * L'INTESTAZIONE DI UNA SEZIONE È UNA CARD, come tutto il resto.
 *
 * «Facciamo diventare gli accordion della sidebar progetto delle card, come le
 * tab» (Attilio, 09/08). Erano tre righe a tutta larghezza — `h-8 px-3`, testo a
 * 12px secondario, un `border-b` sotto quella chiusa e due `h-[1px]` fra le
 * sezioni — cioè l'ULTIMA superficie dell'app rimasta fuori dalla grammatica
 * delle card: rientrata da nessun lato, con la sua tipografia e i suoi fili.
 *
 * Adesso è la stessa card di una tab e di una riga della colonna: stesso fondo a
 * riposo, stesso corpo, stesso incasso laterale (`mx-1.5` = ROW_INSET), stesso
 * mezzo passo verticale (`my-[3px]` = COLUMN_GAP/2), stesso raggio. E i fili se
 * ne vanno da soli: fra card impilate una linea ripete ciò che fondo e distanza
 * dicono già — è la regola che questo file dichiara in testa a `sidebarRowCard`.
 *
 * Vive qui e non in `ProjectSidebar` perché le intestazioni sono TRE e stanno in
 * DUE file (Git ha la sua dentro `GitChanges`): due copie della stessa
 * grammatica divergono al primo che viene ritoccato da solo.
 */
export const SECTION_CARD =
  `group edge-lit flex items-center gap-1.5 ${ROW_PX} h-9 md:h-7 ${TAB_LABEL} ${RESTING_SURFACE} ` +
  'rounded-lg mx-1.5 my-[3px] transition-colors cursor-pointer select-none flex-shrink-0 overflow-hidden';

/**
 * LE TRE SEZIONI IN RIGA — la stessa card, rimessa in orizzontale.
 *
 * Non è una famiglia nuova: è `SECTION_CARD` senza i margini (li mette la riga
 * che le contiene, una volta sola) e con `flex-1 min-w-0` perché tre chip in
 * una colonna da 224px si dividono lo spazio invece di sfondarlo. L'etichetta
 * tronca, il glifo e la pastiglia no — sono loro a dire «quale» e «quanto»
 * quando il nome non ci sta.
 *
 * Attiva NON è hover: è la stessa superficie di una tab selezionata
 * (`SELECTED_SURFACE`), perché è esattamente ciò che è — la sezione che stai
 * guardando, in una riga che ne mostra una alla volta.
 */
export const SECTION_TAB =
  `group edge-lit flex items-center justify-center gap-1.5 px-2 h-9 md:h-7 ${TAB_LABEL} ` +
  'rounded-lg transition-colors cursor-pointer select-none flex-1 min-w-0 overflow-hidden';

/**
 * La striscia dei comandi di una sezione aperta: la sua intestazione senza
 * l'intestazione. Quando il nome e l'apri/chiudi salgono nella riga di chip,
 * di quella card resta solo il gruppo di controlli — ramo, ahead/behind,
 * cronologia, nuovo file — e deve stare a destra, alla stessa altezza di una
 * card, senza fondo suo: la superficie sotto è già quella del pannello.
 */
export const SECTION_TOOLS =
  'flex items-center justify-end gap-1 h-7 px-1.5 mx-1.5 flex-shrink-0 min-w-0';
/** Indent added per nesting level for sidebar child rows (px). */
export const SIDEBAR_INDENT_STEP = 16;

/**
 * IL GLIFO IN TESTA A UNA RIGA — una misura sola, e uno slot che non balla.
 *
 * Era scritto a mano in quattro punti, e il numero scelto era il peggiore
 * possibile: 13. Lucide disegna dentro un riquadro da 24 con tratto 2, quindi a
 * 13px il tratto vale 1,083px — non cade su un pixel — mentre a 14 vale 1,167 e
 * a 12 esattamente 1. E in una riga alta 34 un glifo da 13 lascia (34−13)/2 =
 * 10,5px sopra e sotto: MEZZO pixel, contro i 10 esatti dei vicini che stanno
 * già a 14 (il progetto, il browser). Un glifo fuori asse di mezzo pixel
 * rispetto a quello sopra e a quello sotto è esattamente ciò che fa sembrare
 * storta una colonna senza che si riesca a dire perché.
 *
 * {@link ROW_GLYPH_SLOT} è l'altra metà: un contenitore di larghezza FISSA che
 * centra qualunque glifo ci finisca dentro. Senza, ogni riga faceva partire il
 * proprio nome da una x diversa — la board a 27px dal bordo della card, un
 * progetto a 48, una chat a 8 — cioè tre colonne per la stessa cosa. Con lo
 * slot, board, utility, terminali e browser condividono UNA colonna del nome, e
 * un glifo che cambia misura (l'icona di Claude contro quella di un terminale)
 * non la sposta.
 *
 * 18px e non 14: i due px di aria per lato tengono dentro anche i glifi che
 * lucide disegna più larghi dell'inchiostro nominale, senza toccare la colonna.
 */
export const ROW_GLYPH = 14;
export const ROW_GLYPH_SLOT = 'w-[18px] shrink-0 flex items-center justify-center';

/**
 * IL BOX DI UN COMANDO IN CODA A UNA RIGA — uno solo, per tutte le righe.
 *
 * Attilio, 07/08: «il tasto per poter spuntare una tab e chiuderla è troppo
 * piccolo e, fra l'altro, non è neanche allineato ai più che ci sono sui
 * progetti». Erano quattro misure diverse nello stesso binario, e si vedono
 * solo mettendo le righe una sopra l'altra — cioè come la sidebar si guarda:
 *   · chat, comando d'archivio su desktop          28px (`w-7 h-7`)
 *   · progetto, cerchio d'archivio e «+»           24px (`w-6 h-6`)
 *   · terminale e browser, cerchio di chiusura     24px, più `mr-1`
 *   · «+» della barra delle tab                    24px
 * Quattro colonne diverse a destra, e la più piccola era proprio quella del
 * gesto che CHIUDE una cosa.
 *
 * 28px sopra i 768px: quanto una tab della barra (`h-7`) e quanto la riga alta
 * 34 può contenere senza che l'`overflow-hidden` della card lo tagli. 36px
 * sotto, dentro la riga da 44 — non i 44 pieni delle linee guida iOS, ma
 * `tap-expand-y` porta l'AREA a 44 in altezza senza rubare larghezza ai vicini
 * (vedi index.css). Il glifo dentro resta piccolo: cresce il bersaglio, non il
 * disegno.
 *
 * VALE ANCHE NELLA BARRA DELLE TAB, e le due misure sono le stesse della tab
 * perché ora seguono lo STESSO breakpoint. C'è stato un giro in cui il comando
 * della barra era stato rimpicciolito a 28 fisso per far tornare l'aria
 * verticale: sbagliato due volte. Primo, «hai fatto i tasti più piccoli ma non
 * dovevi» (Attilio, 09/08) — il difetto era orizzontale. Secondo, i 2px di aria
 * misurati non venivano dal box ma da un DISACCORDO DI PREDICATO: la tab
 * decideva la propria altezza con `isTouch` (JS) e il comando col breakpoint
 * `md:` (larghezza), quindi in una finestra stretta SENZA touch — un desktop
 * ristretto, e la sonda di misura — la tab era 28 e il comando 36 nella stessa
 * riga. Adesso anche la tab è `h-9 md:h-7`: l'altezza è una domanda di LAYOUT e
 * la decide la larghezza, come dice `useMobile` («affordance touch → isTouch;
 * quante colonne → larghezza»). `isTouch` resta dove serve davvero: long-press,
 * drag nativo, comandi che l'hover nasconderebbe.
 */
export const ROW_ACTION_BOX = 'w-9 h-9 md:w-7 md:h-7';

/**
 * L'ALTEZZA UTILE DELLA RIGA DI CHROME, e il respiro che lascia a ciò che ci sta
 * dentro.
 *
 * ED È 40, NON PIÙ 39, da quando la riga non porta il `border-b`: quel pixel di
 * bordo mangiava l'altezza del contenuto e rompeva la divisione — (39 − 28)/2 =
 * 5,5 sopra e sotto contro i 6 di lato, cioè mezzo pixel di scarto fra il
 * respiro verticale e quello orizzontale dello STESSO bottone. Con la barra
 * diventata vetro (`.pane-chrome-bar`) il contenuto vale 40 e il conto torna.
 *
 * `chromeRowInset` NON decide niente: RIPORTA. Lo spazio verticale attorno a un
 * box dentro questa riga non è una scelta, cade fuori dall'aritmetica — e serve
 * saperlo per una ragione sola, controllare che il comando e la TAB che gli sta
 * accanto lascino lo stesso respiro. Ci stanno entrambi a 28 col mouse (6 e 6) e
 * a 36 col dito (2 e 2), perché ora hanno la stessa misura e lo stesso
 * breakpoint: il bloccaggio è in `selectionStyles.test.ts`.
 */
export const CHROME_ROW_CONTENT_H = 40;
export function chromeRowInset(box: number): number {
  return (CHROME_ROW_CONTENT_H - box) / 2;
}
/** I due box di {@link ROW_ACTION_BOX} in pixel, e il loro incasso. Espressi
 *  qui perché servono in CLASSI (`md:`), non in uno stile in linea: il
 *  breakpoint che decide il box deve essere lo STESSO che decide la riserva a
 *  destra della strip, o su qualche dispositivo i due si disallineano — cosa
 *  che un predicato JS (`isMobile` vale <768, ma <1024 se il puntatore è
 *  grossolano) non garantirebbe. */
export const ROW_ACTION_BOX_PX = { touch: 36, desktop: 28 } as const;

/**
 * QUANTO IL COMANDO STA LONTANO DAL BORDO DELLA RIGA — ed è {@link ROW_INSET},
 * non il respiro verticale.
 *
 * Era `chromeRowInset(box)`: 2 col dito, 6 col mouse. Cioè sul telefono il «+»
 * e il tasto che riapre la colonna stavano DUE pixel dal bordo — incollati —
 * mentre la strip senza comando si ferma a 6 (`pl-1.5`/`pr-1.5`). Il bordo è
 * un fatto ORIZZONTALE e ha già il suo numero: quello con cui ogni riga della
 * colonna e ogni tab stanno lontane dal loro bordo. Il respiro verticale è
 * un'altra cosa e non si sceglie — lo lascia la riga.
 *
 * Le classi sono scritte PER ESTESO e non composte in un template: Tailwind
 * genera le utility leggendo i sorgenti come TESTO, quindi un
 * `right-[${n}px]` non produce nessuna regola e il bottone finirebbe
 * semplicemente a `right: 0`. L'aritmetica non resta però appesa a un commento
 * — la ricalcola `selectionStyles.test.ts`, che confronta questi letterali con
 * `ROW_INSET` e fallisce appena i due si separano.
 */
export const CHROME_ROW_ACTION_INSET = 'right-[6px]';
/** Lo stesso incasso, specchiato: il comando che apre la sidebar sta in TESTA
 *  alla riga come il «+» sta in coda. Era `pl-1` su un box da 24px forzato con
 *  due `!important` — «è troppo piccolo e deve essere allineato graficamente al
 *  tasto di aggiunta» (Attilio, 08/08). Stesso box, stesso incasso, stessa
 *  scatola rialzata: le due estremità della riga si leggono come una coppia. */
export const CHROME_ROW_ACTION_INSET_LEFT = 'left-[6px]';
/**
 * DOVE SI FERMA LA STRIP: bordo + comando + un'aria uguale a quella del bordo.
 *
 * `ROW_INSET + box + ROW_INSET` — 6+36+6 = 48 col dito, 6+28+6 = 40 col mouse.
 * I tre pezzi ci sono tutti e nessuno è arrotondato: il comando sta 6 dal bordo
 * (CHROME_ROW_ACTION_INSET), occupa il suo box, e la tab si ferma altri 6 prima
 * di lui.
 *
 * Prima erano `box + chromeRowInset(box)` = 38 col dito e 34 col mouse, cioè il
 * VERTICALE riusato come orizzontale: la strip finiva ESATTAMENTE sul bordo
 * della scatola del comando, zero aria fra la tab e il bottone. «Il + e apri
 * sidebar … senza aria giusta rispetto ai bordi e alle tab» (Attilio, 09/08):
 * i due difetti erano questi due, e sono lo stesso errore preso da due lati.
 *
 * La riserva cambia col breakpoint perché il box cambia col breakpoint
 * ({@link ROW_ACTION_BOX}: `w-9` sotto i 768px, `md:w-7` sopra), e ha quindi la
 * forma `base + md:`. Letterali per la ragione di sempre — Tailwind legge il
 * sorgente come testo — e ricalcolati da `selectionStyles.test.ts`, che li
 * confronta con `ROW_ACTION_BOX_PX` e `ROW_INSET`.
 */
export const CHROME_ROW_ACTION_RESERVE = 'pr-[48px] md:pr-[40px]';
/**
 * LO STESSO SPAZIO, SPECCHIATO — e prima non lo era.
 *
 * In testa alla strip sta il comando che riapre la colonna, in coda il «+»:
 * due bottoni gemelli, stesso box e stesso incasso (`CHROME_ROW_ACTION_INSET`
 * e il suo gemello sinistro lo dicono già). La riserva però era scritta con due
 * grammatiche diverse: a destra questa costante, che segue il box; a sinistra
 * un `paddingLeft: 30` inline in PaneTabBar — un numero fisso, uguale sui due
 * breakpoint, che non seguiva niente.
 *
 * Misurato a schermo: strip `padding-left: 30px` contro `padding-right: 34px`
 * col mouse, e 30 contro 38 col dito. Cioè la prima tab stava 4px (desktop) e
 * 8px (touch) più vicina al suo comando di quanto l'ultima stesse al «+» —
 * «dovrebbero avere aria intorno uguale, anche rispetto alle tab a inizio e
 * fine scroll» (Attilio, 09/08).
 *
 * Letterali per la stessa ragione dell'altra: Tailwind legge il sorgente come
 * testo. E come l'altra, `selectionStyles.test.ts` ricalcola i due numeri dal
 * box e dall'incasso, così non possono più separarsi in silenzio.
 */
export const CHROME_ROW_ACTION_RESERVE_LEFT = 'pl-[48px] md:pl-[40px]';

/**
 * LA RIGA DELLE TAB, UNA VOLTA SOLA — e ora che è un vetro conta il doppio.
 *
 * Era la stessa stringa ricopiata in cinque punti (quattro rami di
 * `GroupLayout`, uno in `StandaloneChatGroup`). Finché era «una riga con un
 * filo sotto» la copia costava poco; adesso porta anche il posizionamento
 * `absolute` di `.pane-chrome-bar`, e un ramo che se lo scorda non è una
 * differenza estetica: è una barra che torna dentro il flusso e spinge giù la
 * pane di 40px mentre le sorelle no.
 *
 * Chi la monta deve fare DUE cose, e nessuna delle due è opzionale:
 *  1. dare `relative` alla card che la contiene (senza, la barra si ancora al
 *     primo antenato posizionato, che è un'altra cella);
 *  2. dichiarare {@link CHROME_BAR_H_VAR} sulla stessa card — da lì la leggono
 *     sia il rientro delle pane che NON passano sotto (`paneCellTopInset`) sia
 *     il varco in cima alla conversazione (l'`Header` di Virtuoso).
 */
export const CHROME_BAR = 'pane-chrome-bar chrome-glass flex items-center h-10 flex-shrink-0 overflow-hidden min-w-0';

/** L'altezza della riga di chrome come variabile CSS, da mettere sulla card che
 *  possiede la barra. `h-10` = 40: il valore vive qui perché sia UN numero e non
 *  tre, e {@link CHROME_ROW_CONTENT_H} è lo stesso numero visto dall'aritmetica
 *  dell'incasso — l'uguaglianza la controlla `selectionStyles.test.ts`. */
export const CHROME_BAR_H = 40;
export const CHROME_BAR_H_VAR = { '--chrome-bar-h': `${CHROME_BAR_H}px` } as CSSProperties;

/**
 * LA RIGA SUBORDINATA: l'aria fra due barre impilate è UNA, e la seconda non la
 * ripete.
 *
 * Dentro una finestra di progetto le righe di chrome sono due — quella dell'app
 * con la TAB del progetto, e sotto quella del progetto con le sue pane. Ognuna
 * portava i suoi 6 di aria, quindi fra la tab sopra (finisce a y=34) e la card
 * sotto (cominciava a y=46) passavano DODICI px, mentre ogni altra coppia di
 * card dell'app ne ha sei. «Ancora vedo le tabbar troppo lontane» (Attilio,
 * 09/08), e aveva ragione: era il passo dell'app raddoppiato.
 *
 * La regola è quella che la colonna usa già un piano più giù — «ognuno porta
 * metà passo, e il primo non porta la sua perché sopra c'è chi l'ha già messa»
 * (vedi `.sidebar-column` in index.css). Qui: l'aria SOTTO la tab dell'app e
 * l'aria SOPRA la card del progetto sono la stessa aria. La riga figlia non la
 * paga: tiene solo la propria, in coda.
 *
 * Quindi 34 = box(28) + ROW_INSET(6), con l'incasso solo SOTTO. La scatola del
 * contenuto vale 28, `items-center` la centra su se stessa, e la card cade a
 * 40..68: sei px dall'inchiostro di sopra, sei sotto prima del contenuto.
 *
 * SOLO SOPRA I 768px, e non per prudenza: col dito la tab è 36 e la riga ne
 * lascia già 2 per lato — non c'è aria ripetuta da togliere, e 36 in 34 non ci
 * starebbe comunque (lo taglierebbe l'`overflow-hidden` della barra). Là resta
 * 40, e il varco fra le due righe è 4.
 *
 * `--chrome-bar-h` NON può restare lo stile in linea di {@link CHROME_BAR_H_VAR}:
 * uno stile in linea nessuna media query lo raggiunge, e quella variabile
 * alimenta il rientro delle celle (`paneCellTopInset`) e il varco in cima alla
 * conversazione. Diventa quindi una coppia di utility con lo STESSO breakpoint
 * di `md:h-[34px]` — non un `@media (min-width: 768px)` scritto a mano: `md:` è
 * 48rem, e con una root-font diversa i due predicati divergerebbero. È lo stesso
 * disaccordo già pagato una volta (tab 28 e comando 36 sulla stessa riga).
 */
export const CHROME_ROW_SUB_H = ROW_ACTION_BOX_PX.desktop + ROW_INSET;
export const CHROME_BAR_SUB =
  'pane-chrome-bar chrome-glass flex items-center h-10 md:h-[34px] md:pb-[6px] flex-shrink-0 overflow-hidden min-w-0';
/** La variabile, per la card che possiede una barra subordinata. Va al POSTO di
 *  {@link CHROME_BAR_H_VAR}: uno stile in linea batte la classe, quindi i due
 *  insieme lascerebbero la riga a 40 con l'inchiostro appeso in cima. */
export const CHROME_BAR_SUB_H_CLASS = '[--chrome-bar-h:40px] md:[--chrome-bar-h:34px]';

/**
 * Il diametro DISEGNATO del cerchio «fatto / chiudi» (`PendingActionRing`).
 * Era 14 dentro un box da 24: un pallino. A 16 dentro {@link ROW_ACTION_BOX}
 * resta un anello sottile con la sua aria attorno, e si vede cosa si sta per
 * toccare.
 */
export const ROW_ACTION_GLYPH = 16;

/**
 * Shared "card" styling for EVERY sidebar row (topics, terminals, browsers,
 * project folders) so the sidebar reads as a column of tab-like cards — the
 * same visual language as the tab bar — instead of a flat list separated by
 * hairline dividers. Deliberately NO border: between stacked rows a border's
 * top+bottom hairlines read as dividing LINES, the exact thing we're removing.
 * A filled, inset, rounded surface is what makes each row a self-contained card.
 *
 * Pass the row's selection state; returns the full set of state classes. Each
 * caller keeps its own height / padding-left (depth indent) / content.
 */
export function sidebarRowCard(
  { focused, open, attention, nested }:
  { focused?: boolean; open?: boolean; attention?: AttentionTier | null;
    /**
     * Riga ANNIDATA — una sotto-tab dentro un progetto aperto.
     *
     * Cambia una cosa sola: niente fondo del riposo. «Quando apri una tab
     * pinnata che ha delle sotto-tab, quelle sono wrappate da card, forse si
     * può togliere» (Attilio, 08/08) — e ha ragione: a quel punto le card sono
     * due, una dentro l'altra, e la seconda non aggiunge niente perché
     * l'indentazione ha già detto dove sta. La FORMA resta, così la riga
     * selezionata o in hover si accende come le sorelle di primo livello: è il
     * riposo a doversi zittire, non la selezione.
     */
    nested?: boolean },
): string {
  // Card SHAPE (rounded, inset, spaced) is always on; the FILL follows the
  // color system — background only when selected (SELECTED_SURFACE), needing you
  // (attention fill) or on hover. At rest the card is transparent, so the sidebar
  // stays calm and only the current/hovered/needy row reads as a filled tab.
  // Horizontal inset (mx-1.5 = 6px = ROW_INSET) keeps the card off the
  // sidebar edges by the SAME amount as a tab's top/bottom gap in the tab bar
  // ((40 − 28)/2), so the side gap reads identical to the vertical one. Il passo
  // FRA due card è {@link COLUMN_GAP}, mezzo per ciascuna (`my-[3px]`), ed è lo
  // stesso della barra delle tab: là lo scrive {@link TAB_GAP_CLASS}.
  //
  // Qui c'era scritto il contrario — «il ritmo verticale segue il passo stretto
  // della tabbar, gap-0.5 = 2px» — ed è rimasto vero per un giorno: il passo
  // verticale è salito a sei, quello orizzontale no, e la stessa card in fila
  // respirava un terzo di quanto respira impilata. Adesso il numero è uno solo.
  // Sotto i 768px la card porta anche il FONDO DEL RIPOSO, e i valori sono
  // quelli di `RESTING_SURFACE` (ramo `max-md:`): nella stessa colonna una
  // tessera fissata e una riga devono essere la stessa cosa, ed era la loro
  // differenza a far sembrare «brutto» il filetto separatore che c'era prima.
  //
  // Ci è arrivato per due strade sbagliate: prima un `divide-y` (una linea fra
  // le righe), poi una regola CSS che dipingeva la riga INTERA da bordo a bordo
  // — «sono full width i progetti invece di essere card». Il posto giusto è
  // qui, sulla scatola che è già rientrata e arrotondata: stesso colore, ma
  // disegnato dove c'è una card e non una fascia.
  //
  // STAVA NEL `base`, E ERA UN BACO: L'ORDINE DELLA STRINGA NON È LA CASCATA.
  //
  // Qui c'era scritto «sta nel base e non fra i rami del fill, quindi
  // selezione, attenzione e hover — che arrivano dopo nella stringa — lo
  // coprono senza gare di specificità». Falso, e verificabile: `cn()` è clsx
  // puro (nessun tailwind-merge), quindi base e fill restano ENTRAMBI
  // sull'elemento, e a specificità pari vince chi il bundle emette per ultimo.
  // Le utility `max-md:` stanno in fondo al foglio, dentro la loro media query;
  // `bg-black/[0.06]` (selezione), `bg-amber-500` e `bg-[#0a84ff]` (attenzione)
  // stanno migliaia di byte più su. Vinceva il riposo.
  //
  // Effetto, sul telefono e solo lì: quattro stati e UN fondo. La riga
  // selezionata, quella che ti aspetta in ambra e quella finita in blu si
  // dipingevano tutte come una a riposo. L'ho visto nella mia stessa misura a
  // 390×844 senza riconoscerlo — una riga in semibold (cioè su un fill di
  // attenzione) con fondo `oklab(0 0 0 / 0.08)`, identico alle vicine.
  //
  // Il riposo scende quindi nei DUE rami che non dipingono niente, ed è la
  // stessa forma che tessera e tab hanno sempre avuto: un ternario che sceglie
  // UNA superficie, mutuamente esclusiva (PinnedTile, PaneTabBar). Le righe
  // concatenavano: stessa grammatica, due meccanismi.
  const base = 'mx-1.5 my-[3px] rounded-lg overflow-hidden transition-colors duration-100 relative';
  // Il fondo del riposo si porta dietro il suo BORDO, e solo dove il fondo c'è:
  // `edge-lit-mobile` (index.css) vive dentro la stessa media query di
  // `max-md:`, quindi sul desktop — dove la riga a riposo è trasparente — non
  // disegna niente. Senza, tessera e tab avevano la card chiusa e la riga no.
  const riposo = nested ? '' : ` ${RESTING_FILL_MOBILE} edge-lit-mobile`;
  // L'ATTENZIONE PRECEDE la selezione, e non è un cambio di priorità: è che
  // FOCUS WINS non si decide più qui.
  //
  // Prima questa funzione lo implementava da sé (`if (focused) → neutro`), e la
  // stessa regola era ricopiata in altri tre punti con tre definizioni diverse di
  // "focussato". Il risultato era che "l'ho visto" voleva dire "l'ho selezionato",
  // anche per un istante: un clic di passaggio spegneva il fill di una chat mai
  // letta. Ora la regola sta in `attentionFillFor` (state/signals.ts), che pretende
  // uno sguardo di SEEN_DWELL_MS con la finestra sveglia, e il chiamante passa qui
  // un `attention` GIÀ risolto — null quando la riga è stata vista.
  //
  // Quindi: se arriva un tier, va dipinto (il chiamante ha già stabilito che
  // l'utente non l'ha guardata); altrimenti valgono selezione e hover come prima.
  // `edge-lit` SOLO quando la card ha un fondo. Il bordo riflesso (index.css)
  // disegna la forma della superficie: su una riga a riposo — che è
  // trasparente — disegnerebbe un rettangolo attorno a ogni riga dell'albero,
  // cioè esattamente le linee divisorie che questo file esiste per togliere.
  // Con un fill sotto, invece, è la stessa card della tab selezionata.
  if (attention) return `${base} edge-lit ${attentionSurface(attention)}`;
  if (focused) return `${base} edge-lit ${SELECTED_SURFACE}`;
  if (open) return `${base}${riposo} text-app-text ${SIDEBAR_HOVER}`;
  return `${base}${riposo} text-app-text-secondary ${SIDEBAR_HOVER} hover:text-app-text`;
}
