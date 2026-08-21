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

import { useMemo } from 'react';
import { collectFeatureWeights, ordinaVoci, voceVuota, type VocePeso } from '@/lib/featureWeight';
import { vociMisurate, type IngressiMisurati } from '@/lib/featureUsage';

export function useFeatureWeights(attivo: boolean, misurati: IngressiMisurati, sampleKey?: string): VocePeso[] {
  /* GLI INGRESSI FUORI DALLE DIPENDENZE, e non dentro un ref.
   *
   * `misurati` e' un oggetto letterale ricostruito a ogni render dal
   * chiamante: metterlo nelle dipendenze rifarebbe il conto a ogni render del
   * padre, cioe' molte volte al secondo mentre una chat streamma. Ed e'
   * esattamente cio' che questo hook esiste per evitare.
   *
   * Prima il valore passava da un ref scritto durante il render: la stessa
   * cosa, ma per una via che React considera scorretta (un ref letto mentre
   * si disegna non fa aggiornare chi lo legge). Il memo legge ora `misurati`
   * direttamente: quando si ricalcola ha comunque l'ULTIMO valore, perche' il
   * ricalcolo avviene durante un render e quel render porta l'ingresso fresco. */
  return useMemo(() => {
    if (!attivo) return [];
    // Le due nature entrano nello stesso elenco e vengono ordinate una volta
    // sola: `ordinaVoci` tiene il misurato davanti e non mescola mai i criteri
    // di peso fra nature diverse.
    return ordinaVoci([...vociMisurate(misurati), ...collectFeatureWeights()])
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- il campione, non l'oggetto ricostruito a ogni render
  }, [attivo, sampleKey]);
}
