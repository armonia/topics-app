import { useCallback, useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import type { Pane } from '../../../state/pane/types';
import { residencyClassOf, type ResidencyCandidate } from '../../../state/pane/residency/policy';
import {
  getResidencySnapshot,
  releaseSurface,
  reportSurface,
  subscribeResidency,
} from '../../../state/pane/residency/registry';

/**
 * Separatore per la firma delle chiavi visibili. Un carattere di controllo
 * (UNIT SEPARATOR) scritto come ESCAPE, non come byte: una chiave di pane è un
 * id (`browser:<uuid>`, `project:<path-encoded>`) e non può contenerlo, mentre
 * uno spazio in teoria sì.
 *
 * Scritto `\u001f` e non messo lì come byte grezzo perché `bun run check:nul`
 * rifiuta i byte NUL nei sorgenti — e ha ragione: un file che ne contiene uno
 * diventa binario per grep e sparisce da ogni ricerca nel repo. La prima
 * versione di questa riga ne aveva due, ed è così che me ne sono accorto.
 */
const KEY_SEP = '\u001f';

/**
 * Il legame fra una superficie di layout e il registro di residenza globale.
 *
 * Sostituisce i due `visitedKeys` che stavano in `GroupLayout` e
 * `StandaloneChatGroup`: stessa forma d'uso (un predicato da mettere nel filtro
 * di render), ma il set non cresce all'infinito e non è più per-superficie.
 *
 * Una SUPERFICIE è un contenitore di pane con le proprie tab: il gruppo
 * standalone, ogni `GroupLayout` (compresi quelli annidati dentro una pane
 * `project`), ogni finestra staccata. `useId` dà a ognuna un'identità stabile
 * per tutta la sua vita, così due istanze dello stesso componente non si
 * sovrascrivono nel registro.
 */
export function usePaneResidency(
  panes: readonly Pane[],
  visibleKeys: readonly string[],
): (pane: Pane) => boolean {
  const surfaceId = useId();

  const candidates = useMemo<ResidencyCandidate[]>(
    () => panes.map((p) => ({ key: p.stableKey ?? p.id, cls: residencyClassOf(p.type) })),
    [panes],
  );

  // Le visibili arrivano quasi sempre come array nuovo a ogni render (è una
  // `.map` sui gruppi). Il join le rende confrontabili, così l'effetto non
  // riparte per un'identità cambiata a parità di contenuto.
  const visibleSig = visibleKeys.join(KEY_SEP);
  const visible = useMemo(() => (visibleSig ? visibleSig.split(KEY_SEP) : []), [visibleSig]);

  useEffect(() => {
    reportSurface(surfaceId, candidates, visible);
  }, [surfaceId, candidates, visible]);

  // Lo smontaggio della superficie è l'unico momento in cui le sue pane
  // spariscono dal computo. Senza questo, sfrattare una pane `project`
  // lascerebbe il suo gruppo interno a occupare slot per sempre.
  useEffect(() => () => releaseSurface(surfaceId), [surfaceId]);

  const resident = useSyncExternalStore(subscribeResidency, getResidencySnapshot, getResidencySnapshot);

  return useCallback(
    (pane: Pane) => resident.has(pane.stableKey ?? pane.id),
    [resident],
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
