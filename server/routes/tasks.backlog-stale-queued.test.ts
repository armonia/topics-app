/**
 * IL GIRO Todo → Backlog → «Ferma», misurato controllo per controllo.
 *
 * La segnalazione diceva: «ho messo un task in To Do, l'ho spostato in backlog,
 * ho fatto fail, ma non è successo nulla». Il gesto senza nome era il bottone
 * «Ferma» del chip di dispatch, e il difetto NON era il bottone: era il chip.
 *
 * Il `claim` del dispatcher reclama `status = 'todo'` e basta. Una card che
 * lascia Todo esce dalla coda — ma finché `dispatch_state` restava `queued` la
 * card continuava a dire «in coda» (una partenza che non arriverà mai) e a
 * offrire «Ferma» (un agente mai nato). Premere quel bottone parcheggiava una
 * card già parcheggiata: nessuna colonna cambiava, nessuna riga lo diceva.
 *
 * Qui si fissano i DUE esiti che chiudono il giro, che sono i due rami del
 * criterio «o la card cambia stato, o compare il motivo per cui non può»:
 *
 *  1. uscendo da Todo il chip `queued` si spegne (la card CAMBIA, e con lei
 *     spariscono i comandi che quel chip accendeva). Lo spegne il SERVIZIO,
 *     non il dispatcher: `onLeaveTodo` lo faceva solo dentro la finestra di
 *     grazia, quindi una card rimasta in Todo piu' a lungo usciva col chip
 *     addosso — ed e' il caso che era stato segnalato. Il gancio resta perche'
 *     ha lavoro suo (i timer), ma non e' piu' l'unico a rispondere;
 *  2. «Ferma» su una card senza agente vivo risponde 409 `invalid_transition`,
 *     cioè un RIFIUTO che il client disegna accanto al bottone premuto — non
 *     un 200 che non muove niente.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

/** Il dispatcher finto: registra i gesti, non lancia niente. */
function fakeDispatcher(left: string[]) {
  return {
    onEnterTodo() { /* niente: qui si misura l'uscita */ },
    onLeaveTodo(taskId: string) { left.push(taskId); },
    onBlockerDone() { /* no-op */ },
    resume: async () => { /* no-op */ },
  } as never;
}

describe("card in backlog con un chip «in coda» stantio", () => {
  let db: Database;
  let broadcasts: unknown[];
  let left: string[];
  beforeEach(() => { db = freshDb(); broadcasts = []; left = []; });

  const router = () => createTasksRouter(makeCtx(db, broadcasts), fakeDispatcher(left), { abortTurn: async () => { /* no-op */ } });

  /** Card in Todo col chip che il tick le ha scritto, poi trascinata in Backlog. */
  async function todoPoiBacklog(r: ReturnType<typeof router>) {
    const created = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "giro", status: "todo" }))!.json();
    db.prepare("UPDATE tasks SET dispatch_state = 'queued' WHERE id = ?").run(created.id);
    const moved = await (await call(r, "PATCH", `/api/boards/pX/tasks/${created.id}`, { status: "backlog" }))!.json();
    return { id: created.id as string, moved };
  }

  test("l'uscita da Todo è un evento che il dispatcher riceve (è lui a spegnere il chip)", async () => {
    const r = router();
    const { id } = await todoPoiBacklog(r);
    // La rotta non spegne il chip da sé: passa la palla a `onLeaveTodo`, che è
    // l'unico posto che sa se c'è un turno in volo. Il gancio DEVE scattare, o
    // il chip resta acceso qualunque cosa faccia il dispatcher.
    expect(left).toContain(id);
  });

  test("«Ferma» su una card senza agente vivo: 409 con la ragione, non un 200 muto", async () => {
    const r = router();
    const created = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "ferma me", status: "backlog" }))!.json();
    const resp = (await call(r, "POST", `/api/boards/pX/tasks/${created.id}/stop`, {}))!;
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.code).toBe("invalid_transition");
    // La frase esiste: è quella che il client traduce e disegna sulla card.
    expect(String(body.error)).toMatch(/no active agent/i);
    // E la card non si è mossa di un millimetro: il rifiuto è totale.
    const after = await (await call(r, "GET", `/api/boards/pX/tasks/${created.id}`))!.json();
    expect(after.task.status).toBe("backlog");
    expect(after.task.dispatchState).toBeNull();
  });

  test("IL GIRO MUTO NON PUO' PIU' SUCCEDERE: uscita da Todo, chip spento, «Ferma» rifiutato", async () => {
    const r = router();
    // Il dispatcher finto NON spegne niente: se il chip si spegne lo stesso, a
    // spegnerlo e' il servizio, e cioe' un posto che c'e' sempre — anche quando
    // il dispatcher e' fermo, spento, o non ha mai visto passare questa card.
    // Era quello il buco: `onLeaveTodo` lo faceva solo dentro la finestra di
    // grazia, e una card rimasta in Todo piu' a lungo usciva col chip addosso.
    const { id, moved } = await todoPoiBacklog(r);
    expect(moved.status).toBe("backlog");
    expect(moved.dispatchState).toBeNull();

    // E senza chip stantio il gesto non e' piu' muto: non c'e' nessun agente da
    // fermare, e la rotta lo DICE invece di rispondere 200 e non muovere
    // niente. Questo era l'esito segnalato («ho premuto e non e' successo
    // nulla»); adesso e' irraggiungibile, perche' lo stato che lo produceva non
    // esiste piu'.
    const resp = (await call(r, "POST", `/api/boards/pX/tasks/${id}/stop`, {}))!;
    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe("invalid_transition");
  });

  test("un turno VIVO non lo spegne un trascinamento: solo «in coda» si spegne", async () => {
    const r = router();
    const created = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "vivo", status: "todo" }))!.json();
    db.prepare("UPDATE tasks SET dispatch_state = 'working' WHERE id = ?").run(created.id);
    const moved = await (await call(r, "PATCH", `/api/boards/pX/tasks/${created.id}`, { status: "backlog" }))!.json();
    // Un agente che sta scrivendo file non lo chiude un drag: lo chiude `/stop`,
    // che taglia il turno prima di parcheggiare. Spegnere il chip qui vorrebbe
    // dire perdere di vista un turno ancora in volo.
    expect(moved.dispatchState).toBe("working");
  });
});
