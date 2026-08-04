/**
 * Il livello di autonomia di una chat → la modalità di permessi della CLI.
 *
 * ── Il fatto ────────────────────────────────────────────────────────────────
 * `AutonomyLevel` (`ask | auto-apply | yolo`) esiste nel modello dati da sempre,
 * si salva sul topic… e non era collegato a niente: **ogni** chat partiva con
 * `bypassPermissions`, qualunque cosa dicesse l'impostazione. Il selettore non
 * c'era e il valore non aveva effetto — cioè la promessa peggiore che
 * un'interfaccia possa fare.
 *
 * ── Perché queste tre modalità e non altre ──────────────────────────────────
 * In `--print` una modalità che CHIEDE il permesso rischia di lasciare il turno
 * appeso: nessuno può rispondere, e il canale `can_use_tool` non esiste. Quindi
 * la mappatura non è stata scelta a naso — è stata **provata** sulla CLI 2.1.221
 * (04/08/2026):
 *
 *  - `plan` → «Crea un file, fallo davvero» ⇒ il file **NON** viene creato, esce
 *    un piano e la domanda «approvi?». Il turno finisce regolarmente.
 *  - `acceptEdits` → esegue (provato con un comando shell). Nessun blocco.
 *  - `bypassPermissions` → il comportamento di prima, invariato.
 *
 * Le altre modalità offerte dalla CLI (`manual`, `auto`, `dontAsk`) restano
 * fuori finché qualcuno non le prova allo stesso modo: metterle senza averle
 * viste girare significherebbe scoprire il turno appeso in produzione.
 *
 * ── Il default non cambia ───────────────────────────────────────────────────
 * Un topic senza livello scelto continua ad avere `bypassPermissions`. Cambiare
 * il default avrebbe zittito le chat esistenti di chi non ha mai toccato
 * l'impostazione — una migrazione silenziosa travestita da funzione nuova.
 */

/**
 * I livelli (`ask | auto-apply | yolo`) vivono in `shared/types.ts` e SOLO lì:
 * chi ha bisogno del tipo lo importa da quella parte. Fino al 05/08/2026
 * questo file ne teneva una copia letterale — due sorgenti di verità libere
 * di divergere in silenzio, visto che le funzioni qui sotto prendono `string`
 * e mandano al default qualunque livello non riconosciuto. Un livello aggiunto
 * di là sarebbe passato di qua senza un solo errore di compilazione.
 */

/** La modalità con cui si parte quando il topic non ha scelto. */
export const DEFAULT_PERMISSION_MODE = "bypassPermissions";

/**
 * La modalità di permessi per un livello. Un valore assente o sconosciuto torna
 * il default: un livello scritto male non deve poter cambiare come lavora una
 * chat, e soprattutto non deve poterla bloccare.
 */
export function permissionModeForAutonomy(level: string | null | undefined): string {
  switch (level) {
    case "ask":
      // «Chiedi prima» in modalità print vuol dire: proponi e non toccare.
      return "plan";
    case "auto-apply":
      return "acceptEdits";
    case "yolo":
      return "bypassPermissions";
    default:
      return DEFAULT_PERMISSION_MODE;
  }
}

/** Cosa succede davvero, in una riga — per l'interfaccia e per il registro. */
export function describeAutonomy(level: string | null | undefined): string {
  switch (level) {
    case "ask":
      return "propone un piano e aspetta il tuo ok: non tocca file né esegue comandi";
    case "auto-apply":
      return "applica le modifiche ai file da sé";
    case "yolo":
      return "fa tutto senza chiedere";
    default:
      return "come «fa tutto senza chiedere» (nessun livello scelto)";
  }
}
