/**
 * LE VOCI MISURATE dell'inventario: MB veri, da processi veri.
 *
 * PERCHE' SEPARATO DA `featureWeightSources`. Quelle voci sono CONTEGGI e vivono
 * in un registro: si dichiarano da sole, senza chiedere niente a nessuno. Queste
 * sono MB, arrivano da fuori (il campionamento della flotta e delle webview) e
 * dipendono da un dato che puo' mancare — sul telefono non c'e' shell, e senza
 * server non c'e' flotta. Tenerle nello stesso registro avrebbe voluto dire
 * inventare un modo per «registrare» un dato che arriva a strappi.
 *
 * NESSUNA LETTURA IN PIU'. Tutto cio' che serve qui e' gia' stato campionato
 * per la status bar e per i tooltip delle tab: questa funzione e' pura e
 * TRASFORMA, non misura. E' la regola di RES-ATTR-04 — il costo della misura non
 * cresce col numero di cose misurate — applicata a una superficie nuova.
 */

import type { VocePeso } from './featureWeight';

/** Le sessioni terminale come le riporta la flotta. */
export interface MeasuredSession {
  sessionId: string;
  name: string;
  memoryMB: number;
  processCount: number;
  /** Normalised over the machine's cores. `null` = no delta yet, which is not
   *  "idle". */
  cpuPercent?: number | null;
  /** Absolute path of the project this session belongs to, when the server
   *  could resolve one. */
  projectPath?: string;
  /** How strong that attribution is. `topic` = a topic DECLARES this project.
   *  `cwd` = nothing declared one and the working directory stands in, which is
   *  right for a terminal inside a repo and wrong for a shell in $HOME. */
  projectSource?: 'topic' | 'cwd';
}

/** Una radice del lato server (pty-bridge, ai-bridge, il server stesso). */
export interface MeasuredRoot {
  kind: string;
  memoryMB: number;
  processCount: number;
}

export interface IngressiMisurati {
  /** Le sessioni PTY (terminali e CLI degli agenti), dal server. */
  sessioni: readonly MeasuredSession[];
  /** Le pane browser, dalla shell: una webview = un processo WebContent. */
  browser: readonly { label: string; memoryMB: number }[];
  /** Le radici del lato server. */
  radici: readonly MeasuredRoot[];
  /** Il lavoro lanciato dagli agenti (npm install, build, test). */
  scriptsMB: number;
  scriptsProcessCount: number;
  /**
   * The paths this installation knows as PROJECTS, for deciding whether a
   * working directory may stand in for one.
   *
   * It exists because of a measurement: on the live machine four shells sitting
   * in `/Users/zorahrel` hold 1.3 GB between them, and grouping by working
   * directory alone invents a project called «zorahrel» that holds more memory
   * than any real one. A folder is not a project because something is running
   * in it. Absent or empty, only the sessions whose TOPIC names a project are
   * grouped, and the rest stay together in one row.
   */
  knownProjects?: ReadonlySet<string>;
}

/**
 * Quanto un gruppo deve pesare per meritarsi una riga.
 *
 * Sotto un megabyte la voce direbbe «0 MB», che e' rumore con l'aria di un dato.
 * Non e' una soglia di prodotto tarata a occhio: e' il punto sotto il quale il
 * numero arrotondato smette di dire qualcosa.
 */
const MIN_MB = 1;

/**
 * Le voci misurate, aggregate per funzionalita'.
 *
 * AGGREGA invece di elencare: dodici terminali fanno DODICI righe, e un elenco
 * di dodici righe da 30 MB nasconde la riga da 700. La funzionalita' e' «i tuoi
 * terminali», e il dettaglio di quale sia il piu' pesante sta nel `detail` —
 * dove lo cerca chi vuole agire, non davanti a chi vuole capire.
 */
export function vociMisurate(x: IngressiMisurati): VocePeso[] {
  const out: VocePeso[] = [];

  // ONE ROW PER PROJECT, because that is the question people bring here.
  //
  // These were a single row, «Terminali e sessioni: 749 MB», with the heaviest  allow-italian: the label being quoted is the row's own text
  // one hidden in `detail`. It answered "how much do the terminals cost" and
  // not the question that gets asked, which is WHICH project is costing it -
  // the one you can act on, by closing a window instead of hunting a session.
  // A session with no trustworthy project stays in the old row, under its old
  // id, so nothing that pointed at it has to move.
  if (x.sessioni.length > 0) {
    const byProject = new Map<string, MeasuredSession[]>();
    const withoutProject: MeasuredSession[] = [];
    for (const s of x.sessioni) {
      const path = trustedProjectOf(s, x.knownProjects);
      if (path === null) { withoutProject.push(s); continue; }
      const group = byProject.get(path);
      if (group) group.push(s); else byProject.set(path, [s]);
    }

    for (const [path, group] of byProject) {
      const v = sumSessions(group);
      if (v.mb < MIN_MB) continue;
      out.push({
        id: `fleet.project.${path}`,
        label: folderName(path),
        natura: 'misurato',
        peso: {
          entries: group.length, memoryMB: v.mb, processCount: v.proc,
          detail: { progetto: path, cpu: v.cpu, piuPesante: v.maggiore, mbDelPiuPesante: v.maxMb },
        },
      });
    }

    if (withoutProject.length > 0) {
      const v = sumSessions(withoutProject);
      if (v.mb >= MIN_MB) {
        out.push({
          id: 'fleet.sessions',
          // The label says WHY they are together: not "the others", which reads
          // as a leftover bin, but "no project of their own", which is a fact
          // about them and is what a reader has to know before comparing this
          // number with the rows above.
          label: 'Terminali e sessioni',
          labelKey: byProject.size > 0 ? 'perf.inventory.sessionsNoProject' : undefined,
          natura: 'misurato',
          peso: {
            entries: withoutProject.length, memoryMB: v.mb, processCount: v.proc,
            detail: { cpu: v.cpu, piuPesante: v.maggiore, mbDelPiuPesante: v.maxMb },
          },
        });
      }
    }
  }

  if (x.browser.length > 0) {
    const mb = x.browser.reduce((a, b) => a + b.memoryMB, 0);
    if (mb >= MIN_MB) {
      out.push({
        id: 'shell.browserPanes', label: 'Pannelli browser', natura: 'misurato',
        peso: { entries: x.browser.length, memoryMB: mb, processCount: x.browser.length },
      });
    }
  }

  // Le radici del lato server, ognuna con la sua riga: sono cose diverse
  // (il server, il ponte dei terminali, quello dell'AI) e sommarle direbbe
  // «lato server: 400 MB», che e' il numero che la barra gia' mostra.
  for (const r of x.radici) {
    if (r.memoryMB < MIN_MB) continue;
    out.push({
      id: `fleet.root.${r.kind}`,
      label: labelRoot(r.kind),
      natura: 'misurato',
      peso: { entries: 1, memoryMB: r.memoryMB, processCount: r.processCount },
    });
  }

  // GLI SCRIPT DEGLI AGENTI. Sono il terzo asse della flotta ed e' bene che
  // abbiano una riga propria: un `npm install` da 700 MB in corso e' la
  // spiegazione piu' probabile di un numero che si e' gonfiato all'improvviso,
  // ed e' anche l'unica voce dell'elenco che sparisce da sola.
  if (x.scriptsMB >= MIN_MB) {
    out.push({
      id: 'fleet.scripts', label: 'Comandi lanciati dagli agenti', natura: 'misurato',
      peso: { entries: x.scriptsProcessCount, memoryMB: x.scriptsMB, processCount: x.scriptsProcessCount },
    });
  }

  return out;
}

/** Il nome del ponte come lo riconosce chi usa l'app. Un `kind` sconosciuto
 *  passa cosi' com'e': meglio una riga con un nome tecnico che nessuna riga. */
function labelRoot(kind: string): string {
  switch (kind) {
    case 'server': return 'Server di Topics';
    case 'pty-bridge': return 'Ponte dei terminali';
    case 'ai-bridge': return 'Ponte AI';
    case 'webrtc-bridge': return 'Ponte WebRTC';
    default: return kind;
  }
}

/**
 * Which project a session may be grouped under, or `null` for none.
 *
 * `topic` is taken as it comes: a topic naming a project is a declaration, not
 * a guess. `cwd` is only accepted when the folder is one this installation
 * already knows as a project - see `knownProjects` for the 1.3 GB of shells in
 * $HOME that made the check necessary.
 */
function trustedProjectOf(s: MeasuredSession, noti?: ReadonlySet<string>): string | null {
  if (!s.projectPath) return null;
  if (s.projectSource === 'topic') return s.projectPath;
  return noti?.has(s.projectPath) ? s.projectPath : null;
}

/** The four numbers a group of sessions carries. CPU is summed only over the
 *  sessions that HAVE a reading: a `null` means "not measured yet", and
 *  counting it as zero would state a measurement nobody took. */
function sumSessions(group: readonly MeasuredSession[]): {
  mb: number; proc: number; cpu: number | null; maggiore: string; maxMb: number;
} {
  let mb = 0, proc = 0, cpu = 0, misurate = 0, maxMb = 0, maggiore = '';
  for (const s of group) {
    mb += s.memoryMB;
    proc += s.processCount;
    if (typeof s.cpuPercent === 'number') { cpu += s.cpuPercent; misurate++; }
    if (s.memoryMB > maxMb) { maxMb = s.memoryMB; maggiore = s.name || s.sessionId; }
  }
  return { mb, proc, cpu: misurate > 0 ? Math.round(cpu * 10) / 10 : null, maggiore, maxMb };
}

/** The last segment of a path, which is what a project is called out loud.
 *  Both separators, because a Windows path reaches this the same way. */
function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
