/**
 * Una superficie che copre TUTTA la finestra non si sceglie il piano da sola.
 *
 * `lib/popoverStyles.ts` dichiara la scala: popover e context-menu a 9999,
 * modali a 10000 (`Z_MODAL`), velo del bottom-sheet a 9998. `lib/modalStyles.ts`
 * la porta in Tailwind con `MODAL_LAYER` / `MODAL_OVERLAY`, e ci scrive sopra la
 * regola: «nessuna superficie modale scrive più il numero a mano».
 *
 * Era una REGOLA SCRITTA E NON FATTA RISPETTARE. Le costanti le usavano quattro
 * file; altre superfici a schermo intero si scrivevano il numero a mano, e
 * quasi tutte erano sul piano sbagliato: il dialogo di conferma a `z-[100]`
 * (cioè esattamente la quota che i popover sono alti apposta per scavalcare —
 * lo dice il commento di `Z_POPOVER`), il lightbox delle anteprime a `z-[200]`,
 * la vista ospite a `z-[9990]`. Il lightbox delle immagini in chat stava a
 * `z-[9999]`: non «sopra i popover», lo STESSO piano dei popover, con l'ordine
 * nel DOM a fare da arbitro fra due portal su `<body>`.
 *
 * È la forma esatta del bug per cui ⌘N «apriva tutti i dropdown»: una palette a
 * `z-[60]` finita 9939 sotto un menu già aperto. Un tipo non può impedire di
 * scrivere una classe Tailwind in una stringa, quindi il guardiano è un `grep`
 * strutturato — brutto, e l'unica cosa che regge qui.
 *
 * COSA VIETA, ESATTAMENTE: il numero a mano — sia `z-[9999]` sia `z-50` — su
 * una superficie a SCHERMO INTERO, cioè una stringa di classi che contiene sia
 * `fixed` sia `inset-0`. Vale entrambe le forme di proposito: la prima versione
 * di questo cancello guardava solo `z-[…]`, e avrebbe accettato che un `z-[100]`
 * segnalato venisse «riparato» riscrivendolo `z-50`, che è lo stesso difetto in
 * un'altra grafia — anzi, è LETTERALMENTE il caso che l'intestazione di
 * `modalStyles.ts` racconta come già risolto.
 *
 * COSA NON VIETA: gli z-index piccoli interni a un componente (il badge sopra
 * un'icona, la colonna `sticky` di un diff, i livelli dentro il pannello del
 * browser remoto) — vivono nello stacking context della loro pane e non
 * competono con niente. Né le card ancorate a un angolo (toast, richieste di
 * pairing): sono un'altra famiglia, transitoria e non bloccante, e spostarle di
 * piano sarebbe un cambio di comportamento, non un cablaggio.
 *
 * Limite dichiarato: il controllo legge la forma `className`, che è come è
 * scritto ogni overlay dell'app. Un `style={{ position:'fixed', inset:0,
 * zIndex:N }}` non sarebbe visto — oggi non esiste, e il giorno che esistesse
 * andrebbe aggiunto qui invece che allargato il buco.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RADICE = join(import.meta.dir, "..", "..");
const SORGENTI = join(RADICE, "client", "src");

/**
 * Superfici a schermo intero che stanno sulla scala LOCALE del chrome (z-40 /
 * z-50) e ci stanno a ragione: ognuna è il velo o l'acchiappa-click di un
 * pannello che vive sulla stessa scala, nello stesso stacking context. Alzarle
 * al piano dei modali le farebbe passare SOPRA la cosa che devono servire.
 *
 * La chiave è la corsa di classi ESATTA, non il file: così il giorno in cui una
 * di queste cambia, o il file ne guadagna un'altra, il cancello se ne accorge.
 */
const CHROME_LEGITTIMO = new Map<string, string>([
  [
    "client/src/App.tsx :: fixed inset-0 bg-black/50 z-40 sidebar-scrim",
    "velo della sidebar su mobile, sotto la sidebar stessa",
  ],
  [
    "client/src/components/Project/ProjectSidebar.tsx :: fixed inset-0 bg-black/50 z-40",
    "velo del drawer di progetto su mobile, sotto il drawer stesso",
  ],
]);

/**
 * I difetti NOTI, e il motivo per cui non sono stati raddrizzati qui.
 *
 * Sono due modali veri (`role="dialog"`, `aria-modal`, `MODAL_PANEL`,
 * `MODAL_BACKDROP`) il cui contenitore è rimasto a `z-50` — cioè il caso che
 * l'intestazione di `modalStyles.ts` descrive come il bug da cui il modulo è
 * nato, sopravvissuto in due file su sei. Sotto ogni popover (9999).
 *
 * Non è un cablaggio da una riga, ed è per questo che è una BASELINE e non una
 * riparazione: `TopicSettingsModal` apre a sua volta un `ConfirmDialog` («ci
 * sono modifiche non salvate»). Oggi quel dialogo lo copre per un accidente
 * aritmetico (100 contro 50); portando il modale a `MODAL_LAYER` i due
 * finirebbero a PARI, e siccome il modale è un portal appeso a `<body>` dopo la
 * radice React, vincerebbe lui — la conferma sparirebbe dietro il modale che
 * l'ha chiesta. Raddrizzarli davvero vuol dire un piano per i modali annidati,
 * che è una decisione sulla scala, non una sostituzione di stringa.
 *
 * L'uguaglianza è STRETTA: un difetto nuovo fa fallire, e anche ripararne uno
 * di questi fa fallire finché non si accorcia la lista. È un cricchetto, non
 * un permesso.
 */
const DIFETTI_NOTI = [
  "client/src/components/Modals/NewTopicModal.tsx :: fixed inset-0 z-50 flex items-center justify-center",
  "client/src/components/Modals/TopicSettingsModal.tsx :: fixed inset-0 z-50 flex items-center justify-center",
];

function esplora(dir: string, acc: string[] = []): string[] {
  for (const voce of readdirSync(dir)) {
    if (voce === "node_modules" || voce.startsWith(".")) continue;
    const pieno = join(dir, voce);
    if (statSync(pieno).isDirectory()) esplora(pieno, acc);
    else if (/\.tsx?$/.test(voce) && !/\.test\.tsx?$/.test(voce)) acc.push(pieno);
  }
  return acc;
}

/**
 * Le corse di classi LETTERALI contigue del sorgente.
 *
 * I confini sono gli apici, i backtick e le graffe: è precisamente ciò che
 * spezza una stringa di classi in JSX, quindi ogni corsa è un pezzo di
 * `className` scritto a mano, e un `${…}` interrompe la corsa — che è il caso
 * sano, perché lì il piano arriva da una costante e non da un letterale.
 */
function corseDiClassi(testo: string): string[] {
  return testo.split(/['"`{}]/).map((c) => c.replace(/\s+/g, " ").trim());
}

/** Copre tutta la finestra: `fixed` + `inset-0` nella stessa corsa di classi. */
function eSuperficieASchermoIntero(corsa: string): boolean {
  return /(?:^| )fixed(?: |$)/.test(corsa) && /(?:^| )inset-0(?: |$)/.test(corsa);
}

/** Un piano scritto a mano: sia la scala Tailwind (`z-50`) sia l'arbitraria. */
const Z_A_MANO = /(?:^| )z-(?:\d+|\[\d+\])(?: |$)/;

interface Esito {
  colpevoli: string[];
  superficiEsaminate: number;
}

function scandisci(file: { rel: string; testo: string }[]): Esito {
  const colpevoli: string[] = [];
  let superficiEsaminate = 0;
  for (const { rel, testo } of file) {
    for (const corsa of corseDiClassi(testo)) {
      if (!eSuperficieASchermoIntero(corsa)) continue;
      superficiEsaminate++;
      if (!Z_A_MANO.test(corsa)) continue;
      const chiave = `${rel} :: ${corsa}`;
      if (CHROME_LEGITTIMO.has(chiave)) continue;
      colpevoli.push(chiave);
    }
  }
  return { colpevoli: colpevoli.sort(), superficiEsaminate };
}

describe("il piano di una superficie a schermo intero si dichiara, non si indovina", () => {
  const file = esplora(SORGENTI).map((f) => ({
    rel: f.slice(RADICE.length + 1),
    testo: readFileSync(f, "utf8"),
  }));

  it("nessun overlay a schermo intero si scrive il piano a mano, oltre i difetti noti", () => {
    const { colpevoli, superficiEsaminate } = scandisci(file);
    expect(colpevoli).toEqual(DIFETTI_NOTI);

    // Non vacuo, su due assi. Se il giro dei file o il ritaglio delle corse si
    // rompesse, l'elenco sarebbe vuoto e questo test verde per il motivo
    // sbagliato — cioè esattamente il guasto che sta presidiando.
    expect(file.length).toBeGreaterThan(100);
    expect(superficiEsaminate).toBeGreaterThanOrEqual(15);
  });

  it("le eccezioni di chrome esistono ancora dove sono dichiarate", () => {
    // Un'eccezione che non corrisponde più a niente è un permesso che resta
    // aperto su un file che nel frattempo è cambiato.
    const viste = new Set<string>();
    for (const { rel, testo } of file) {
      for (const corsa of corseDiClassi(testo)) {
        if (eSuperficieASchermoIntero(corsa)) viste.add(`${rel} :: ${corsa}`);
      }
    }
    expect([...CHROME_LEGITTIMO.keys()].filter((k) => !viste.has(k))).toEqual([]);
  });

  it("il setaccio riconosce il difetto che sta presidiando", () => {
    // Il dialogo di conferma com'era: stesse classi, piano scritto a mano.
    const arbitrario = [{
      rel: "finto.tsx",
      testo: `<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30" />`,
    }];
    expect(scandisci(arbitrario).colpevoli).toHaveLength(1);

    // E la stessa cosa riscritta sulla scala Tailwind, che è come il difetto si
    // ripresenterebbe se qualcuno «riparasse» il numero cambiandogli grafia.
    const scala = [{
      rel: "finto.tsx",
      testo: `<div className="fixed inset-0 z-50 flex items-center justify-center" />`,
    }];
    expect(scandisci(scala).colpevoli).toHaveLength(1);

    // NON grida su ciò che è legittimo: uno z-index piccolo interno a un
    // componente, e una card ancorata a un angolo.
    const legittimo = [{
      rel: "finto.tsx",
      testo: `
        <span className="sticky left-16 z-[1] bg-app-inset" />
        <div className="absolute inset-0 z-[5] flex items-center justify-center" />
        <div className="fixed bottom-4 right-4 z-[100] max-w-xs" />
      `,
    }];
    expect(scandisci(legittimo).colpevoli).toEqual([]);

    // La forma sana passa: il piano arriva da una costante interpolata, quindi
    // nella corsa letterale non c'è nessun numero.
    const sano = [{
      rel: "finto.tsx",
      testo: "<div className={`fixed inset-0 ${MODAL_LAYER} flex items-center`} />",
    }];
    expect(scandisci(sano).colpevoli).toEqual([]);
  });

  it("le superfici riparate prendono il piano dalla costante", () => {
    // L'altra metà del cancello: vietare il numero a mano non impedisce di
    // togliere lo z-index e basta, che rimetterebbe il dialogo sotto i popover
    // in un modo che il controllo sopra non vedrebbe.
    const RIPARATE = [
      "client/src/components/Shared/ConfirmDialog.tsx",
      "client/src/components/Board/PreviewMedia.tsx",
      "client/src/components/MessageContent.tsx",
      "client/src/components/Auth/PairingGate.tsx",
      "client/src/components/Share/GuestView.tsx",
    ];
    for (const rel of RIPARATE) {
      const testo = readFileSync(join(RADICE, rel), "utf8");
      expect(`${rel}: ${/MODAL_(LAYER|OVERLAY)/.test(testo)}`).toBe(`${rel}: true`);
    }
  });
});
