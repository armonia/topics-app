/**
 * live-terminals — TUTTI i terminali vivi sul Mac, non solo quelli di Topics.
 *
 * PERCHÉ ESISTE. Topics sa leggere e scrivere le sue PTY (`/api/terminal/
 * sessions/:id/screen|send`, gli strumenti MCP `session_*`), ma un `claude`
 * aperto a mano in Terminal.app o dentro tmux per Topics non esisteva: non lo
 * vedeva la UI, non lo raggiungeva un agente, non lo pilotava il telefono. Il
 * 15/10 erano quattro sessioni in Terminal.app e due in tmux, contro zero
 * visibili.
 *
 * TRE SORGENTI, una forma sola (`LiveTerminal`):
 *  - `topics`   — le PTY di Topics (le fornisce chi chiama, il server le ha già);
 *  - `tmux`     — ogni pane del server tmux (`list-panes -a`): si legge con
 *                 `capture-pane`, si scrive con `send-keys`;
 *  - `terminal` — ogni tab di Terminal.app, via AppleScript: `contents` per lo
 *                 schermo, `do script … in tab` per scrivere.
 *
 * Warp, iTerm e gli altri restano fuori di proposito: Warp non ha un'interfaccia
 * per leggere o scrivere una tab, gli altri su questo Mac non girano.
 *
 * L'IDENTITÀ è stabile fra una lettura e l'altra: il pane id di tmux (`%8`) e il
 * tty della tab di Terminal (`ttys004`). L'indice di una tab cambia quando se ne
 * chiude un'altra; il tty no.
 *
 * TUTTO È ASINCRONO e ha un timeout: il server ha un solo loop, e un osascript
 * appeso non deve fermare le chat. Una sorgente che fallisce sparisce dalla
 * lista, non si porta via le altre.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";

export type LiveTerminalSource = "topics" | "tmux" | "terminal";

export interface LiveTerminal {
  /** `topics:<id>`, `tmux:%8`, `terminal:ttys004`. */
  id: string;
  source: LiveTerminalSource;
  /** Il nome da mostrare: titolo della sessione Topics, `sessione:finestra.pane` di tmux, titolo della tab. */
  title: string;
  /** Il programma in primo piano (`claude`, `zsh`, `node`…), se si sa. */
  command: string | null;
  cwd: string | null;
  /** `/dev/ttys004`, quando c'è. */
  tty: string | null;
  /** Solo Topics sa se un agente sta lavorando; per gli altri `null` = non si sa. */
  busy: boolean | null;
  /** Per `topics`: l'id della sessione PTY, che il client usa per portare in primo piano la sua tab. */
  sessionId?: string;
}

export interface LiveScreen {
  id: string;
  text: string;
}

/** Chi esegue i comandi esterni: sostituibile nei test. */
export type Runner = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>;

export const defaultRunner: Runner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts?.timeoutMs ?? 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });

// ── tmux ─────────────────────────────────────────────────────────────────────

const TMUX_FORMAT = [
  "#{pane_id}", "#{session_name}", "#{window_index}", "#{pane_index}",
  "#{pane_tty}", "#{pane_current_command}", "#{pane_current_path}", "#{window_name}",
].join("\t");

/** Una riga per pane di `tmux list-panes -a -F TMUX_FORMAT`. Le righe storte si saltano. */
export function parseTmuxPanes(stdout: string): LiveTerminal[] {
  const out: LiveTerminal[] = [];
  for (const line of stdout.split("\n")) {
    const f = line.split("\t");
    if (f.length < 8 || !/^%\d+$/.test(f[0])) continue;
    const [paneId, session, win, pane, tty, cmd, cwd] = f;
    out.push({
      id: `tmux:${paneId}`,
      source: "tmux",
      title: `${session}:${win}.${pane}`,
      command: cmd || null,
      cwd: cwd || null,
      tty: tty || null,
      busy: null,
    });
  }
  return out;
}

/**
 * Gli argomenti di tmux che puntano al server giusto. `TOPICS_TMUX_SOCKET`
 * esiste per il server di test, che non deve vedere né toccare le sessioni vere
 * dell'utente: è lo stesso confine dell'HOME isolata.
 */
function tmuxBase(): string[] {
  const sock = process.env.TOPICS_TMUX_SOCKET;
  return sock ? ["-S", sock] : [];
}

// ── Terminal.app ─────────────────────────────────────────────────────────────

// `is running` PRIMA di ogni `tell`: un `tell application "Terminal"` a
// Terminal chiuso lo APRE, e una lista che accende finestre sul Mac sarebbe
// peggio di nessuna lista.
const TERMINAL_LIST_SCRIPT = `
if application "Terminal" is not running then return ""
set out to ""
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      set out to out & (tty of t) & (character id 9) & (custom title of t) & linefeed
    end repeat
  end repeat
end tell
return out`;

const TERMINAL_READ_SCRIPT = `
on run argv
  if application "Terminal" is not running then return "__missing__"
  tell application "Terminal"
    repeat with w in windows
      repeat with i from 1 to (count tabs of w)
        if tty of tab i of w is (item 1 of argv) then return contents of tab i of w
      end repeat
    end repeat
  end tell
  return "__missing__"
end run`;

// Le tab si indicizzano (`tab i of w`) e non si iterano (`repeat with t in tabs`):
// con la variabile di ciclo, `contents of t` è il CONTENUTO DEL RIFERIMENTO
// (cioè «tab 1 of window id …»), non il testo della tab.
// `do script` in una tab esistente scrive il testo nel suo input e preme Invio.
// Non esiste la variante senza Invio: per questo la scrittura su Terminal
// accetta solo testo da inviare, e i tasti di controllo restano a tmux e Topics.
const TERMINAL_SEND_SCRIPT = `
on run argv
  if application "Terminal" is not running then return "missing"
  tell application "Terminal"
    repeat with w in windows
      repeat with i from 1 to (count tabs of w)
        if tty of tab i of w is (item 1 of argv) then
          do script (item 2 of argv) in tab i of w
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

/** `tty<TAB>titolo` per riga, l'output di TERMINAL_LIST_SCRIPT. */
export function parseTerminalTabs(stdout: string): Array<{ tty: string; title: string }> {
  const out: Array<{ tty: string; title: string }> = [];
  for (const line of stdout.split("\n")) {
    const [tty, title = ""] = line.split("\t");
    if (!tty || !tty.startsWith("/dev/")) continue;
    out.push({ tty: tty.trim(), title: title.trim() });
  }
  return out;
}

// ── Processo in primo piano per tty ──────────────────────────────────────────

export interface ForegroundProc { pid: number; command: string }

/**
 * Il processo in primo piano di ogni tty, da UNA chiamata a `ps`.
 *
 * Il primo piano è il process group che il terminale dichiara (`tpgid`), e il
 * suo capo è il processo con `pid == tpgid`: è `claude` anche quando sotto ha
 * dieci `node` figli nello stesso gruppo. Prendere «un processo con il `+`»
 * restituiva a caso uno dei figli.
 */
export function parseForeground(psOut: string): Map<string, ForegroundProc> {
  const byTty = new Map<string, ForegroundProc>();
  for (const line of psOut.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(-?\d+)\s+(.+)$/);
    if (!m) continue;
    const [, pid, tt, tpgid, comm] = m;
    if (tt === "??" || pid !== tpgid) continue;
    byTty.set(`/dev/tty${tt}`, { pid: Number(pid), command: basename(comm.trim()).replace(/^-/, "") });
  }
  return byTty;
}

/** `lsof -Fpn` → pid → cwd. */
export function parseLsofCwd(out: string): Map<number, string> {
  const res = new Map<number, string>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) res.set(pid, line.slice(1));
  }
  return res;
}

// ── Il servizio ──────────────────────────────────────────────────────────────

export interface LiveTerminalsDeps {
  /** Le PTY di Topics, già nella forma giusta. */
  topics: () => LiveTerminal[];
  /** Schermo e scrittura delle PTY di Topics: li possiede la route dei terminali. */
  topicsScreen: (sessionId: string) => Promise<string | null>;
  topicsSend: (sessionId: string, data: string) => boolean;
  run?: Runner;
  /** Cache della lista. Corta: è una lista di cose vive, letta solo da chi la guarda. */
  ttlMs?: number;
  now?: () => number;
  /** Sorgenti esterne accese. Il server di test spegne Terminal.app: le tab vere non sono sue. */
  sources?: { tmux?: boolean; terminal?: boolean };
  log?: (msg: string, err?: unknown) => void;
}

export interface LiveTerminalsService {
  list(opts?: { force?: boolean }): Promise<LiveTerminal[]>;
  screen(id: string): Promise<LiveScreen | null>;
  /** `enter` = premi Invio dopo il testo. Restituisce false se il terminale non c'è più. */
  send(id: string, text: string, opts?: { enter?: boolean }): Promise<boolean>;
}

export function createLiveTerminals(deps: LiveTerminalsDeps): LiveTerminalsService {
  const run = deps.run ?? defaultRunner;
  const ttlMs = deps.ttlMs ?? 2000;
  const now = deps.now ?? Date.now;
  const tmuxOn = deps.sources?.tmux ?? true;
  const terminalOn = deps.sources?.terminal ?? process.platform === "darwin";
  const log = deps.log ?? ((m: string, e?: unknown) => console.warn("[live-terminals] " + m, e ?? ""));

  let cache: LiveTerminal[] = [];
  let cachedAt = 0;
  let inflight: Promise<LiveTerminal[]> | null = null;

  async function scanTmux(): Promise<LiveTerminal[]> {
    if (!tmuxOn) return [];
    try {
      return parseTmuxPanes(await run("tmux", [...tmuxBase(), "list-panes", "-a", "-F", TMUX_FORMAT]));
    } catch {
      // Nessun server tmux acceso è il caso normale, non un errore da loggare.
      return [];
    }
  }

  async function scanTerminal(): Promise<LiveTerminal[]> {
    if (!terminalOn) return [];
    let tabs: Array<{ tty: string; title: string }>;
    try {
      tabs = parseTerminalTabs(await run("osascript", ["-e", TERMINAL_LIST_SCRIPT]));
    } catch (err) {
      log("Terminal.app non risponde (permesso di Automazione negato?)", err);
      return [];
    }
    return tabs.map((t) => ({
      id: `terminal:${basename(t.tty)}`,
      source: "terminal" as const,
      title: t.title,
      command: null,
      cwd: null,
      tty: t.tty,
      busy: null,
    }));
  }

  /** Programma in primo piano e cartella, per le sorgenti che non li danno da sé. */
  async function enrich(rows: LiveTerminal[]): Promise<void> {
    const ttys = rows.filter((r) => r.tty);
    if (!ttys.length) return;
    let fg: Map<string, ForegroundProc>;
    try {
      fg = parseForeground(await run("ps", ["-A", "-o", "pid=,tt=,tpgid=,comm="]));
    } catch { return; }
    const pids: number[] = [];
    for (const r of ttys) {
      const p = fg.get(r.tty!);
      if (!p) continue;
      // tmux dà già il comando, ma come titolo del processo: claude si chiama
      // «2.1.296». `ps -o comm` dice il nome vero.
      r.command = p.command;
      if (!r.cwd) pids.push(p.pid);
    }
    if (!pids.length) return;
    try {
      const cwds = parseLsofCwd(await run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]));
      for (const r of ttys) {
        const p = fg.get(r.tty!);
        if (p && !r.cwd) r.cwd = cwds.get(p.pid) ?? null;
      }
    } catch { /* senza cartella la riga resta utile */ }
  }

  async function scan(): Promise<LiveTerminal[]> {
    const [tmux, terminal] = await Promise.all([scanTmux(), scanTerminal()]);
    const external = [...tmux, ...terminal];
    // Una PTY di Topics ha anche lei un tty: se dentro gira tmux, il pane tmux
    // e la sessione Topics sono due porte sulla stessa cosa, ed è giusto che
    // compaiano entrambe. Le tab di Terminal invece non possono essere Topics.
    await enrich(external);
    let topics: LiveTerminal[] = [];
    try { topics = deps.topics(); } catch (err) { log("roster Topics illeggibile", err); }
    return [...topics, ...external];
  }

  async function list(opts?: { force?: boolean }): Promise<LiveTerminal[]> {
    const t = now();
    if (!opts?.force && cachedAt !== 0 && t - cachedAt < ttlMs) return cache;
    // Due letture insieme (due client aperti sulla tendina) condividono la stessa scansione.
    if (!inflight) {
      inflight = scan()
        .then((rows) => { cache = rows; cachedAt = now(); return rows; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  function parseId(id: string): { source: LiveTerminalSource; key: string } | null {
    const m = id.match(/^(topics|tmux|terminal):(.+)$/);
    if (!m) return null;
    const key = m[2];
    // La chiave finisce negli argomenti di tmux e di osascript: si accetta solo
    // la forma che quella sorgente produce, così un id non diventa un'opzione.
    if (m[1] === "tmux" && !/^%\d+$/.test(key)) return null;
    if (m[1] === "terminal" && !/^ttys\d+$/.test(key)) return null;
    return { source: m[1] as LiveTerminalSource, key };
  }

  async function screen(id: string): Promise<LiveScreen | null> {
    const p = parseId(id);
    if (!p) return null;
    try {
      if (p.source === "topics") {
        const text = await deps.topicsScreen(p.key);
        return text == null ? null : { id, text };
      }
      if (p.source === "tmux") {
        // `-J` riunisce le righe spezzate dal margine: un percorso lungo resta una riga.
        const text = await run("tmux", [...tmuxBase(), "capture-pane", "-p", "-J", "-t", p.key]);
        return { id, text: trimTrailingBlank(text) };
      }
      const text = await run("osascript", ["-e", TERMINAL_READ_SCRIPT, `/dev/${p.key}`]);
      if (text.startsWith("__missing__")) return null;
      return { id, text: trimTrailingBlank(text) };
    } catch {
      return null;
    }
  }

  async function send(id: string, text: string, opts?: { enter?: boolean }): Promise<boolean> {
    const p = parseId(id);
    if (!p) return false;
    const enter = opts?.enter ?? true;
    try {
      if (p.source === "topics") return deps.topicsSend(p.key, enter ? text + "\r" : text);
      if (p.source === "tmux") {
        const base = [...tmuxBase(), "send-keys", "-t", p.key];
        // `-l`: il testo arriva LETTERALE. Senza, «Enter» o «C-c» scritti in un
        // messaggio diventerebbero tasti. L'Invio va in una chiamata a parte
        // per la stessa ragione.
        if (text) await run("tmux", [...base, "-l", "--", text]);
        if (enter) await run("tmux", [...base, "Enter"]);
        return true;
      }
      if (!enter) return false;
      const res = await run("osascript", ["-e", TERMINAL_SEND_SCRIPT, `/dev/${p.key}`, text]);
      return res.trim() === "ok";
    } catch {
      // Pane chiuso nel frattempo, tab sparita: per chi scrive è «non c'è più».
      return false;
    } finally {
      // Lo schermo è cambiato: la prossima lista non deve servire la vecchia.
      cachedAt = 0;
    }
  }

  return { list, screen, send };
}

function trimTrailingBlank(text: string): string {
  // AppleScript restituisce le righe con il CR del Mac classico.
  return text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}
