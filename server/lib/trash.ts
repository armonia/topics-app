/**
 * Cancellare vuol dire spostare nel cestino, non `rm -rf`.
 *
 * Due punti del server cancellavano davvero: `/api/files/delete` (`unlinkSync`,
 * e `rm -rf` per le cartelle) e lo scarto di un file NON TRACCIATO in
 * `/api/git/discard`. Il secondo è il più cattivo dei due: sta accanto allo
 * scarto di un file tracciato, che è recuperabile da git, dietro lo stesso
 * bottone e senza niente che distingua i due casi. Un click sbagliato sulla
 * riga sbagliata e un file mai committato non esiste più — nessun undo, nessun
 * `git checkout` che lo riporti indietro, perché git non l'ha mai visto.
 *
 * ── Non si ricade su `rm` ───────────────────────────────────────────────────
 * Se il cestino non è raggiungibile la chiamata FALLISCE e lo dice. Una
 * ricaduta silenziosa su `rm` sarebbe peggio di non avere il cestino: l'utente
 * legge «spostato nel cestino», va a cercarlo lì, e non c'è.
 *
 * ── Prima il cestino di sistema, poi a mano ─────────────────────────────────
 * `/usr/bin/trash` (macOS 14+) e `gio trash` (Linux) sanno cose che noi non
 * sappiamo: i volumi esterni hanno il loro `.Trashes/<uid>`, e il ripristino
 * («Rimetti a posto») funziona solo se il cestino sa da dove veniva il file.
 * Si usa quello quando c'è. A mano è la rete di sicurezza, non la prima scelta.
 *
 * Il path del binario è ASSOLUTO: sotto launchd il PATH è minimo e un `trash`
 * secco non si trova (stessa lezione delle altre CLI esterne).
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, resolve } from "path";

export interface TrashResult {
  ok: boolean;
  /** Come ci è riuscito, per i log: il cestino di sistema o lo spostamento a mano. */
  via?: "system" | "manual";
  /** Dove è finito, quando lo sappiamo. */
  target?: string;
  error?: string;
}

/** I candidati, in ordine di preferenza. Path assoluti: vedi sopra. */
const SYSTEM_TRASH: { bin: string; args: (p: string) => string[] }[] = [
  { bin: "/usr/bin/trash", args: p => [p] },
  { bin: "/usr/bin/gio", args: p => ["trash", p] },
  { bin: "/usr/local/bin/trash", args: p => [p] },
  { bin: "/opt/homebrew/bin/trash", args: p => [p] },
];

/**
 * La cartella cestino dell'utente, se questo sistema ne ha una.
 *
 * Esportata e senza effetti perché è la parte che vale la pena provare: dipende
 * da `platform` e dall'ambiente, che in un test non si possono cambiare.
 */
export function homeTrashDir(platform: string, env: Record<string, string | undefined>): string | null {
  const home = env.HOME;
  if (!home) return null;
  if (platform === "darwin") return join(home, ".Trash");
  // Specifica XDG: i file stanno in `files/`, e accanto in `info/` c'è un
  // `.trashinfo` per voce senza il quale il cestino dei desktop Linux non sa
  // rimettere a posto niente.
  const base = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(base, "Trash");
}

/**
 * Un nome libero dentro la cartella cestino.
 *
 * Nel cestino finiscono file che vengono da cartelle diverse, quindi due
 * `index.ts` si incontrano di continuo. Senza questo, il secondo sovrascrive il
 * primo e il cestino diventa un altro modo di perdere roba.
 */
export function uniqueTrashName(dir: string, name: string, exists: (p: string) => boolean): string {
  if (!exists(join(dir, name))) return name;
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 1000; i++) {
    const tentativo = `${stem} ${i}${ext}`;
    if (!exists(join(dir, tentativo))) return tentativo;
  }
  return `${stem} ${process.pid}-${performance.now().toString(36)}${ext}`;
}

async function trySystemTrash(absPath: string): Promise<TrashResult | null> {
  for (const { bin, args } of SYSTEM_TRASH) {
    if (!existsSync(bin)) continue;
    try {
      const proc = Bun.spawn([bin, ...args(absPath)], { stdout: "pipe", stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      if (proc.exitCode === 0) return { ok: true, via: "system" };
      // Il binario c'è ma si è rifiutato: lo si dice invece di provare il
      // prossimo, che fallirebbe per la stessa ragione (permessi, file in uso).
      return { ok: false, error: stderr.trim() || `${basename(bin)} è uscito con ${proc.exitCode}` };
    } catch {
      // Non eseguibile: si prova il candidato dopo.
    }
  }
  return null;
}

/**
 * Lo spostamento a mano, con la radice del cestino passata da fuori.
 *
 * Sta a parte perché è l'unico pezzo verificabile: su macOS leggere `~/.Trash`
 * richiede Full Disk Access, quindi un test che chiede «il file è finito
 * davvero nel cestino?» sbatte contro EPERM e non può distinguere uno
 * spostamento da un `rm`. Con la radice iniettabile la domanda si può fare per
 * intero, contenuto compreso.
 *
 * `xdg` distingue le due forme: su macOS il cestino è una cartella piatta, su
 * Linux i file stanno in `files/` e i metadati in `info/`.
 */
export function moveToTrashDir(absPath: string, trashRoot: string, xdg: boolean): TrashResult {
  const target = resolve(absPath);
  const filesDir = xdg ? join(trashRoot, "files") : trashRoot;
  try {
    mkdirSync(filesDir, { recursive: true });
    const nome = uniqueTrashName(filesDir, basename(target), existsSync);
    const dest = join(filesDir, nome);
    renameSync(target, dest);
    if (xdg) {
      // Senza il .trashinfo il file è nel cestino ma «Rimetti a posto» non sa
      // dove rimetterlo, e alcuni gestori lo nascondono del tutto.
      try {
        const infoDir = join(trashRoot, "info");
        mkdirSync(infoDir, { recursive: true });
        const quando = new Date().toISOString().replace(/\.\d+Z$/, "");
        writeFileSync(join(infoDir, `${nome}.trashinfo`), `[Trash Info]\nPath=${target}\nDeletionDate=${quando}\n`);
      } catch { /* il file è comunque al sicuro */ }
    }
    return { ok: true, via: "manual", target: dest };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fra dischi diversi `rename` non può funzionare, e copiare-e-cancellare
    // qui vorrebbe dire cancellare per davvero se la copia va male a metà.
    // Meglio dirlo: il file resta dov'è.
    const extra = msg.includes("EXDEV") ? " (il file è su un altro disco: svuotalo dal Finder)" : "";
    return { ok: false, error: `Non sono riuscito a spostarlo nel cestino: ${msg}${extra}`, target: dirname(target) };
  }
}

/**
 * Sposta un path nel cestino. Non cancella mai.
 *
 * `absPath` deve essere già risolto e già dentro il confine del progetto: qui
 * non c'è nessun controllo di contenimento, e non deve essercene uno finto che
 * dia l'impressione che ci sia.
 */
export async function moveToTrash(absPath: string): Promise<TrashResult> {
  const target = resolve(absPath);
  if (!existsSync(target)) return { ok: false, error: "Il file non esiste" };

  const sistema = await trySystemTrash(target);
  if (sistema) return sistema;

  const trashRoot = homeTrashDir(process.platform, process.env);
  if (!trashRoot) return { ok: false, error: "Nessun cestino disponibile su questo sistema" };

  return moveToTrashDir(target, trashRoot, process.platform !== "darwin");
}
