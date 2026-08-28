import { useEffect, useState } from 'react';

/**
 * «Questa è un'installazione di SVILUPPO» — il cancello delle superfici che
 * fuori dallo sviluppo non devono nemmeno esistere (le missioni della board).
 *
 * Il flag non è nuovo: è il file `topics-dev.json` in STATE_DIR, che il server
 * già usa per la consegna a caldo del bundle e pubblica come `server.devReload`
 * (`server/routes/status.ts`). È il cancello giusto perché è STRUTTURALE: in
 * un'installazione standalone quel file non c'è e non può esserci — non è una
 * preferenza che l'utente possa accendere per sbaglio. E non è
 * `import.meta.env.DEV`, che nel desktop è sempre false: lì gira il bundle
 * buildato, quindi gaterebbe la feature via anche sulla macchina di chi
 * sviluppa.
 *
 * Una lettura sola per caricamento dell'app, condivisa da tutti i chiamanti: la
 * dev-ness di un'installazione non cambia mentre la guardi, e `/api/system/status`
 * conta processi con `ps` — non è una cosa da rifare a ogni mount.
 */
let devInstallProbe: Promise<boolean> | null = null;

function probeDevInstall(): Promise<boolean> {
  if (!devInstallProbe) {
    devInstallProbe = fetch('/api/system/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !!d?.server?.devReload)
      // Nel dubbio NO: il verso giusto in cui sbagliare è non mostrare una
      // superficie interna a un'installazione utente.
      .catch(() => false);
  }
  return devInstallProbe;
}

export function useDevInstall(): boolean {
  const [dev, setDev] = useState(false);
  useEffect(() => {
    let alive = true;
    probeDevInstall().then((v) => { if (alive) setDev(v); });
    return () => { alive = false; };
  }, []);
  return dev;
}

/**
 * The same answer, AWAITED instead of watched.
 *
 * `useDevInstall` starts at `false` and flips to `true` when the probe returns.
 * That is right for drawing: the worst case is one frame where an internal
 * surface is not there yet. It is wrong for DECIDING whether to start
 * something, because a caller reading the state on the first pass would read
 * "not a dev install" and start anyway. Whoever has to choose awaits this,
 * which is the same memoized promise: no extra request.
 */
export function whenDevInstallKnown(): Promise<boolean> {
  return probeDevInstall();
}
