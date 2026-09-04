/**
 * Il menu del tasto destro DENTRO la pane browser nativa.
 *
 * Il gesto lo raccoglie la pagina (`paneContextModel.ts`), il menu lo disegna
 * l'app. Passa da `ContextMenuPortal` e non da un `div` scritto qui, e la ragione
 * non è il riuso: quel portal porta `role="menu"` e `.glass-surface`, cioè i due
 * marcatori di `OVERLAY_SELECTOR` (lib/shell/browserOcclusion). Sono loro a far
 * congelare la pane in un fermo-immagine e a parcheggiare la WKWebView fuori
 * schermo. Una vista nativa composita SOPRA il DOM: senza quei marcatori questo
 * menu si disegnerebbe sotto la pagina e non lo vedrebbe nessuno.
 *
 * Le voci le decide `paneContextItems` (pura, testata): niente «Copia» senza
 * selezione e niente «Copia link» dove non c'è un link, perché una voce che non
 * fa niente è peggio di una voce che manca. Indietro e avanti invece restano
 * sempre e si DISABILITANO ai capi della cronologia: una voce che va e viene
 * sposta le altre sotto il cursore.
 */
import { useCallback } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Copy,
  Link2,
  Link,
  ExternalLink,
  Image as ImageIcon,
  Code2,
  type LucideIcon,
} from 'lucide-react';
import { ContextMenuPortal } from '../Shared/ContextMenuPortal';
import { POPOVER_ITEM, POPOVER_DIVIDER } from '../../lib/popoverStyles';
import { useToast } from '../Shared/Toast';
import { useT } from '../../hooks/useT';
import { copyText, copyImagePng } from '../../lib/clipboard';
import { paneContextItems, type PaneMenuItemKey } from './paneContextModel';
import type { NativeBrowserHandle } from './browserDevTypes';

export interface PaneContextMenuProps {
  browser: NativeBrowserHandle;
  /** Apri questo indirizzo in una scheda nuova. Lo sa fare solo il livello che
   *  possiede il layout, quindi arriva da fuori. */
  onOpenInNewTab: (url: string) => void;
}

export function PaneContextMenu({ browser, onOpenInNewTab }: PaneContextMenuProps) {
  const target = browser.paneContext ?? null;
  const tr = useT();
  const toast = useToast();
  const close = browser.clearPaneContext;

  const copySelection = useCallback(async () => {
    // Il testo INTERO, riletto adesso: quello dentro `target` è tagliato a 200
    // caratteri e serviva solo a decidere se questa voce esisteva.
    const full = (await browser.readSelection?.()) || target?.selection || '';
    if (!full) return;
    if (!(await copyText(full))) toast.error(tr('browser.menu.copyFailed'));
  }, [browser, target?.selection, toast, tr]);

  const copyImage = useCallback(async (src: string) => {
    // La promessa entra DENTRO ClipboardItem invece di essere attesa prima: in
    // WebKit una scrittura in clipboard vuole il gesto dell'utente, e l'attesa
    // dell'estrazione (fino a 3s) lo avrebbe consumato. Vedi copyImagePng.
    const ok = await copyImagePng(browser.readImageDataUrl?.(src) ?? Promise.resolve(null));
    if (!ok) {
      // Senza CORS il canvas resta contaminato e i byte non si possono leggere:
      // lo si dice, e si offre la cosa che invece riesce sempre.
      toast.error(tr('browser.menu.imageNotCopyable'), 6000, {
        label: tr('browser.menu.copyAddress'),
        onClick: () => { void copyText(src); },
      });
    }
  }, [browser, toast, tr]);

  if (!target || !close) return null;

  const items = paneContextItems(target);
  // Un separatore fra i gruppi: navigazione · selezione/link/immagine · ispeziona.
  const run = (fn: () => void | Promise<unknown>) => () => { close(); void fn(); };

  const rows: Record<PaneMenuItemKey, { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean }> = {
    back: { icon: ArrowLeft, label: tr('browser.menu.back'), onClick: run(() => browser.goBack()), disabled: browser.canGoBack === false },
    forward: { icon: ArrowRight, label: tr('browser.menu.forward'), onClick: run(() => browser.goForward()), disabled: browser.canGoForward === false },
    reload: { icon: RotateCw, label: tr('browser.menu.reload'), onClick: run(() => browser.reload()) },
    copy: { icon: Copy, label: tr('browser.menu.copy'), onClick: run(copySelection) },
    copyLink: { icon: Link2, label: tr('browser.menu.copyLink'), onClick: run(() => copyText(target.linkUrl)) },
    openLink: { icon: ExternalLink, label: tr('browser.menu.openLink'), onClick: run(() => onOpenInNewTab(target.linkUrl)) },
    copyImage: { icon: ImageIcon, label: tr('browser.menu.copyImage'), onClick: run(() => copyImage(target.imageUrl)) },
    copyImageAddress: { icon: Link, label: tr('browser.menu.copyImageAddress'), onClick: run(() => copyText(target.imageUrl)) },
    inspect: { icon: Code2, label: tr('browser.menu.inspect'), onClick: run(() => browser.toggleDevTools()) },
  };

  return (
    <ContextMenuPortal open x={target.x} y={target.y} onClose={close} minWidth={220}>
      {items.map((key, i) => {
        const row = rows[key];
        // I divisori nascono dal CONTENUTO, non da un elenco a mano: «copia» è la
        // prima voce del gruppo di mezzo solo quando c'è una selezione, e
        // «ispeziona» chiude sempre.
        const divider = key === 'copy' || key === 'inspect'
          || (key === 'copyLink' && !items.includes('copy'))
          || (key === 'copyImage' && !items.includes('copy') && !items.includes('copyLink'));
        return (
          <div key={key}>
            {divider && i > 0 && <div className={POPOVER_DIVIDER} />}
            <button
              type="button"
              role="menuitem"
              disabled={row.disabled}
              onClick={(e) => { e.stopPropagation(); row.onClick(); }}
              className={`${POPOVER_ITEM} disabled:opacity-40`}
              data-testid={`browser-pane-ctx-${key}`}
            >
              <row.icon size={13} className="shrink-0 text-app-text-tertiary" aria-hidden /> {row.label}
            </button>
          </div>
        );
      })}
    </ContextMenuPortal>
  );
}
