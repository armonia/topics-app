import { useContext, useRef, type ReactNode } from 'react';
import { PaneKeyContext } from '../../state/pane/residency/holds';
import { PaneAliveContext } from '../../state/paneLiveness';
import { ErrorBoundary } from '../Shared/ErrorBoundary';

/**
 * Il guscio keep-alive di una pane: visibile con `display:flex`, nascosta con
 * `display:none` — e, mentre è nascosta, con il sottoalbero CONGELATO.
 *
 * Perché il congelamento. Le pane visitate restano montate per non perdere
 * scroll, buffer del terminale e cache di cronologia; ma restare montate
 * significava anche RI-RENDERIZZARE a ogni render del gruppo. Con una dozzina di
 * tab aperte, un click su una tab ricostruiva l'albero di TUTTE, per aggiornare
 * pane che nessuno stava guardando. Misurato A/B (12 tab, 20 switch attesi fino
 * al commit della tab, profilo CPU via CDP): mediana per switch 491ms → 352ms,
 * ms bloccanti 2447 → 1642, long task 28 → 23, fps durante gli switch 19 → 23.
 *
 * Il congelamento riusa l'ELEMENTO React del render precedente: stesso
 * riferimento ⇒ React salta l'intero sottoalbero. Non è un `memo`, che qui non
 * servirebbe a niente — le props di una pane sono closure ricreate a ogni render
 * del gruppo, e nessun confronto superficiale le vedrebbe mai uguali.
 *
 * Cosa NON congela, di proposito:
 *  - il passaggio visibile→nascosto, che viene renderizzato una volta con le
 *    props aggiornate. È ciò che consegna `isVisible=false` a chi possiede una
 *    view di sistema (le pane browser spengono la WKWebView) o una cadenza di
 *    poll: congelare anche quel render lascerebbe una pagina viva dietro una tab
 *    che nessuno guarda — l'esatto contrario dello scopo.
 *  - lo stato INTERNO della pane e i context che consuma: React li propaga
 *    attraverso il bailout. Una chat nascosta continua a ricevere i suoi
 *    messaggi; si congelano solo le props che arrivano dal gruppo, che tanto
 *    nessuno può vedere finché la pane è nascosta.
 *
 * NOTA sul lint. `react-hooks/refs` vieta di leggere/scrivere una ref in fase di
 * render, ed è una regola giusta: quasi sempre quel codice è un `useState`
 * mascherato. Qui è il contrario — la ref È il meccanismo. Serve conservare
 * l'ELEMENTO React del render precedente e restituire lo stesso riferimento per
 * ottenere il bailout, e passare da `useState` non si può: `setFrozen(children)`
 * riceverebbe un oggetto nuovo a ogni render e girerebbe all'infinito. La
 * scrittura è idempotente rispetto al render (nessun effetto fuori da questo
 * componente, nessun tearing: il valore dipende solo dalle props di questo
 * render), quindi la regola è disattivata qui e solo qui.
 */
/* eslint-disable react-hooks/refs -- vedi NOTA sul lint sopra: la ref è il meccanismo, non uno stato travestito */
export function PaneKeepAlive({
  isVisible,
  className,
  paneKey,
  children,
}: {
  isVisible: boolean;
  className: string;
  /**
   * La chiave stabile della pane, pubblicata come `data-pane-shell`. Un
   * attributo, zero comportamento — stessa idea di `data-panel-cell`.
   *
   * Serve a rendere CONTABILE il tetto di residenza: in Tauri un guscio montato
   * È una WKWebView viva, quindi contare i gusci è l'unica proxy onesta del
   * costo di memoria dentro un test che gira su Chromium e non ha processi
   * WebKit da contare. Senza, `pane-residency-cap.spec.ts` dovrebbe dedurre lo
   * smontaggio dall'assenza di contenuto, che è vero anche per mille altre
   * ragioni.
   *
   * È anche il valore pubblicato via `PaneKeyContext`, così un discendente può
   * TRATTENERE la propria pane (`usePaneHold`) senza doversi far passare la
   * chiave lungo tutta la catena di props.
   */
  paneKey?: string;
  children: ReactNode;
}) {
  // Vitalità del sottoalbero: visibile QUI e visibile in ogni guscio che ci
  // contiene. La moltiplicazione col padre fa da sola il caso annidato (una
  // pane dentro una pane `project` nascosta). Vedi state/paneLiveness.ts.
  const parentAlive = useContext(PaneAliveContext);
  const alive = parentAlive && isVisible;

  const frozen = useRef<ReactNode>(children);
  const wasVisible = useRef(isVisible);
  if (isVisible || wasVisible.current !== isVisible) frozen.current = children;
  wasVisible.current = isVisible;

  return (
    <div
      className={className}
      // CONFINE DI LAYOUT della pane. Misurato col profilo nativo (2026-07-28,
      // finestra a fuoco, famiglia al 123%): l'animatore del caret di WebKit
      // sta al 36% del main thread. Per sapere dove disegnare il trattino
      // lampeggiante chiama `recomputeCaretRect` → `canonicalPosition` →
      // `Document::updateLayout()` A OGNI FRAME; e siccome l'albero delle pane
      // pende da un box fuori-flusso che è un flex container, quel layout
      // ripartiva da `RenderView` e ridiscendeva 14 livelli con
      // `RelayoutChildren`. Qualunque cosa sporcasse il layout dentro UNA pane
      // faceva rilayoutare TUTTE le altre, sessanta volte al secondo.
      //
      // `contain: layout` chiude la propagazione al bordo della pane: il caret
      // continua a forzare il layout — è il motore, non lo decidiamo noi — ma
      // trova da rifare solo il pezzo davvero sporco. Vale per ogni sorgente
      // futura di layout sporco, non solo per il caret.
      //
      // PREZZO PAGATO, ed è il motivo per cui questa strada era rimasta in
      // sospeso: la containment rende questo div un containing block per i
      // discendenti `position: fixed`, che quindi si ancorerebbero alla pane
      // invece che al viewport. I quattro overlay che stavano dentro le pane
      // sono stati portati su portale (TopicSettingsModal, il drawer mobile di
      // ProjectSidebar, il ripple di RemoteBrowserPanel e l'evidenziazione di
      // SelectElementOverlay). Chi aggiunge un `fixed` dentro una pane deve
      // passare da `createPortal`, come già fanno menu, popover e toast.
      style={{ display: isVisible ? 'flex' : 'none', contain: 'layout' }}
      aria-hidden={!isVisible}
      data-pane-shell={paneKey}
      data-pane-visible={isVisible ? '1' : '0'}
    >
      <PaneAliveContext.Provider value={alive}>
        <PaneKeyContext.Provider value={paneKey}>
          {/*
            CONFINE DI GUASTO della pane, sullo stesso bordo del confine di
            layout qui sopra. Prima l'unico ErrorBoundary stava attorno
            all'INTERA griglia (App.tsx, "Panel error"): un errore di render in
            una pane qualsiasi — un chunk lazy che non c'è più dopo un
            aggiornamento, un dato malformato che arriva dal server — sostituiva
            tutto il pannello con una schermata di errore, smontando insieme a
            quella rotta anche le pane sane accanto: terminali attaccati, chat
            in streaming, browser.

            Il boundary sta QUI, e non nei tre punti che montano una pane
            (GroupLayout ×2, StandaloneChatGroup), perché questo guscio è il
            passaggio obbligato: qualunque pane futura lo eredita senza doverci
            pensare.

            Non intacca il congelamento descritto sopra: `frozen.current` resta
            lo stesso riferimento fra un render e l'altro, quindi il bailout di
            React scatta identico un livello più giù.
          */}
          <ErrorBoundary fallbackMessageKey="crash.pane">{frozen.current}</ErrorBoundary>
        </PaneKeyContext.Provider>
      </PaneAliveContext.Provider>
    </div>
  );
}
