import { test, expect, describe } from 'bun:test';
import {
  compareTasks,
  findDuplicateGroups,
  findNeighbours,
  normalizeTaskText,
  tokenizeTaskText,
  DUPLICATE_THRESHOLD,
  type SimilarTask,
} from './task-similarity';

/**
 * I titoli qui sotto sono VERI: letti dalla board di produzione il 12/08/2026
 * con `sqlite3 -readonly data/topics.db`, e riportati senza gli id (l'unico dato
 * che identifica una riga). Contano perché il difetto che questo modulo deve
 * evitare non si inventa a tavolino: sono le card sorelle di una stessa tornata,
 * che condividono quasi tutto il testo e non sono affatto la stessa cosa. Una
 * suite scritta su esempi immaginari le avrebbe fuse senza accorgersene.
 */

describe('normalizzazione', () => {
  test('la numerazione della tornata non fa differenza fra due card', () => {
    // Reali: gli agenti impaginano le tornate con «1. », «4a. », «4b. ».
    expect(normalizeTaskText('4a. Prep 2.2.112: deps + client')).toBe('prep 2.2.112: deps + client');
    expect(normalizeTaskText('1) syncWS.test.ts, gate seq')).toBe('syncws.test.ts, gate seq');
    expect(normalizeTaskText('  Prep 2.2.112:   deps + client ')).toBe('prep 2.2.112: deps + client');
  });

  test('accenti e virgolette non cambiano il verdetto', () => {
    expect(normalizeTaskText('Priorità «alta»')).toBe(normalizeTaskText('priorita alta'));
  });
});

describe('tokenizzazione', () => {
  test("un identificatore resta INTERO: e' l'unica cosa che distingue due fratelli", () => {
    const { content, anchors } = tokenizeTaskText('browser_eval_js su WebView2 + WebKitGTK');
    expect(anchors).toContain('browser_eval_js');
    expect(content).toContain('webkitgtk');
    // Se si spezzasse in browser/eval/js l'ancora sparirebbe proprio dove serve.
    expect(anchors).not.toContain('eval');
  });

  test('la lista di argomenti non fa identita: update() e update(a, b) danno la stessa ancora', () => {
    const a = tokenizeTaskText('store: UserMemoryStore.update() + test');
    const b = tokenizeTaskText('store: UserMemoryStore.update(companyId, userId, id, text)');
    expect(a.anchors).toEqual(['usermemorystore.update']);
    expect(b.anchors).toEqual(['usermemorystore.update']);
  });
});

describe('doppioni veri della board', () => {
  // Gruppo misurato: 6 card vive che dicono la stessa cosa in tre modi.
  test('«+ test» e «+ unit test» sono la stessa card', () => {
    const v = compareTasks('store: UserMemoryStore.update() + test', 'store: UserMemoryStore.update() + unit test');
    expect(v.duplicate).toBe(true);
    expect(v.score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  test('la stessa rotta con e senza il corpo della richiesta', () => {
    const v = compareTasks('API: PATCH /api/memory', 'API: PATCH /api/memory { id, text }');
    expect(v.duplicate).toBe(true);
  });

  test('il testo identico a meno di maiuscole e spazi', () => {
    const v = compareTasks('UI: edit inline in MemoryClient.tsx', '  ui: edit inline in memoryclient.tsx  ');
    expect(v.reason).toBe('identical');
    expect(v.score).toBe(1);
  });

  test('riformulazione con parole diverse ma stesso oggetto', () => {
    const v = compareTasks('Ricerca: IDE con kanban integrato', 'Ricerca competitori IDE con kanban integrato');
    expect(v.duplicate).toBe(true);
  });
});

describe('fratelli: quello che NON va fuso', () => {
  /**
   * Questo e' il cuore. Queste sei card sono state aperte nella stessa tornata
   * (porting del browser su WebView2/WebKitGTK): condividono il 67% dei token e
   * sono sei pezzi di lavoro distinti. Una misura di sola sovrapposizione le
   * fonde, e cancella cinque pezzi di lavoro che nessuno ha fatto.
   */
  const fratelli = [
    'browser_screenshot su WebView2 + WebKitGTK',
    'browser_eval_js su WebView2 + WebKitGTK (con parita di forma del risultato)',
    'Cookie get/set su WebView2 + WebKitGTK',
    'browser_purge_cache su WebView2 e WebKitGTK',
  ];

  for (let i = 0; i < fratelli.length; i++) {
    for (let j = i + 1; j < fratelli.length; j++) {
      test(`«${fratelli[i]!.slice(0, 28)}» != «${fratelli[j]!.slice(0, 28)}»`, () => {
        const v = compareTasks(fratelli[i]!, fratelli[j]!);
        expect(v.duplicate).toBe(false);
      });
    }
  }

  test('due terzi del testo in comune, e comunque non sono la stessa card', () => {
    const v = compareTasks(fratelli[0]!, 'browser_eval_js su WebView2 + WebKitGTK');
    expect(v.score).toBeCloseTo(0.667, 2); // misurato: alto, ma sotto la soglia
    expect(v.duplicate).toBe(false);
    expect(v.reason).toBe('anchors-differ'); // il nome della cosa da fare cambia
  });

  /**
   * Qui il guard delle ancore e' l'UNICA cosa che decide.
   *
   * Onesta': sulle 1.447 card vive di oggi nessuna coppia con ancore in
   * conflitto arriva a 0,72 (la piu' alta e' proprio quella qui sopra, 0,667),
   * quindi il guard non ribalta nessuna fusione sul dato attuale. Diventa
   * l'unico argine appena i titoli si allungano: basta una parola condivisa in
   * piu' sugli stessi fratelli e la sola soglia li fonderebbe. Il caso e'
   * costruito allungando una coppia VERA, non inventato.
   */
  test('fratelli con un titolo piu lungo: sopra soglia, e li ferma solo il guard', () => {
    const a = 'Download: eventi di browser_screenshot su WebView2 + WebKitGTK';
    const b = 'Download: eventi di browser_eval_js su WebView2 + WebKitGTK';
    const v = compareTasks(a, b);
    expect(v.score).toBeGreaterThan(DUPLICATE_THRESHOLD);
    expect(v.duplicate).toBe(false);
    expect(v.reason).toBe('anchors-differ');
  });

  test('due release diverse dello stesso comando restano due card', () => {
    // Reali. Il numero di versione e' un'ancora: 2.2.98 non e' 2.2.112.
    const v = compareTasks(
      '3. cargo tauri build, Topics.app 2.2.98 + firma stabile',
      '4b. cargo tauri build, Topics.app 2.2.112 (target fuori dal worktree)',
    );
    expect(v.duplicate).toBe(false);
  });

  test('una card piu precisa non e una card diversa: il dettaglio in piu non blocca', () => {
    // Reali, 0,92. La seconda aggiunge il numero della migration.
    const v = compareTasks(
      '3. Migration: autore (persona + dispositivo) sui messaggi',
      'Migration 093: autore (persona + dispositivo) sui messaggi',
    );
    expect(v.duplicate).toBe(true);
    expect(v.reason).toBe('near');
  });

  test('due tappe numerate della stessa release non sono la stessa tappa', () => {
    const v = compareTasks(
      '4a. Prep 2.2.112: deps + client in public/ + tre sidecar universal',
      '4b. cargo tauri build, Topics.app 2.2.112 (target fuori dal worktree)',
    );
    expect(v.duplicate).toBe(false);
  });

  test('un titolo corto non ha abbastanza superficie per un giudizio', () => {
    const v = compareTasks('Cancelli e prova', 'Cancelli e video');
    expect(v.duplicate).toBe(false);
    expect(v.reason).toBe('too-short');
  });
});

describe('gruppi su una board', () => {
  const board: SimilarTask[] = [
    { id: 'a', text: 'store: UserMemoryStore.update() + test', createdAt: '2026-08-01T10:00:00Z' },
    { id: 'b', text: 'store: UserMemoryStore.update() + unit test', createdAt: '2026-08-01T11:00:00Z' },
    { id: 'c', text: 'store: UserMemoryStore.update(companyId, userId, id, text)', createdAt: '2026-08-02T09:00:00Z' },
    { id: 'd', text: 'browser_screenshot su WebView2 + WebKitGTK', createdAt: '2026-08-01T09:00:00Z' },
    { id: 'e', text: 'Cookie get/set su WebView2 + WebKitGTK', createdAt: '2026-08-01T09:30:00Z' },
  ];

  test('la superstite e la piu vecchia: e quella che ha gia il thread', () => {
    const [group] = findDuplicateGroups(board);
    expect(group!.survivor.id).toBe('a');
    expect(group!.duplicates.map((t) => t.id)).toEqual(['b']);
  });

  /**
   * Il limite, scritto perche' non torni a sorpresa: la terza card della stessa
   * famiglia («update(companyId, userId, id, text)») resta FUORI, a 0,44. La
   * lista di argomenti porta quattro token che l'altra non ha, e Dice li conta.
   * Un umano direbbe che e' lo stesso lavoro. Restare fuori e' il verso giusto
   * dell'errore: chi fonde perde, chi non fonde vede una card in piu'.
   */
  test('il limite noto: la variante con la firma per esteso resta fuori', () => {
    const v = compareTasks(board[0]!.text, board[2]!.text);
    expect(v.score).toBeCloseTo(0.444, 2);
    expect(v.duplicate).toBe(false);
    expect(v.reason).toBe('below-threshold');
  });

  test('i fratelli restano fuori da ogni gruppo', () => {
    const groups = findDuplicateGroups(board);
    const raggruppati = groups.flatMap((g) => [g.survivor.id, ...g.duplicates.map((t) => t.id)]);
    expect(raggruppati).not.toContain('d');
    expect(raggruppati).not.toContain('e');
  });

  /**
   * Il gruppo e' a STELLA, non a catena. Misurato sulla board vera: con le
   * componenti connesse finivano insieme «4. Barra verde (tsc + unit del
   * server) e commit» e «5. Barra verde: bun test + typecheck», che si
   * somigliano 0,36, agganciate da un anello intermedio. Chi legge `minScore`
   * deve poterlo confrontare con la card che RESTA.
   */
  test('nessun membro entra per transitivita: ognuno e doppione della superstite', () => {
    const catena: SimilarTask[] = [
      { id: 'x', text: 'Server: payload con blockedBy risolto {id,text,status}', createdAt: '2026-08-01T00:00:00Z' },
      { id: 'y', text: 'Server: risolvere il bloccante nel payload (blockedBy {id,text,status,archived})', createdAt: '2026-08-02T00:00:00Z' },
      { id: 'z', text: 'Client: mostrare il bloccante come chip nella card', createdAt: '2026-08-03T00:00:00Z' },
    ];
    const groups = findDuplicateGroups(catena);
    for (const g of groups) {
      for (const d of g.duplicates) {
        expect(compareTasks(g.survivor.text, d.text).duplicate).toBe(true);
      }
      expect(g.minScore).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
    }
  });

  test('una board senza doppioni non produce gruppi', () => {
    const groups = findDuplicateGroups(board.filter((t) => t.id === 'd' || t.id === 'e'));
    expect(groups).toEqual([]);
  });
});

describe('vicini al momento della creazione', () => {
  const vive: SimilarTask[] = [
    { id: 'a', text: 'Isolamento per-pane su Windows/Linux: data_directory per contextId' },
    { id: 'b', text: 'browser_purge_cache su WebView2 e WebKitGTK' },
    { id: 'c', text: 'Cancelli, build della app e prova video sulla pane viva' },
  ];

  test('chi sta per aprire un doppione se lo vede dire', () => {
    const found = findNeighbours('Isolamento per-pane Windows/Linux con data_directory per contextId', vive);
    expect(found[0]!.task.id).toBe('a');
    expect(found[0]!.duplicate).toBe(true);
  });

  test('un titolo nuovo non sveglia nessun vicino', () => {
    expect(findNeighbours('Sonda della CPU vera sotto carico altrui', vive)).toEqual([]);
  });

  test('il quasi-doppione compare come vicino, ma NON come doppione', () => {
    const found = findNeighbours('browser_purge_data_store su WebView2 e WebKitGTK', vive);
    expect(found[0]!.task.id).toBe('b');
    expect(found[0]!.duplicate).toBe(false); // ancore diverse: e' un fratello
    expect(found[0]!.score).toBeGreaterThan(0.55);
  });
});
