import { useRef, type ReactNode } from 'react';

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
  children,
}: {
  isVisible: boolean;
  className: string;
  children: ReactNode;
}) {
  const frozen = useRef<ReactNode>(children);
  const wasVisible = useRef(isVisible);
  if (isVisible || wasVisible.current !== isVisible) frozen.current = children;
  wasVisible.current = isVisible;

  return (
    <div
      className={className}
      style={{ display: isVisible ? 'flex' : 'none' }}
      aria-hidden={!isVisible}
    >
      {frozen.current}
    </div>
  );
}
