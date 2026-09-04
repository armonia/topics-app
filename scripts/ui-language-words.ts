/**
 * scripts/ui-language-words.ts — the VOCABULARY the UI-language gate scans with.
 *
 * Split out of `check-ui-language.ts` because it is data, not logic: a list of
 * words changes for reasons that have nothing to do with how the scanner lexes
 * a file, and the two were the only thing standing between that gate and the
 * 800-line ceiling `check:bloat` holds. Keeping them apart also makes the diff
 * of "we added a word" readable on its own.
 *
 * Nothing here is clever. The one rule worth restating: a word that exists in
 * BOTH languages stays OUT. A miss costs one untranslated string; a false
 * positive costs the gate's credibility, and a gate nobody believes is turned
 * off within a week.
 */

/**
 * Grave accents plus the acute `e`. English UI copy does not carry them, and
 * every Italian sentence of any length carries at least one ("e'", "piu'",
 * "gia'", "perche'", "cosi'" are all written with the accent in this repo).
 */
export const ACCENTS = /[àèéìòùÀÈÉÌÒÙ]/;

/**
 * Italian tokens that are NOT English words. Vetted one by one: a word that
 * exists in both languages is worth more as a miss than as a false positive,
 * because the first costs one untranslated string and the second costs the
 * gate's credibility. The obvious absences are deliberate and listed in this
 * file's header.
 */
export const STOPWORDS = new Set<string>([
  // Articles, prepositions, determiners.
  "gli", "del", "dello", "della", "dei", "degli", "delle",
  "dal", "dallo", "dalla", "dai", "dagli", "dalle",
  "nel", "nello", "nella", "nei", "negli", "nelle",
  "sul", "sullo", "sulla", "sui", "sugli", "sulle",
  // "col" and "coi" are out: the editor's status bar reads "Ln 12, Col 4".
  "allo", "alla", "agli", "alle", "una",
  "questo", "questa", "questi", "queste",
  "quel", "quello", "quella", "quelli", "quelle",
  "suo", "sua", "suoi", "tuo", "tua", "loro",
  // Conjunctions and adverbs.
  "che", "cui", "non", "anche", "ancora", "quindi", "perche", "poiche",
  "invece", "mentre", "quando", "quanto", "quanti", "quante", "quale", "quali",
  "ogni", "tutti", "tutte", "tutto", "tutta",
  "nessun", "nessuno", "nessuna", "niente", "nulla",
  "senza", "sempre", "adesso", "subito", "soltanto", "appena", "oppure",
  "altrimenti", "inoltre", "sopra", "sotto", "dentro", "fuori", "dopo",
  "troppo", "molto", "poco", "meno",
  "altro", "altra", "altri", "altre",
  // Verbs, in the forms UI copy actually uses.
  "sono", "siamo", "essere", "stato", "stata", "stati", "stanno",
  "avere", "hanno", "abbiamo",
  "fare", "fatto", "fatta", "fatti", "fatte",
  "puo", "possono", "puoi", "possibile", "impossibile",
  "deve", "devi", "devono", "serve", "servono",
  "manca", "mancano", "mancante", "mancanti",
  "viene", "vengono", "verra", "sara", "saranno", "sarebbe",
  "apri", "apre", "aprire", "apertura",
  "chiudi", "chiude", "chiudere", "chiusa", "chiuso", "chiusi", "chiuse", "chiusura",
  "mostra", "mostrare", "nascondi", "nascosto", "nascosta",
  "salva", "salvato", "salvata", "salvare", "salvataggio",
  "elimina", "eliminato", "eliminare", "rimuovi", "rimuovere", "rimosso", "rimossa",
  "cerca", "cercare", "cercando",
  "trova", "trovato", "trovata", "trovati", "trovate", "trovare",
  "aggiungi", "aggiunta", "aggiunto", "aggiungere",
  "crea", "creare", "creato", "creata", "creazione",
  "modifica", "modifiche", "modificare", "modificato", "modificata",
  "rinomina", "rinominare",
  "copia", "copiare", "copiato", "incolla", "incollare",
  "annulla", "annullare", "annullato", "conferma", "confermare",
  "riprova", "riprovare",
  "carica", "caricare", "caricamento", "caricato", "scarica", "scaricare",
  "scegli", "scegliere", "seleziona", "selezionato", "selezionata", "selezione",
  "avvia", "avviare", "avviato", "avvio", "riavvia", "riavviare", "riavvio",
  "ferma", "fermare", "fermato", "arresto",
  "torna", "tornare", "vai", "premi", "clicca", "cliccare",
  "trascina", "trascinare",
  "esegui", "eseguire", "eseguito", "eseguita",
  "invia", "inviare", "inviato", "inviata", "ricevi", "ricevuto",
  "attendi", "attesa", "aspetta", "aspettare",
  "utilizza", "utilizzare", "usare", "usato", "usata",
  "scrivi", "scrivere", "leggi", "leggere", "letto", "letta",
  "sposta", "spostare", "spostato", "spostata",
  "ripristina", "ripristinare", "ripristino",
  "aggiorna", "aggiornare", "aggiornamento", "aggiornamenti", "aggiornato", "aggiornata",
  "installa", "installare", "installato",
  "abilita", "disabilita", "attiva", "disattiva", "attivo", "attivi", "attive",
  "spento", "spenta", "acceso", "accesa",
  "collega", "collegato", "collegamento", "connesso", "connessa", "disconnesso",
  "genera", "generato", "generata",
  "verifica", "verificare", "controlla", "controllare", "controllo",
  "termina", "terminato", "interrompi", "interrotto", "interrotta",
  "fallito", "fallita", "fallimento", "riuscito", "completato", "completata",
  // Nouns and adjectives.
  "errore", "errori", "messaggio", "messaggi", "avviso", "avvisi",
  "cartella", "cartelle", "percorso", "percorsi",
  "progetto", "progetti", "sessione", "sessioni", "finestra", "finestre",
  "impostazioni", "impostazione", "opzioni", "opzione",
  "riga", "righe", "colonna", "pagina", "pagine",
  "ricerca", "elenco", "scheda", "schede", "pulsante", "pulsanti", "tasto", "tasti",
  "nome", "nomi", "utente", "utenti", "chiave", "chiavi", "valore", "valori",
  "ramo", "rami", "anteprima", "richiesta", "richieste", "risposta", "risposte",
  "consegna", "consegne", "commento", "commenti",
  "terminale", "terminali", "lingua", "lingue", "aiuto", "guida",
  "dimensione", "dimensioni", "larghezza", "altezza",
  "giorno", "giorni", "settimana", "mese", "mesi", "anno", "anni",
  "minuto", "minuti", "secondo", "secondi", "numero", "numeri",
  "vuoto", "vuota", "pieno", "piena",
  "nuovo", "nuova", "nuovi", "nuove", "vecchio", "vecchia",
  "ultimo", "ultima", "primo", "precedente", "successivo", "successiva",
  "sinistra", "destra", "piccolo", "piccola",
  "disponibile", "disponibili", "sconosciuto", "sconosciuta",
  "predefinito", "predefinita", "consigliato", "recente", "recenti",
  "esempio", "esempi", "lavoro", "corso", "prova",
  "tentativo", "tentativi", "dettaglio", "dettagli",
  "livello", "livelli", "passaggio", "passaggi",
]);

/**
 * The words the BUTTONS of this app are made of, read only by the UI gate.
 *
 * They belong in the list above by every argument except one: `STOPWORDS` is
 * also the detector of `check-comment-language.ts`, whose baseline is a frozen
 * per-file COUNT. Adding these forty words there makes that gate see 292 more
 * comment lines in 189 files it never touched, and re-freezing to absorb them
 * would swallow, in the same move, any genuinely new Italian comment that
 * landed since. Changing what a ratchet measures is not a side effect a card
 * about UI strings gets to have; merging the two lists is its own decision,
 * with its own re-freeze.
 *
 * The rule is the one above: a word that exists in English stays out. None of
 * these does, and each one was on a button the gate could not read.
 */
export const UI_COPY_WORDS = new Set<string>([
  "consenti", "consentire", "consentito", "consentita", "nega", "negare", "negato", "negata",
  "indietro", "avanti", "chiudi", "chiudere", "chiuso", "chiusa", "apri", "aprire",
  "ricarica", "ricaricare", "dimentica", "dimenticare",
  "scarta", "scartare", "scartato", "scartata", "cestino",
  "rifiuta", "rifiutare", "rifiutato", "accetta", "accettare", "accettato",
  "proponi", "proposto", "proposta", "abbandonato", "abbandonata", "abbandona",
  "riapri", "riaperta", "riaperto",
  "ferme", "fermi", "fermo", "rinviata", "rinviato", "coda",
  "piano", "obiettivo", "obiettivi", "permesso", "permessi", "decisione", "decisioni",
]);
