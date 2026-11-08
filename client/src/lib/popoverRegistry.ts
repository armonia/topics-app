/**
 * popoverRegistry — l'invariante «un popover alla volta».
 *
 * Fino al 2026-08-06 quell'invariante NON esisteva: sembrava esistere.
 * `useDismissable` chiude un menu su `pointerdown` fuori dai suoi ref, quindi
 * aprendo col MOUSE il pointerdown sul nuovo trigger chiudeva il precedente —
 * un effetto collaterale del puntatore, non una regola. Ogni superficie aperta
 * da TASTIERA lo aggirava: ⌘N (`useKeyboardShortcuts` → evento window →
 * `PaneAddMenu`) non tocca nessun pointer, così la palette si aggiungeva alla
 * pila e i dropdown già aperti restavano montati. Misurato sull'app viva:
 * dropdown della tab bar aperto = 1 menu, poi ⌘N = 2 menu contemporanei.
 *
 * La regola, in una riga: **all'apertura, un popover chiude ogni altro popover
 * aperto che non lo CONTIENE.**
 *
 * Il contenimento è ciò che distingue «un fratello ha preso il posto» da «un
 * figlio si è aperto dentro il padre»: se il trigger del nuovo popover vive
 * dentro il pannello di uno già aperto, quello è il suo genitore e deve restare
 * su (un sottomenu non uccide il menu che lo ospita). Oggi in-app non c'è
 * nessun annidamento del genere, ma la regola scritta così non va rivista il
 * giorno in cui ce ne sarà uno — e non ha bisogno di un flag per call-site.
 *
 * Il trigger è `refs[0]`, che è già il contratto documentato di
 * `useDismissable` («refs[0] is the trigger for focus-restore»), NON
 * `document.activeElement`: quando ⌘N parte con il focus dentro un menu aperto
 * (il primitivo `Menu` mette il fuoco nel pannello), activeElement direbbe
 * «sono suo figlio» e i due menu resterebbero aperti insieme — cioè esattamente
 * il bug.
 */

/** Un popover registrato mentre è aperto. */
export interface PopoverEntry {
  /** Chiude QUESTO popover (di norma `onClose` del suo `useDismissable`). */
  close: () => void;
  /** Il trigger dichiarato di questo popover — `refs[0].current` al momento
   *  dell'apertura. `null` quando non è ancora montato. */
  trigger: () => Node | null;
  /** Ogni nodo che conta come "dentro" questo popover (trigger + pannello). */
  nodes: () => Array<Node | null>;
  /** false = questo popover non caccia nessuno (sotto-superficie deliberata). */
  exclusive: boolean;
}

/**
 * Chi va chiuso quando `opener` si apre, dato l'insieme dei popover già aperti.
 *
 * Puro e senza DOM apposta: la regola è la parte che conta e si testa da sola
 * (`popoverRegistry.test.ts`). `contains` è iniettato così il test può
 * descrivere l'annidamento senza costruire un albero vero.
 */
export function popoversToClose<T extends { nodes: () => Array<Node | null>; trigger?: () => Node | null }>(
  openEntries: readonly T[],
  opener: { trigger: () => Node | null; exclusive: boolean },
  contains: (parent: Node, child: Node) => boolean,
): T[] {
  if (!opener.exclusive) return [];
  const trigger = opener.trigger();
  if (!trigger) return [...openEntries]; // nessun trigger noto = non può essere figlio di nessuno
  return openEntries.filter((other) => !ancestors(openEntries, trigger, contains).has(other));
}

/**
 * Every open entry that holds `trigger`, directly or through a chain of open
 * levels: the parent that holds it, the parent that holds THAT parent's
 * trigger, and so on up.
 *
 * Direct containment alone missed the grandparent: a selector inside a level of
 * the user menu has its trigger in the level, and the level's trigger is a row
 * of the menu, so the menu does not contain the selector's trigger and was
 * evicted, taking the level and the selector down with it.
 */
function ancestors<T extends { nodes: () => Array<Node | null>; trigger?: () => Node | null }>(
  entries: readonly T[],
  trigger: Node,
  contains: (parent: Node, child: Node) => boolean,
): Set<T> {
  const holds = (entry: T, node: Node) => entry.nodes().some((n) => !!n && contains(n, node));
  const found = new Set<T>();
  let frontier: Node[] = [trigger];
  while (frontier.length > 0) {
    const next: Node[] = [];
    for (const entry of entries) {
      if (found.has(entry) || !frontier.some((node) => holds(entry, node))) continue;
      found.add(entry);
      const own = entry.trigger?.();
      if (own) next.push(own);
    }
    frontier = next;
  }
  return found;
}

/** I popover attualmente aperti, in ordine di apertura. */
const open = new Set<PopoverEntry>();

/**
 * Nodes that count as INSIDE for a popover although they are not its own: the
 * confirmation asked from inside it.
 *
 * A level of the user menu holds forms, and a form asks «remove the licence?»
 * through the app's confirmation dialog. That dialog is a modal on `<body>`:
 * geometrically outside the menu, so pressing «Cancel» was a press outside,
 * and the menu closed under the person who was answering a question it had
 * asked. A dialog opened from inside a popover therefore SHELTERS the popovers
 * open at that moment (`shelterOpenPopovers`), and they treat its nodes as
 * theirs until it closes.
 */
const shelters = new Map<PopoverEntry, Set<() => Node | null>>();

function forget(entry: PopoverEntry): void {
  open.delete(entry);
  shelters.delete(entry);
}

const domContains = (parent: Node, child: Node) => parent.contains(child);

/**
 * Registra `entry` come aperto, chiudendo prima chi deve cedergli il posto.
 * Ritorna la funzione di deregistrazione (da chiamare alla chiusura).
 */
export function registerOpenPopover(entry: PopoverEntry): () => void {
  for (const victim of popoversToClose([...open], entry, domContains)) {
    // Prima si toglie dal registro, poi si chiude: `close()` fa scattare la
    // pulizia dell'altro hook, che proverebbe a togliersi da solo — togliersi
    // due volte da un Set è innocuo, ma l'ordine tiene il registro coerente
    // anche se `close()` dovesse aprire qualcos'altro.
    forget(victim);
    victim.close();
  }
  open.add(entry);
  return () => { forget(entry); };
}

/**
 * Every popover open right now keeps `node` as inside until the returned
 * function is called. For a dialog that a popover asked for (see `shelters`).
 */
export function shelterOpenPopovers(node: () => Node | null): () => void {
  const sheltered = [...open];
  for (const entry of sheltered) {
    const set = shelters.get(entry) ?? new Set();
    set.add(node);
    shelters.set(entry, set);
  }
  return () => {
    for (const entry of sheltered) shelters.get(entry)?.delete(node);
  };
}

/** The nodes sheltered by `entry`: inside for it, although not its own. */
export function shelteredNodes(entry: PopoverEntry): Array<Node | null> {
  return [...(shelters.get(entry) ?? [])].map((node) => node());
}

/**
 * Chiude TUTTI i popover aperti. La usano le superfici che non sono popover ma
 * li devono comunque sgomberare: i modali a schermo intero (⌘K, Impostazioni,
 * scorciatoie), che altrimenti si aprirebbero sotto un dropdown rimasto su —
 * i popover stanno a `Z_POPOVER`, i modali a `Z_MODAL`, ma un menu che
 * sopravvive a un modale è comunque un menu orfano.
 */
export function closeAllPopovers(): void {
  for (const entry of [...open]) {
    forget(entry);
    entry.close();
  }
}

/**
 * Who makes way for a panel hung from `anchor`, the element its door handed
 * over (`Settings/HomePanelHost`): every open popover but those that hold
 * `anchor` inside their PANEL, and the chain of levels above them.
 *
 * The door's own menu goes even though it "holds" the anchor: its TRIGGER is
 * the anchor (the model selector, the «+»), and `popoversToClose` would take
 * the panel for its child and keep both open. The menu that holds the
 * selector in its body (the board settings) stays: closing it with everything
 * else unmounted the anchor, and the panel was placed against a detached
 * element at 0,0, over the sidebar.
 *
 * Pure like `popoversToClose`: `contains` is injected.
 */
export function popoversToCloseAround<T extends { nodes: () => Array<Node | null>; trigger?: () => Node | null }>(
  openEntries: readonly T[],
  anchor: Node,
  contains: (parent: Node, child: Node) => boolean,
): T[] {
  const isDoor = (entry: T) => {
    const own = entry.trigger?.();
    return !!own && (own === anchor || contains(own, anchor));
  };
  const keep = ancestors(openEntries.filter((entry) => !isDoor(entry)), anchor, contains);
  return openEntries.filter((entry) => !keep.has(entry));
}

/** Closes what `popoversToCloseAround` says, on the open popovers. */
export function closePopoversAround(anchor: Node): void {
  for (const victim of popoversToCloseAround([...open], anchor, domContains)) {
    forget(victim);
    victim.close();
  }
}

/**
 * I nodi dei popover aperti che si sono dichiarati SOTTO-SUPERFICI
 * (`exclusive: false`).
 *
 * Serve all'altra metà del contratto. `exclusive: false` dice «aprendomi non
 * caccio nessuno»: risolve il registro, ma non basta, perché `useDismissable`
 * chiude anche su un `pointerdown` FUORI dai propri ref — e un menu al cursore
 * vive in un portal su `<body>`, cioè fuori dal pannello che lo ospita. Il
 * risultato era che cliccare una voce del menu chiudeva il pannello genitore, e
 * il menu — che è renderizzato da quel pannello — spariva PRIMA che il `click`
 * arrivasse al bottone: la voce non si poteva scegliere.
 *
 * Una sotto-superficie dichiarata conta quindi come «dentro» per tutti: se il
 * puntatore è caduto lì, nessun popover si chiude.
 */
export function subSurfaceNodes(): Array<Node | null> {
  const nodes: Array<Node | null> = [];
  for (const entry of open) {
    if (!entry.exclusive) nodes.push(...entry.nodes());
  }
  return nodes;
}

/**
 * The nodes of the open popovers that are CHILDREN of `parent`: those whose
 * trigger lives inside one of `parent`'s nodes.
 *
 * It is the other half of the containment rule written at the top of this
 * file. The registry already knows that a child, on opening, does not evict its
 * parent; but the parent ALSO closes on a `pointerdown` outside its own refs,
 * and the child's panel is portalled to `<body>`, i.e. geometrically outside.
 * Without this function, picking an option in the `Select` inside the board
 * settings dropdown closed the dropdown, and with it the `Select` it hosted,
 * before the `click` reached the option. The `Select` is `exclusive: true` on
 * purpose (it must evict its siblings), so `subSurfaceNodes` cannot see it:
 * the criterion here is not how it declared itself but WHERE its trigger is.
 */
export function descendantPopoverNodes(parent: PopoverEntry): Array<Node | null> {
  const nodes: Array<Node | null> = [];
  const entries = [...open];
  for (const entry of entries) {
    // By IDENTITY, not by geometry: a popover whose refs include a container
    // of its own trigger (`extraRefs`) would contain itself, and a popover
    // that is its own child would never close on Escape again.
    if (entry === parent) continue;
    const trigger = entry.trigger();
    if (!trigger) continue;
    // A grandchild counts too: a selector inside a level the parent opened
    // (see `ancestors`).
    if (ancestors(entries.filter((e) => e !== entry), trigger, domContains).has(parent)) nodes.push(...entry.nodes());
  }
  return nodes;
}

/** How many popovers are open now. `useModalDialog` reads it to yield Escape to a popover opened inside the dialog. */
export function openPopoverCount(): number {
  return open.size;
}
