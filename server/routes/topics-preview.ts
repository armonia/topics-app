import { MACHINE_ROW_SQL } from "../../shared/prompt-number";

/** Quanti caratteri grezzi leggere per ricavarne {@link PREVIEW_MAX_CHARS} puliti.
 *  Largo abbastanza da sopravvivere a un blocco di codice in testa al messaggio,
 *  stretto abbastanza da non far viaggiare il `content` intero: il messaggio più
 *  lungo in archivio è di 158.122 caratteri, e ne servono 120. GEMELLA di
 *  `TOPIC_PREVIEW_SOURCE_MAX` in `client/src/state/topicPreviews.ts`, dove taglia
 *  il testo che arriva dal WS prima della stessa potatura. */
const PREVIEW_SOURCE_CHARS = 600;
/** Quante righe indietro guardare quando la prima si pota a NIENTE (un turno di
 *  solo codice: in SQL ha `content`, dopo {@link topicPreviewText} non ha più
 *  prosa). Sull'archivio di oggi il ripiego non scatta mai — 0 topic su 456 —
 *  quindi il costo è zero query in più; serve perché la promessa «si prende la
 *  precedente che parla» sia vera anche quando il caso si presenta. */
const PREVIEW_FALLBACK_DEPTH = 6;
/** Per quanto vale una fotografia di boot già scattata. Pochi secondi: basta a
 *  coprire la raffica di N finestre che si idratano insieme dopo un reload, ed è
 *  il tetto alla staleness nel solo caso che il validatore della cache non vede
 *  (una modifica in place dell'ultimo messaggio). Vedi `previewCache`. */
const PREVIEW_CACHE_TTL_MS = 5_000;
/** Lunghezza dell'anteprima. GEMELLA di `TOPIC_PREVIEW_MAX` in
 *  `client/src/state/topicPreviews.ts`: le due pulizie devono restare in passo,
 *  perché il client ripassa sul testo che arriva di qui (l'operazione è
 *  idempotente, quindi su un testo già pulito non fa niente). */
const PREVIEW_MAX_CHARS = 120;
/** Il prefisso delle buste di contesto della chat — vedi `CHAT_CONTEXT_PREFIX`
 *  in `server/context/assemble.ts`. Qui serve come pattern SQL, quindi
 *  niente apici né `%` dentro: entra in un `LIKE` per concatenazione. */
const CONTEXT_ENVELOPE_PREFIX = "[Chat messages since your last reply";
/** A row the MACHINE wrote (goal continuation, goal stop, board envelope) is not
 *  "the last thing said", and in the sidebar it spoke over the person in English
 *  («Objective still open: ...», topic:33966f4e, 23/09). */
const NOT_MACHINE_ROW_SQL = `NOT ${MACHINE_ROW_SQL}`;

/**
 * Il testo di un messaggio ridotto a UNA riga da mostrare sotto il nome di una
 * chat in sidebar.
 *
 * Non è un troncamento: è una potatura. Sotto al nome c'è una riga da 11px, e
 * quasi tutto ciò che rende un messaggio leggibile in chat lì diventa rumore —
 * un blocco di codice occupa l'intera anteprima senza dire niente, un `#` a
 * inizio riga si legge come un carattere a caso, un a-capo diventa uno spazio
 * doppio. Si tiene solo la prosa.
 *
 * IDEMPOTENTE di proposito: il client applica la stessa pulizia al testo che
 * arriva dal WS, e quel testo può già essere passato di qui.
 *
 * Esportata per `topics-preview.test.ts`, che la esercita sugli STESSI casi del
 * test di `cleanPreviewText` lato client: sono due copie a mano, oggi identiche,
 * e finché solo una aveva un test potevano divergere in silenzio.
 */
export function topicPreviewText(raw: string): string {
  let s = raw;
  // I blocchi di codice non stanno in una riga da 11px, e di solito SONO il
  // messaggio: via il blocco intero, resta la frase che lo introduceva. Anche la
  // recinzione APERTA — è così che arriva un turno tagliato a 600 caratteri.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/```[\s\S]*$/, " ");
  // Impalcatura iniettata: non l'ha scritta né l'umano né il modello.
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ");
  // Immagini via, link ridotti alla loro etichetta: l'URL non si legge comunque.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Segni di struttura a inizio riga (titoli, citazioni, elenchi): quando le
  // righe vengono compresse in una sola non delimitano più niente.
  // `(?:…)+`, non `(?:…)`: i marcatori si IMPILANO — «> > citato», «## # x»,
  // «1. 2. x» — e togliendone uno solo per passata questa potatura smetteva di
  // essere IDEMPOTENTE, che è la proprietà su cui si regge il patto con la
  // gemella lato client (`cleanPreviewText`). Il testo che arriva dal WS fa UNA
  // passata, quello dell'idratazione ne fa DUE: la stessa chat mostrava due
  // testi diversi prima e dopo un ricarico. Consumandoli tutti in una volta, la
  // seconda passata non trova più niente da togliere.
  s = s.replace(/^[ \t]{0,3}(?:(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+)+/gm, "");
  // Righe orizzontali: una riga fatta di soli `---` è un separatore, e compressa
  // in una riga sola diventa il primo "carattere a caso" che si legge.
  s = s.replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, " ");
  // Enfasi. `__` e `_` NON si toccano: qui dentro passano `session_key` e
  // `mcp__topics__browser_navigate`, e toglierli storpierebbe le parole. Il
  // corsivo si toglie solo a coppia CHIUSA sulla stessa riga e con l'interno
  // attaccato agli asterischi, così una moltiplicazione («2 * 3 * 4») resta com'è.
  s = s.replace(/\*\*|~~/g, "");
  s = s.replace(/\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*/g, "$1");
  s = s.replace(/`/g, "");
  // UNA riga: gli a-capo diventano spazi e gli spazi si comprimono.
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= PREVIEW_MAX_CHARS) return s;
  return s.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd() + "…";
}

type TopicPreviewsBody = Record<string, { text: string; role: "user" | "assistant"; at: number }>;
type PreviewCacheEntry = { until: number; mx: number; n: number; body: TopicPreviewsBody };

/** The boot photograph of every chat's last message, with its own cache. */
export function createTopicPreviews(db: import("bun:sqlite").Database): { topicPreviewsPayload: (archived: boolean) => TopicPreviewsBody } {
  /**
   * L'ultimo messaggio di OGNI chat, pronto per la riga di sidebar.
   *
   * PERCHÉ UNA SOTTOQUERY CORRELATA E NON UNA FINESTRA. La forma precedente
   * (`ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY sort_order DESC)` su
   * tutta `messages`) faceva quello che il piano diceva: «SCAN messages USING
   * INDEX idx_messages_session» + «USE TEMP B-TREE FOR LAST TERM OF ORDER BY».
   * Cioè leggeva TUTTI i messaggi — content compreso, vedi sotto — e li
   * riordinava in un B-tree temporaneo, per tenerne uno per chat. Misurato
   * sull'archivio vero (13.348 messaggi, 514 topic, 7,66 MB di `content`):
   * 321-620 ms a cache fredda, 39-40 ms a caldo. Ed è una `.all()` SINCRONA:
   * quei millisecondi sono event loop FERMO, a ogni boot di ogni finestra.
   *
   * Questa forma chiede invece a ogni topic la SUA riga, e la trova con una
   * ricerca su `idx_messages_session_order (session_key, sort_order)` che si
   * ferma alla prima che passa i filtri: «SEARCH p USING INDEX
   * idx_messages_session_order (session_key=?)», nessun B-tree temporaneo.
   * 7,7-12 ms, e indifferente allo stato della cache — tocca così poche pagine
   * che scaldarle non cambia niente. Stesso risultato, riga per riga: 456
   * anteprime identiche.
   *
   * QUALI RIGHE NON CONTANO:
   *  · `content` vuoto — un turno di soli tool (il testo sta in `blocks` /
   *    `tool_calls`). Non si mostra il vuoto e non si prova a riassumere gli
   *    strumenti: «ha eseguito 4 comandi» non è un'anteprima, la frase che li
   *    introduceva sì. Si scarta la riga e si prende la precedente che parla.
   *  · `partial` — un turno in volo ha testo mozzo, e mentre vola la riga mostra
   *    comunque lo stato live (SessionActivity), non l'anteprima.
   *  · le buste di contesto della chat, che sono impalcatura, non messaggi.
   *
   * COSA FA DAVVERO IL `substr`. Non risparmia la LETTURA del `content`: i due
   * filtri di testo qui accanto (`trim(content) <> ''`, il `NOT LIKE` sulla
   * busta) obbligano SQLite a materializzare per intero il valore di ogni riga
   * che il filtro tocca — anche il messaggio da 158.122 caratteri. Il `substr`
   * accorcia solo ciò che ESCE: senza, {@link topicPreviewText} girerebbe ~10
   * regex su quei 158 KB per scriverne 120 caratteri. Il risparmio sulla lettura
   * lo compra la forma della query, non il `substr`: le righe toccate dai filtri
   * passano da tutte e 13.348 a una manciata per topic.
   */
  function topicPreviewsQuery(archived: boolean): { topicId: string; sessionKey: string; role: string; text: string; at: string }[] {
    return db.prepare(`
      SELECT t.id AS topicId, t.session_key AS sessionKey,
             m.role AS role, substr(m.content, 1, ${PREVIEW_SOURCE_CHARS}) AS text, m.timestamp AS at
      FROM topics t
      JOIN messages m ON m.rowid = (
        SELECT p.rowid FROM messages p
        WHERE p.session_key = t.session_key
          AND COALESCE(p.partial, 0) = 0
          AND trim(p.content) <> ''
          AND p.content NOT LIKE '${CONTEXT_ENVELOPE_PREFIX}%'
          AND ${NOT_MACHINE_ROW_SQL.replaceAll("blocks", "p.blocks")}
        ORDER BY p.sort_order DESC
        LIMIT 1
      )
      WHERE t.archived = ?
    `).all(archived ? 1 : 0) as { topicId: string; sessionKey: string; role: string; text: string; at: string }[];
  }

  /** Le righe SUCCESSIVE alla prima, per il ripiego di {@link topicPreviewsPayload}.
   *  Stessi filtri, stesso indice: cambia solo il `LIMIT`. */
  function topicPreviewCandidates(sessionKey: string): { role: string; text: string; at: string }[] {
    return db.prepare(`
      SELECT role, substr(content, 1, ${PREVIEW_SOURCE_CHARS}) AS text, timestamp AS at
      FROM messages
      WHERE session_key = ?
        AND COALESCE(partial, 0) = 0
        AND trim(content) <> ''
        AND content NOT LIKE '${CONTEXT_ENVELOPE_PREFIX}%'
        AND ${NOT_MACHINE_ROW_SQL}
      ORDER BY sort_order DESC
      LIMIT ${PREVIEW_FALLBACK_DEPTH}
    `).all(sessionKey) as { role: string; text: string; at: string }[];
  }

  /**
   * La cache dell'endpoint. Non serve a rendere veloce UNA risposta — quello lo
   * fa già la query — ma a non ripagarla N volte: `/api/topics/previews` è una
   * fotografia di BOOT, e ogni finestra aperta la chiede all'avvio e a ogni
   * ricarico, tutte insieme dopo un reload del server.
   *
   * Il validatore è `max(rowid) + count(*)` su `messages`: 0,31 ms misurati sul
   * DB vero, contro i 7,7-12 ms della query piena. Coglie ogni messaggio NUOVO
   * (rowid cresce) e ogni cancellazione (count cala) — cioè le due cose che
   * spostano davvero l'ultimo messaggio di una chat, «Svuota chat» compresa. Non
   * coglie una MODIFICA in place dell'ultimo messaggio, ed è per questo che
   * sopra c'è anche un TTL: lì la finestra di staleness è al massimo di
   * {@link PREVIEW_CACHE_TTL_MS}.
   *
   * ONE SLOT PER VARIANT. The live previews and the archived ones are two
   * different bodies from the same validator, so they get one entry each: a
   * single slot would make the archived section, asked for once in a while,
   * evict the boot photograph that every window asks for.
   */
  const previewCache = new Map<string, PreviewCacheEntry>();

  function topicPreviewsPayload(archived: boolean): TopicPreviewsBody {
    const stamp = db.prepare("SELECT max(rowid) AS mx, count(*) AS n FROM messages").get() as { mx: number | null; n: number };
    const mx = stamp.mx ?? 0;
    const slot = archived ? "archived" : "live";
    const cached = previewCache.get(slot);
    if (cached && cached.until > Date.now() && cached.mx === mx && cached.n === stamp.n) {
      return cached.body;
    }
    const previews: TopicPreviewsBody = {};
    for (const r of topicPreviewsQuery(archived)) {
      let text = topicPreviewText(r.text);
      let role = r.role;
      let at = r.at;
      // Il ripiego che il commento SQL prometteva e il codice non faceva: la
      // riga scelta ha `content` in SQL ma dopo la potatura può non avere più
      // prosa (era tutta un blocco di codice), e allora il topic restava muto
      // invece di mostrare «la precedente che parla». Oggi non scatta mai
      // (0 topic su 456), quindi non costa una query in più — esiste perché la
      // promessa sia vera il giorno che il caso si presenta.
      if (!text) {
        for (const c of topicPreviewCandidates(r.sessionKey)) {
          const t = topicPreviewText(c.text);
          if (!t) continue;
          text = t; role = c.role; at = c.at;
          break;
        }
      }
      // Nemmeno {@link PREVIEW_FALLBACK_DEPTH} righe indietro c'era prosa:
      // meglio una riga muta che una riga di rumore.
      if (!text) continue;
      previews[r.topicId] = {
        text,
        role: role === "user" ? "user" : "assistant",
        at: Date.parse(at) || 0,
      };
    }
    previewCache.set(slot, { until: Date.now() + PREVIEW_CACHE_TTL_MS, mx, n: stamp.n, body: previews });
    return previews;
  }

  return { topicPreviewsPayload };
}
