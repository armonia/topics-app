/**
 * Mettere in stage UN PEZZO di file, non il file intero.
 *
 * Si poteva solo `git add <file>`, cioè tutto o niente: un fix e un
 * rimaneggiamento fatti nella stessa sessione finivano nello stesso commit
 * perché stavano nello stesso file. È il divario più grosso rispetto a
 * qualunque altro client git.
 *
 * Il meccanismo è quello che usano tutti: si prende il diff, si tengono i
 * blocchi scelti, si ricostruisce una patch e la si dà a `git apply --cached`.
 * Il pezzo delicato è il secondo passo.
 *
 * ── Perché i numeri del lato NUOVO vanno ricalcolati ────────────────────────
 * Una patch dice, per ogni blocco, `@@ -vecchioInizio,n +nuovoInizio,m @@`. La
 * patch si applica all'INDICE, quindi i numeri del lato VECCHIO restano giusti
 * comunque: l'indice è esattamente il testo da cui il diff è partito.
 *
 * Il lato nuovo no. Se salti il primo blocco, che aggiungeva due righe, il
 * secondo blocco nel file risultante comincia due righe più in su di quanto
 * dica la sua intestazione. Con i numeri originali `git apply` risponde
 * «corrupt patch» oppure — peggio — applica con `--recount` una cosa spostata.
 * Quindi ogni blocco tenuto porta `nuovoInizio = vecchioInizio + delta`, dove
 * `delta` è la somma di (righe aggiunte − righe tolte) dei blocchi tenuti
 * PRIMA di lui. Non dei blocchi saltati: di quelli tenuti.
 *
 * ── «\ No newline at end of file» ───────────────────────────────────────────
 * Non è una riga del file, è una nota su quella prima. Va copiata dentro il
 * blocco a cui appartiene e non conta né come contesto né come aggiunta: se la
 * si conta, i totali nell'intestazione non tornano e la patch è rifiutata.
 */

export interface Hunk {
  /** L'intestazione originale, com'era: `@@ -1,6 +1,6 @@ contesto`. */
  header: string;
  /** Il testo dopo l'ultimo `@@`: di solito la funzione che contiene il blocco. */
  context: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Le righe del blocco, prefisso compreso (` `, `+`, `-`, `\`). */
  lines: string[];
  added: number;
  removed: number;
}

export interface ParsedDiff {
  /** Tutto quello che viene prima del primo `@@`: serve tale e quale nella patch. */
  header: string[];
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Un diff unificato di UN file → intestazione + blocchi.
 *
 * Se il diff ne contiene più di uno (non dovrebbe: le rotte chiedono sempre un
 * file solo) si tiene il primo, perché una patch con due file dentro applicata
 * per blocchi metterebbe in stage pezzi di un file che l'utente non ha scelto.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const righe = diff.split("\n");
  const header: string[] = [];
  const hunks: Hunk[] = [];
  let corrente: Hunk | null = null;
  let seenFirstHunk = false;

  for (const riga of righe) {
    const m = HUNK_RE.exec(riga);
    if (m) {
      seenFirstHunk = true;
      corrente = {
        header: riga,
        context: (m[5] ?? "").trim(),
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
        lines: [],
        added: 0,
        removed: 0,
      };
      hunks.push(corrente);
      continue;
    }
    if (!seenFirstHunk) {
      // Un secondo `diff --git` vuol dire che sono arrivati due file: si smette.
      if (riga.startsWith("diff --git") && header.length > 0) break;
      header.push(riga);
      continue;
    }
    if (!corrente) continue;
    if (riga.startsWith("diff --git")) break;
    // L'ultima riga dopo lo split è vuota e non appartiene a niente.
    if (riga === "" ) continue;
    corrente.lines.push(riga);
    if (riga[0] === "+") corrente.added++;
    else if (riga[0] === "-") corrente.removed++;
  }
  return { header, hunks };
}

/**
 * Una patch con i soli blocchi scelti, pronta per `git apply --cached`.
 *
 * Torna null se non resta niente da applicare: meglio non chiamare git che
 * chiamarlo con una patch vuota e interpretarne l'errore.
 */
export function buildPatch(parsed: ParsedDiff, indici: number[]): string | null {
  const scelti = [...new Set(indici)].sort((a, b) => a - b).filter(i => i >= 0 && i < parsed.hunks.length);
  if (scelti.length === 0) return null;

  const fuori: string[] = [...parsed.header];
  let delta = 0;
  for (const i of scelti) {
    const h = parsed.hunks[i];
    // Vedi l'intestazione del modulo: il lato vecchio resta, il nuovo scorre.
    const nuovoInizio = h.oldStart + delta;
    const newAccount = h.oldCount + (h.added - h.removed);
    fuori.push(`@@ -${h.oldStart},${h.oldCount} +${nuovoInizio},${newAccount} @@${h.context ? " " + h.context : ""}`);
    fuori.push(...h.lines);
    delta += h.added - h.removed;
  }
  // `git apply` vuole l'a-capo finale: senza, l'ultima riga è troncata e la
  // patch viene rifiutata.
  return fuori.join("\n") + "\n";
}

/**
 * Il riassunto dei blocchi per la UI: quanti sono e cosa fanno.
 *
 * Non porta le righe — la lista dei blocchi serve a scegliere, non a leggere il
 * diff, che sta già nel visualizzatore accanto.
 */
export function summarizeHunks(parsed: ParsedDiff): { index: number; context: string; added: number; removed: number; oldStart: number }[] {
  return parsed.hunks.map((h, index) => ({
    index,
    context: h.context,
    added: h.added,
    removed: h.removed,
    oldStart: h.oldStart,
  }));
}
