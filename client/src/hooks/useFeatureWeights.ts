/**
 * L'INVENTARIO PRONTO DA MOSTRARE, unito dalle due sorgenti.
 *
 * ON DEMAND, MAI A INTERVALLI. `attivo` e' true solo quando qualcuno sta
 * guardando: il mouse sul totale, o il dropdown aperto. Un inventario che si
 * ricalcolasse ogni cinque secondi con la finestra ferma pagherebbe una
 * serializzazione di tutto lo stato per un numero che nessuno legge — ed e'
 * esattamente il tipo di lavoro a riposo che questa app ha appena finito di
 * togliersi di dosso (le 27 scritture ogni 30 secondi, chiuse il 2026-08-20).
 *
 * Il ricalcolo e' legato a `sampleKey`: due superfici aperte insieme sullo
 * stesso campione mostrano lo stesso inventario, invece di due fotografie prese
 * a un secondo di distanza che si contraddicono per un messaggio arrivato in
 * mezzo.
 */

import { useMemo, useRef } from 'react';
import { collectFeatureWeights, ordinaVoci, voceVuota, type VocePeso } from '@/lib/featureWeight';
import { vociMisurate, type IngressiMisurati } from '@/lib/featureUsage';

export function useFeatureWeights(attivo: boolean, misurati: IngressiMisurati, sampleKey?: string): VocePeso[] {
  /* GLI INGRESSI IN UN REF, e non fra le dipendenze.
   *
   * `misurati` e' un oggetto letterale ricostruito a ogni render dal
   * chiamante: metterlo nelle dipendenze rifarebbe il conto a ogni render del
   * padre — cioe' molte volte al secondo mentre una chat streamma — che e'
   * esattamente cio' che questo hook esiste per evitare. Il ref porta sempre
   * l'ULTIMO valore, quindi il ricalcolo, quando avviene, non usa mai un dato
   * vecchio. */
  const ref = useRef(misurati);
  // eslint-disable-next-line react-hooks/refs -- deliberate latest-value ref: `misurati` is a literal rebuilt every render, so it cannot be a dependency without defeating the hook; the write is idempotent and never drives rendering
  ref.current = misurati;

  return useMemo(() => {
    if (!attivo) return [];
    // Le due nature entrano nello stesso elenco e vengono ordinate una volta
    // sola: `ordinaVoci` tiene il misurato davanti e non mescola mai i criteri
    // di peso fra nature diverse.
    // eslint-disable-next-line react-hooks/refs -- same latest-value ref: read only when the memo actually recomputes, which is what keeps the inventory off the render path
    return ordinaVoci([...vociMisurate(ref.current), ...collectFeatureWeights()])
      .filter(v => !voceVuota(v));
    /* LE DUE DIPENDENZE, e perche' servono ENTRAMBE.
     *
     * `sampleKey` identifica il campione: due superfici aperte insieme sullo
     * stesso campione mostrano lo stesso inventario, invece di due fotografie
     * prese a un secondo di distanza che si contraddicono.
     *
     * `attivo` fa da innesco all'ACCENSIONE, e non e' ridondante: la barra
     * ricampiona ogni 60 secondi, quindi con il solo `sampleKey` chi passa il
     * mouse subito dopo un campione leggerebbe un tooltip vuoto fino al giro
     * dopo — un minuto di attesa per una riga di testo. */
  }, [attivo, sampleKey]);
}
