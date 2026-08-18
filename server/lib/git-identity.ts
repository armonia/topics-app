/**
 * Chi è git quando a committare è il SERVER.
 *
 * Il land non legge soltanto: CREA commit. Il merge di riallineamento che
 * riporta main dentro il ramo, il merge finale su main, i cherry-pick di
 * `landOn` — e git si rifiuta di partire quando non sa chi firma. Si rifiuta
 * PRIMA di toccare l'albero, con `exit 128` e zero file in conflitto:
 *
 *     fatal: empty ident name (for <runner@runnervmzvulz…>) not allowed
 *
 * Su una postazione l'identità arriva da `~/.gitconfig` e non se ne accorge
 * nessuno. Dove non c'è — un runner di CI, un container, un servizio con
 * l'ambiente ripulito, un utente il cui campo GECOS è vuoto — «Landa su main»
 * moriva lì, e la card raccontava un'altra storia: «riportare main dentro il
 * ramo non è nemmeno partito (nessun file in conflitto)», che è la frase
 * riservata al caso in cui git ha davvero rifiutato la fusione. Misurato il
 * 15/08/2026 sul runner (`board-land-conflict.spec.ts`): un conflitto vero
 * veniva rubricato come «niente da atterrare» e la card restava in review.
 *
 * La regola qui è una sola: **ripiego, mai sostituzione**. Si chiede a git se
 * sa firmare (`git var GIT_COMMITTER_IDENT`, che applica la stessa regola
 * stretta del commit) e solo se la risposta è no si mette un'identità di
 * servizio. Dove l'identità c'è, il merge su main resta firmato da chi ha
 * premuto il tasto: un'app che si intesta i merge dell'umano è un guasto
 * peggiore di quello che sta rimediando.
 *
 * Il ripiego passa dalle VARIABILI D'AMBIENTE e non da `-c user.name=…`:
 * `GIT_COMMITTER_NAME` vuota nell'ambiente batte la riga di comando, quindi
 * `-c` non basterebbe a coprire tutti i modi in cui l'identità può mancare.
 * L'ambiente li copre tutti perché ha la precedenza su tutto.
 */

/** L'identità che il server usa SOLO quando la macchina non ne ha una. */
export const FALLBACK_GIT_IDENTITY = {
  name: "Topics App",
  email: "topics@localhost",
} as const;

/** Le quattro variabili che git legge prima di ogni altra cosa. */
const FALLBACK_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: FALLBACK_GIT_IDENTITY.name,
  GIT_AUTHOR_EMAIL: FALLBACK_GIT_IDENTITY.email,
  GIT_COMMITTER_NAME: FALLBACK_GIT_IDENTITY.name,
  GIT_COMMITTER_EMAIL: FALLBACK_GIT_IDENTITY.email,
};

/**
 * La risposta per cartella, memorizzata per la vita del processo: l'identità è
 * una proprietà della macchina (più, al più, del repo), non della richiesta, e
 * senza cache si pagherebbe un sottoprocesso in più per OGNI comando git di un
 * land che ne lancia decine. Chi configura `user.name` a server acceso lo vede
 * al primo reload — che su questa app è la norma, non un evento.
 */
const cache = new Map<string, Promise<boolean>>();

/** Solo per i test: dimentica ciò che si è misurato. */
export function resetGitIdentityCache(): void {
  cache.clear();
}

async function probe(cwd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "var", "GIT_COMMITTER_IDENT"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      // `env` esplicito e non ereditato: `Bun.spawn` senza `env` passa al figlio
      // l'ambiente FOTOGRAFATO all'avvio del processo, non `process.env` di
      // adesso. La domanda e la risposta devono guardare lo stesso ambiente.
      env: process.env,
    });
    // Gli stream si drenano comunque: un pipe non letto può bloccare il figlio.
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return (await proc.exited) === 0;
  } catch {
    // git non è partito affatto: non è una domanda sull'identità, e mettere un
    // ripiego non aiuterebbe. Si lascia l'ambiente com'è.
    return true;
  }
}

/**
 * L'ambiente con cui lanciare git in `cwd`.
 *
 * Torna `process.env` tale e quale quando la macchina sa già firmare — che è il
 * caso normale — e una copia con l'identità di ripiego quando non lo sa.
 */
export async function gitEnvFor(cwd: string): Promise<Record<string, string | undefined>> {
  let known = cache.get(cwd);
  if (!known) {
    known = probe(cwd);
    cache.set(cwd, known);
  }
  return (await known) ? process.env : { ...process.env, ...FALLBACK_ENV };
}
