import { describe, expect, test } from 'bun:test';
import { selectLatestTodo } from './selectLatestTodo';
import { TODO_TOOL_NAMES, deriveToolDetail } from './toolDetail';
import type { ChatMessage, ToolCall } from '../../types';

function todoCall(id: string, items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }>): ToolCall {
  return { id, name: 'TodoWrite', args: { todos: items }, status: 'success', detail: { type: 'todo', items } };
}

function asstWith(calls: ToolCall[]): ChatMessage {
  return { id: `m_${Math.random()}`, role: 'assistant', content: '', timestamp: new Date().toISOString(), toolCalls: calls };
}

describe('selectLatestTodo', () => {
  test('returns null when there are no todos', () => {
    expect(selectLatestTodo([])).toBeNull();
    expect(selectLatestTodo([{ id: 'u', role: 'user', content: 'hi', timestamp: '' }])).toBeNull();
  });

  test('picks the most recent TodoWrite', () => {
    const messages: ChatMessage[] = [
      asstWith([todoCall('t1', [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }])]),
      asstWith([todoCall('t2', [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
        { content: 'c', status: 'pending' },
      ])]),
    ];
    const snap = selectLatestTodo(messages)!;
    expect(snap.total).toBe(3);
    expect(snap.done).toBe(1);
    expect(snap.active?.activeForm).toBe('Doing b');
  });

  test('scans within a message newest-call-first', () => {
    const msg = asstWith([
      todoCall('t1', [{ content: 'old', status: 'pending' }]),
      todoCall('t2', [{ content: 'new1', status: 'completed' }, { content: 'new2', status: 'pending' }]),
    ]);
    const snap = selectLatestTodo([msg])!;
    expect(snap.total).toBe(2);
    expect(snap.items[0].content).toBe('new1');
  });

  test('an empty latest todo list pins nothing', () => {
    expect(selectLatestTodo([asstWith([todoCall('t', [])])])).toBeNull();
  });

  test('ignores non-todo tool calls', () => {
    const msg = asstWith([{ id: 'b', name: 'Bash', args: { command: 'ls' }, status: 'success' }]);
    expect(selectLatestTodo([msg])).toBeNull();
  });
});

/**
 * IL PREZZO DI QUESTA SELEZIONE, che gira a ogni frame di streaming.
 *
 * Prima chiamava `resolveToolDetail` su OGNI tool call del trascritto — e quello
 * fa un parse Zod del `detail` che arriva dal server. Su una sessione che non ha
 * mai visto una todo (la maggioranza) era un parse per tool call, sessanta volte
 * al secondo, per rispondere sempre `null`.
 */
describe('selectLatestTodo — quanto lavoro fa davvero', () => {
  /**
   * Una tool call che CONTA chi le legge gli `args`. È la firma della
   * derivazione: il discriminante a monte guarda `detail` e `name` e si ferma,
   * `deriveToolDetail` invece apre `args` per ogni chiamata che gli arriva.
   */
  function spia(id: string, name: string, letture: { n: number }): ToolCall {
    const tc = { id, name, args: { command: 'ls' }, status: 'success' as const };
    return new Proxy(tc, {
      get(target, prop, receiver) {
        if (prop === 'args') letture.n++;
        return Reflect.get(target, prop, receiver);
      },
    }) as ToolCall;
  }

  test('senza una TodoWrite non si deriva niente: basta il nome', () => {
    const letture = { n: 0 };
    const messages = [asstWith([spia('b1', 'Bash', letture), spia('b2', 'Read', letture)])];
    expect(selectLatestTodo(messages)).toBeNull();
    expect(letture.n).toBe(0);
  });

  test('il prefisso identico non si riscandisce: risposta STABILE, stesso oggetto', () => {
    const testa = [
      asstWith([todoCall('t1', [{ content: 'a', status: 'in_progress' }])]),
      { id: 'u1', role: 'user' as const, content: 'ok', timestamp: '' },
    ];
    const primo = selectLatestTodo(testa)!;
    const secondo = selectLatestTodo([...testa, asstWith([])])!;
    expect(secondo).toBe(primo);
  });

  test('una todo nuova in coda vince su quella nel prefisso', () => {
    const testa = [asstWith([todoCall('t1', [{ content: 'vecchia', status: 'pending' }])])];
    selectLatestTodo(testa);
    const snap = selectLatestTodo([...testa, asstWith([todoCall('t2', [
      { content: 'nuova1', status: 'completed' },
      { content: 'nuova2', status: 'pending' },
    ])])])!;
    expect(snap.total).toBe(2);
    expect(snap.items[0].content).toBe('nuova1');
  });

  test('cambiando la TESTA la memoria non mente: si riscandisce', () => {
    const coda = [{ id: 'u9', role: 'user' as const, content: 'ok', timestamp: '' }];
    const conTodo = [asstWith([todoCall('t1', [{ content: 'c\'è', status: 'pending' }])]), ...coda];
    expect(selectLatestTodo(conTodo)!.total).toBe(1);
    const senzaTodo = [asstWith([{ id: 'b', name: 'Bash', args: {}, status: 'success' as const }]), ...coda];
    expect(selectLatestTodo(senzaTodo)).toBeNull();
  });

  test('una tool call con un `detail` di tipo todo passa anche se il nome è altro', () => {
    // Il `detail` del server è già tipizzato: quando c'è, decide lui. Il filtro
    // sul nome non deve poter nascondere una todo che il server ha dichiarato.
    const tc: ToolCall = {
      id: 'x', name: 'mcp__board__plan', args: {}, status: 'success',
      detail: { type: 'todo', items: [{ content: 'dal server', status: 'pending' }] },
    };
    expect(selectLatestTodo([asstWith([tc])])!.items[0].content).toBe('dal server');
  });
});

/**
 * IL DETTAGLIO DEL SERVER CHE NON SI CAPISCE PIÙ (deriva di schema).
 *
 * `resolveToolDetail` esiste anche per questo: un `detail` che non passa la
 * validazione Zod non è una risposta, è un dato rotto, e il ripiego ricostruisce
 * la todo dal nome e dagli argomenti. La striscia però decideva prima, sul solo
 * `detail.type`, quindi si autoescludeva dal ripiego: la stessa chiamata
 * disegnava la TodoCard nel trascritto e nessuna striscia sopra il composer.
 */
describe('deriva di schema sul detail del server', () => {
  /** Una todo vera, con addosso un detail che Zod rifiuta. */
  function conDetailRotto(detail: unknown): ToolCall {
    return {
      id: 'rotta',
      name: 'TodoWrite',
      args: { todos: [{ content: 'dal nome', status: 'in_progress', activeForm: 'Ci lavoro' }] },
      status: 'success',
      detail: detail as ToolCall['detail'],
    };
  }

  test('un detail malformato NON cancella la striscia: si ricade sul nome', () => {
    // `shell` senza `command`: la forma è sbagliata, quindi `parseToolCallDetail`
    // fallisce e `resolveToolDetail` deriva dal nome. Il tipo dichiarato non è
    // `todo`, ed è esattamente il caso che il filtro scartava.
    const snap = selectLatestTodo([asstWith([conDetailRotto({ type: 'shell' })])]);
    expect(snap?.items[0].content).toBe('dal nome');
    expect(snap?.active?.activeForm).toBe('Ci lavoro');
  });

  test('un detail con un `type` che non esiste si comporta allo stesso modo', () => {
    const snap = selectLatestTodo([asstWith([conDetailRotto({ type: 'todoo', items: [] })])]);
    expect(snap?.items[0].content).toBe('dal nome');
  });

  test('ma un detail VALIDO di un altro tipo resta la verità: niente striscia', () => {
    // Il ripiego vale solo quando il dato è rotto. Un `shell` ben formato su una
    // chiamata di nome TodoWrite è una scelta del server, e si rispetta.
    const tc: ToolCall = {
      id: 'shell', name: 'TodoWrite', args: { todos: [{ content: 'x', status: 'pending' }] },
      status: 'success', detail: { type: 'shell', command: 'ls' },
    };
    expect(selectLatestTodo([asstWith([tc])])).toBeNull();
  });
});

/**
 * I NOMI CHE PORTANO UNA TODO SONO UNA LISTA SOLA.
 *
 * Erano due: quella dei rami di `deriveToolDetail` e la copia che filtrava qui,
 * tenute uguali da un commento. Adesso il filtro importa la lista da lì; questo
 * test verifica l'altra metà, cioè che ogni nome della lista produca DAVVERO una
 * todo end-to-end. Un nome aggiunto al set ma non riconosciuto dal deriver
 * sarebbe un filtro che lascia passare una chiamata che poi non dà niente.
 */
describe('TODO_TOOL_NAMES e il deriver dicono la stessa cosa', () => {
  /** Argomenti plausibili per ciascuna delle due forme di todo. */
  function argsPer(nome: string): Record<string, unknown> {
    return nome.startsWith('todo')
      ? { todos: [{ content: `lista da ${nome}`, status: 'pending' }] }
      : { subject: `lista da ${nome}`, status: 'pending' };
  }

  test('ogni nome della lista produce una striscia', () => {
    expect(TODO_TOOL_NAMES.size).toBeGreaterThan(0);
    for (const nome of TODO_TOOL_NAMES) {
      const tc: ToolCall = { id: `c-${nome}`, name: nome, args: argsPer(nome), status: 'success' };
      const snap = selectLatestTodo([asstWith([tc])]);
      expect(snap, `${nome} deve produrre una todo`).not.toBeNull();
      expect(snap!.items[0].content).toBe(`lista da ${nome}`);
    }
  });

  test('e il nome vale anche in CamelCase, come lo scrive la CLI', () => {
    for (const nome of ['TodoWrite', 'TaskCreate', 'TaskUpdate']) {
      const tc: ToolCall = { id: `c-${nome}`, name: nome, args: argsPer(nome.toLowerCase()), status: 'success' };
      expect(selectLatestTodo([asstWith([tc])]), `${nome} deve produrre una todo`).not.toBeNull();
    }
  });

  test('un nome fuori dalla lista non produce niente', () => {
    const tc: ToolCall = { id: 'no', name: 'TodoRead', args: argsPer('todowrite'), status: 'success' };
    expect(selectLatestTodo([asstWith([tc])])).toBeNull();
  });
});

/**
 * L'altra direzione della deriva: un ramo NUOVO in `deriveToolDetail` che
 * restituisce `type: 'todo'` per un nome che il filtro non conosce. Il set non
 * può accorgersene da solo (i rami sono codice, non dati), quindi qui si prova
 * un corpus di nomi plausibili: se uno di loro produce una todo, deve essere
 * nella lista, o la striscia non la vedrà mai.
 */
describe('nessun nome fuori lista produce una todo', () => {
  const CORPUS = [
    'todowrite', 'todo_write', 'TodoWrite',
    'taskcreate', 'task_create', 'taskupdate', 'task_update', 'TaskUpdate',
    'todoread', 'todo_read', 'todo_update', 'todoupdate', 'todos', 'todolist',
    'taskdelete', 'task_delete', 'tasklist', 'task_list', 'taskwrite', 'task_write',
    'planwrite', 'plan_write', 'checklistwrite', 'checklist_write',
    'exitplanmode', 'task', 'write', 'bash',
  ];

  test('deriveToolDetail e TODO_TOOL_NAMES concordano su tutto il corpus', () => {
    const args = {
      todos: [{ content: 'x', status: 'pending' }],
      subject: 'x',
      status: 'pending',
      plan: 'un piano',
      command: 'ls',
      file_path: '/tmp/x',
    };
    for (const nome of CORPUS) {
      const detail = deriveToolDetail(nome, args);
      if (detail.type === 'todo') {
        expect(TODO_TOOL_NAMES.has(nome.toLowerCase().trim()), `${nome} produce una todo ma non è nel filtro`).toBe(true);
      }
    }
  });
});
