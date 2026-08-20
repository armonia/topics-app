/**
 * COME SI SCRIVE L'INVENTARIO, per le due superfici che lo mostrano.
 *
 * Il tooltip della barra e il pannello rispondono alla stessa domanda e devono
 * derivare dallo STESSO elenco e dalle stesse regole: due superfici che dicono
 * cose diverse sulla stessa cosa si contraddicono, e chi legge non ha modo di
 * sapere a quale credere. E' la stessa ragione per cui `verdict.ts` tiene una
 * sola soglia per la riga del residente.
 *
 * QUELLO CHE CAMBIA FRA LE DUE e' solo QUANTE righe: un tooltip lungo quanto un
 * pannello non si legge, e le righe in fondo — che sono le piu' leggere — sono
 * proprio quelle che non servono a nessuno. Quindi il tooltip taglia, il
 * pannello no; l'ordine e il testo sono identici.
 */

import type { VocePeso } from './featureWeight';

/** Quante righe stanno in un tooltip prima che smetta di essere leggibile.
 *  Il tooltip del totale ne ha gia' una decina di suo fra le due meta' e la
 *  riga del residente: cinque e' cio' che si aggiunge senza farlo diventare una
 *  parete di testo. */
export const RIGHE_NEL_TOOLTIP = 5;

/**
 * COME SI CHIAMANO LE COSE CHE UNA FUNZIONALITA' TIENE.
 *
 * «12 voci, 40 elementi» e' vero e non dice niente: dodici COSA? La domanda a
 * cui questo inventario risponde e' «cosa tiene la memoria», e una risposta che
 * non nomina cio' che tiene non e' una risposta. Qui ogni funzionalita' dichiara
 * i due sostantivi con cui si contano le sue cose.
 *
 * Assente = si ripiega su «voci/elementi», che e' generico ma mai sbagliato: una
 * funzionalita' nuova che si dimentica di registrarsi qui resta leggibile invece
 * di sparire o di mentire.
 */
const NOMI: Record<string, { uno: string; molti: string; sub?: { uno: string; molti: string } }> = {
  'pane.store': { uno: 'scheda', molti: 'schede', sub: { uno: 'chiusura ricordata', molti: 'chiusure ricordate' } },
  'chat.messages': { uno: 'chat', molti: 'chat', sub: { uno: 'messaggio', molti: 'messaggi' } },
  'board.tasks': { uno: 'task', molti: 'task' },
  'topic.previews': { uno: 'anteprima', molti: 'anteprime' },
  'chat.queue': { uno: 'chat', molti: 'chat', sub: { uno: 'turno', molti: 'turni' } },
  'task.browserTabs': { uno: 'task', molti: 'task', sub: { uno: 'tab', molti: 'tab' } },
  'browser.siteHistory': { uno: 'sito', molti: 'siti' },
  'pane.residency': { uno: 'scheda montata', molti: 'schede montate' },
  'fleet.sessions': { uno: 'sessione', molti: 'sessioni' },
  'shell.browserPanes': { uno: 'pannello', molti: 'pannelli' },
};

/** Singolare o plurale del nome giusto per questa voce. */
function nome(id: string, n: number, sub = false): string {
  const def = NOMI[id];
  const coppia = sub ? def?.sub : def && { uno: def.uno, molti: def.molti };
  if (!coppia) return sub ? (n === 1 ? 'elemento' : 'elementi') : (n === 1 ? 'voce' : 'voci');
  return n === 1 ? coppia.uno : coppia.molti;
}

/** La riga di una voce, senza il pallino di elenco: lo mette chi la mostra. */
export function rigaVoce(v: VocePeso): string {
  if (v.errore) return `${v.label}: non misurato`;
  if (v.natura === 'misurato') {
    const mb = v.peso.memoryMB ?? 0;
    const proc = v.peso.processCount ?? 0;
    /* LE VOCI SI TACCIONO QUANDO COINCIDONO COI PROCESSI.
     *
     * Visto sui dati veri: «Ponte AI: 68 MB · 1 voce · 1 processo» e «Comandi
     * lanciati dagli agenti: 565 MB · 24 voci · 24 processi». Lo stesso numero
     * detto due volte con due nomi non aggiunge niente e fa sembrare che siano
     * due fatti diversi. Resta invece dove i due differiscono davvero —
     * «Terminali e sessioni: 749 MB · 2 voci · 5 processi», cioe' due sessioni
     * con cinque processi sotto — perche' li' la distinzione e' il dato. */
    /* Le radici del lato server hanno UNA voce per definizione (il ponte e' uno
     * solo): «1 voce · 18 processi» conta due volte la stessa cosa e chiama
     * «voce» un ponte. Il conteggio delle voci serve dove ce n'e' piu' d'una e
     * dove non coincide coi processi — le sessioni, i pannelli. */
    const q = v.peso.entries <= 1 || v.peso.entries === proc ? '' : quantita(v);
    // Il numero di processi c'e' perche' distingue «un terminale grosso» da
    // «dodici piccoli», che si chiudono in modi diversi.
    return `${v.label}: ${mb} MB${q ? ` · ${q}` : ''}${proc > 0 ? ` · ${proc} ${proc === 1 ? 'processo' : 'processi'}` : ''}`;
  }
  // Trattenuto: CONTEGGI, mai byte. Un `bytes` stimato serve a ordinare le voci
  // fra loro, e mostrarlo come «0,1 MB» accanto a un «440 MB» misurato darebbe
  // l'idea che le due cose si confrontino.
  const q = quantita(v);
  return `${v.label}: ${q || `${fmt(v.peso.entries)}`}`;
}

/** «3 chat, 4312 messaggi» — la parte che conta le cose, coi loro nomi. */
function quantita(v: VocePeso): string {
  const e = v.peso.entries;
  const i = v.peso.items ?? 0;
  const parti: string[] = [];
  if (e > 0) parti.push(`${fmt(e)} ${nome(v.id, e)}`);
  if (i > 0) parti.push(`${fmt(i)} ${nome(v.id, i, true)}`);
  return parti.join(', ');
}

/**
 * Migliaia col punto, come si scrivono in italiano.
 *
 * ESPLICITO E NON `toLocaleString('it-IT')`, per due ragioni trovate provando:
 *
 *  1. LA REGOLA VERA NON E' «un punto ogni tre cifre». In italiano (CLDR
 *     `minimumGroupingDigits: 2`) i numeri a QUATTRO cifre non si raggruppano:
 *     `4312` resta `4312`, `12345` diventa `12.345`. Verificato sul runtime.
 *     Scriverlo qui la rende una decisione leggibile invece di un
 *     comportamento che sorprende chi legge il codice.
 *  2. `toLocaleString` dipende dall'ICU di CHI ESEGUE. Le stesse righe girano
 *     sotto `bun test` e dentro WebKit, e un formato che cambia col motore
 *     rende un test verde di qua e rosso di la' — o peggio, verde ovunque e
 *     diverso a schermo.
 */
export function fmt(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  // Sotto le cinque cifre nessun raggruppamento: e' la regola italiana, non
  // una semplificazione.
  const raggruppato = s.length < 5 ? s : s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return n < 0 ? `-${raggruppato}` : raggruppato;
}

/**
 * Il blocco per il TOOLTIP: intestazione, le prime righe, e quante ne restano.
 *
 * La coda si DICHIARA («e altre 4») invece di sparire: un elenco troncato in
 * silenzio fa credere di aver visto tutto, ed e' lo stesso difetto che rende
 * inutile un inventario incompleto.
 *
 * Torna `null` quando non c'e' niente da dire: nessuna intestazione vuota, che
 * e' peggio dell'assenza — occupa una riga per dire zero.
 */
export function bloccoTooltip(voci: readonly VocePeso[], limite = RIGHE_NEL_TOOLTIP): string | null {
  if (voci.length === 0) return null;
  const mostrate = voci.slice(0, limite);
  const resto = voci.length - mostrate.length;
  const righe = mostrate.map(v => `· ${rigaVoce(v)}`);
  if (resto > 0) righe.push(`· e altre ${resto}`);
  return ['Cosa tiene questo numero:', ...righe].join('\n');
}

/** Le voci di una natura sola, per il pannello che le mostra in due sezioni. */
export function vociPerNatura(voci: readonly VocePeso[], natura: VocePeso['natura']): VocePeso[] {
  return voci.filter(v => v.natura === natura);
}

/**
 * La quantita' in forma CORTA, per la colonna destra del pannello.
 *
 * Il pannello e' largo ~288px e la colonna dei numeri e' quella stretta: «3
 * voci, 4312 elementi» ci andrebbe a capo o verrebbe troncato a meta' parola.
 * Qui si sceglie IL numero che dice di piu' — gli elementi quando ci sono
 * (4.312 messaggi e' piu' informativo di 3 chat), le voci altrimenti — e il
 * resto sta nel tooltip della riga, dove c'e' spazio.
 */
export function quantitaBreve(v: VocePeso): string {
  const i = v.peso.items ?? 0;
  // COL NOME, non il numero nudo: «198» in una colonna non dice se sono
  // megabyte, secondi o anteprime — e sta accanto a righe che i megabyte li
  // hanno davvero. Il nome e' corto per costruzione (una parola), quindi ci
  // sta; il resto del conteggio sta nel tooltip della riga.
  if (i > 0) return `${fmt(i)} ${nome(v.id, i, true)}`;
  return `${fmt(v.peso.entries)} ${nome(v.id, v.peso.entries)}`;
}
