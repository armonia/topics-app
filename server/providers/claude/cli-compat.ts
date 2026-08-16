/**
 * La CLI installata sa parlare come noi le parliamo?
 *
 * ── Il buco che chiude ──────────────────────────────────────────────────────
 * `probeBinaryPath` legge già la versione del binario (`--version`), ma quel
 * numero finiva SOLO dentro `diagnose()`, come stringa da mostrare: nessuna
 * decisione lo consultava. Quindi una CLI troppo vecchia — o una release che ha
 * tolto una delle flag da cui dipende tutto — si scopriva a turno morto, con un
 * errore di argomento sconosciuto che nessuno collegava all'aggiornamento fatto
 * la settimana prima.
 *
 * ── Perché NON blocca lo spawn ──────────────────────────────────────────────
 * Un falso negativo che spegne Claude Code è peggio del sintomo che evita: la
 * versione si legge da una stringa libera, la CLI può cambiarne il formato, e
 * un canale di build interno può avere un numero che non somiglia a niente. Il
 * verdetto quindi è una DIAGNOSI, non un cancello: si registra il motivo, lo si
 * mostra, e si prova lo stesso. Se la CLI ci sta davvero dietro, funziona; se
 * no, muore con il motivo già scritto accanto.
 *
 * ── Cosa c'è dentro la tabella ──────────────────────────────────────────────
 * Solo le flag da cui dipende qualcosa di grosso e che sono già state viste
 * muoversi. `--permission-prompt-tool` è il caso che ha insegnato la lezione:
 * non è più in `--help` dalla 2.1.224 ed è comunque accettata e funzionante
 * (verificato sul filo, vedi `lib/autonomy-mode.ts`) — cioè sparire dall'aiuto
 * NON è sparire davvero, e per questo la tabella parla di `removedIn`, che è
 * l'unica cosa che conta, e la lascia vuota finché non lo si è verificato.
 */

/**
 * La più vecchia con cui Topics è stato visto funzionare. Sotto questa non
 * promettiamo niente — ma continuiamo a provarci (vedi sopra).
 */
export const MIN_SUPPORTED_CLI = "2.1.220";

/** Una flag critica e la finestra di versioni in cui esiste. */
interface FlagWindow {
  flag: string;
  /** Prima versione che la accetta. Assente = c'è da sempre. */
  introducedIn?: string;
  /**
   * Prima versione che NON la accetta più. Assente = ancora viva.
   * Sparire da `--help` non conta: conta smettere di funzionare.
   */
  removedIn?: string;
  /** Cosa si spegne senza. Finisce nel motivo, perché è l'unica parte utile. */
  breaks: string;
}

/**
 * LA VERSIONE IN CUI `--bare` DIVENTA IL DEFAULT DI `-p`, quando si sapra'.
 *
 * Il rischio, verbatim dai docs di Anthropic e dall'aiuto della CLI 2.1.233:
 *   «--bare is the recommended mode for scripted and SDK calls, and will
 *    become the default for -p in a future release.»
 *   «--bare ... Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper
 *    (OAuth and keychain are never read).»
 * Topics esegue la chat strutturata con `claude --print` (`args.ts:299` e
 * `:392`): il giorno in cui quel default cambia, quel ramo smette di leggere
 * l'abbonamento e pretende una API key. Misurato sul database dal 1 al 15
 * agosto, quei turni a listino valgono fra 1.150 e 14.000 $ al mese contro i
 * 200 di Max 20x.
 *
 * PERCHE' UN NUMERO VUOTO E NON UNA DIFESA. Oggi `--bare` e' opt-in: senza `-p`
 * risponde «Input must be provided ... when using --print», cioe' implica
 * `--print` invece di sostituirlo, e non esiste una data. Costruire adesso una
 * difesa contro un cambio che non ha una forma nota vorrebbe dire indovinare —
 * e le porte gia' provate sono chiuse: `apiKeyHelper` con un token di
 * sottoscrizione dentro bare torna `401 API key is invalid`, `CLAUDE_CODE_SIMPLE=0`
 * non lo spegne, `--no-bare` non esiste nel binario.
 *
 * Quello che si puo' fare oggi e' non farsi trovare impreparati: quando si
 * scoprira' la versione, si scrive qui, e da quel momento ogni CLI che la
 * raggiunge lo DICE nel diagnose invece di far morire i turni con un 401 che
 * nessuno collega all'aggiornamento. E' la stessa forma di `removedIn`, che in
 * questo file esiste proprio perche' «sparire da --help non e' sparire
 * davvero»: si lascia vuoto finche' non lo si e' verificato.
 */
export const BARE_DEFAULT_IN: string | null = null;

export const CRITICAL_CLAUDE_FLAGS: readonly FlagWindow[] = [
  {
    flag: "--permission-prompt-tool",
    introducedIn: "2.0.0",
    breaks: "ogni tool MCP e ogni scrittura fuori dalla cwd, in silenzio",
  },
  {
    flag: "--include-partial-messages",
    introducedIn: "2.0.0",
    breaks: "i tool restano invisibili finché il modello non ha finito di scriverne l'input",
  },
  {
    flag: "--setting-sources",
    introducedIn: "2.0.0",
    breaks: "le impostazioni utente/progetto non entrano nella sessione",
  },
];

export interface ClaudeCliCompat {
  /** La versione letta dal binario, normalizzata. Null se illeggibile. */
  version: string | null;
  /** Il binario è più vecchio del minimo dichiarato. */
  belowMinimum: boolean;
  /** Flag che questa versione non dovrebbe accettare. */
  missingFlags: string[];
  /**
   * Una riga da mostrare, o null quando non c'è niente da dire. È ciò che
   * finisce nel `lastError` del diagnose: un provider che funziona ma con un
   * avvertimento addosso.
   */
  reason: string | null;
}

/**
 * Il verdetto. `version` arriva da `probeBinaryPath`, quindi può essere
 * qualunque cosa: una stringa non riconoscibile NON è un guasto, è
 * semplicemente un'assenza di informazione, e si tace.
 */
export function checkClaudeCliCompat(version: string | null | undefined): ClaudeCliCompat {
  const parsed = parseSemver(version);
  if (!parsed) {
    return { version: null, belowMinimum: false, missingFlags: [], reason: null };
  }
  const normalized = parsed.join(".");
  const belowMinimum = compareSemver(parsed, parseSemver(MIN_SUPPORTED_CLI)!) < 0;

  const missingFlags: string[] = [];
  const notes: string[] = [];
  for (const f of CRITICAL_CLAUDE_FLAGS) {
    const introduced = parseSemver(f.introducedIn);
    const removed = parseSemver(f.removedIn);
    if (introduced && compareSemver(parsed, introduced) < 0) {
      missingFlags.push(f.flag);
      notes.push(`${f.flag} arriva dalla ${f.introducedIn}. Senza: ${f.breaks}`);
      continue;
    }
    if (removed && compareSemver(parsed, removed) >= 0) {
      missingFlags.push(f.flag);
      notes.push(`${f.flag} è stata tolta nella ${f.removedIn}. Senza: ${f.breaks}`);
    }
  }

  // La sentinella su `--bare`: muta finche' nessuno ha scritto la versione.
  const bare = parseSemver(BARE_DEFAULT_IN);
  if (bare && compareSemver(parsed, bare) >= 0) {
    notes.push(
      `dalla ${BARE_DEFAULT_IN} \`--print\` implica \`--bare\`, che legge SOLO ANTHROPIC_API_KEY ` +
      `o apiKeyHelper: l'abbonamento non viene piu' letto e i turni della chat si pagano a listino`,
    );
  }

  if (belowMinimum && notes.length === 0) {
    notes.push(`CLI ${normalized} è sotto il minimo verificato (${MIN_SUPPORTED_CLI}): provo lo stesso`);
  } else if (belowMinimum) {
    notes.unshift(`CLI ${normalized} è sotto il minimo verificato (${MIN_SUPPORTED_CLI})`);
  }

  return {
    version: normalized,
    belowMinimum,
    missingFlags,
    reason: notes.length ? notes.join("; ") : null,
  };
}

/** `v2.1.224 (Claude Code)` → `[2, 1, 224]`. Null se non c'è un semver dentro. */
function parseSemver(raw: string | null | undefined): [number, number, number] | null {
  if (!raw) return null;
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}
