/**
 * Cosa si manda al modello per farsi scrivere un messaggio di commit.
 *
 * ── Il filtro «in stage» era rotto ──────────────────────────────────────────
 * Il codice di prima faceva `.trim()` sull'intero output di `git status
 * --porcelain` e poi lo spezzava per riga. Il trim mangia lo spazio iniziale
 * della PRIMA riga: ` M a.txt` diventa `M a.txt`, e un file solo modificato
 * sul disco passa per «in stage». Conseguenza doppia — il prompt descrive file
 * che non stai committando, e la guardia «niente in stage» non scatta quando
 * dovrebbe. Qui la porcelain si legge in `-z` con lo stesso parser del resto
 * del server (`lib/git-porcelain.ts`), dove il codice XY resta a due caratteri
 * e la prima riga non è speciale.
 *
 * ── Il budget: perché non «i primi 4000 caratteri» ──────────────────────────
 * Troncare il diff intero in testa è il criterio peggiore a parità di spesa:
 * un file grosso all'inizio affama tutti quelli dopo, che spariscono dal
 * prompt senza lasciare traccia. Misurato sugli ultimi 30 commit di questo
 * repo: diff mediano 10.295 caratteri, 24 su 30 oltre i 4.000 — cioè nel caso
 * NORMALE il modello vedeva un pezzo del primo file e nient'altro.
 *
 * Qui il budget si ripartisce fra i file, e ogni file tronca il PROPRIO pezzo
 * dichiarando quanto ha omesso. Nessun file scompare del tutto: al modello
 * serve sapere che una cosa è cambiata più che vedere ogni riga di come.
 * In più va sempre lo `--stat` intero, che è la mappa completa e costa ~1,2 KB
 * anche su un changeset da venti file.
 */
import { parsePorcelainZ } from "./git-porcelain";

/** Quanto diff mandare in tutto, in caratteri. */
export const DIFF_BUDGET = 12_000;

/** Un file del diff, già spezzato dal suo `diff --git`. */
export interface FileChunk {
  /** Il path come lo scrive git nell'intestazione del blocco. */
  path: string;
  /** Il testo del blocco, intestazione compresa. */
  text: string;
}

/**
 * Le voci IN STAGE di una porcelain `-z`.
 *
 * «In stage» è la PRIMA colonna del codice XY: `M ` sì, ` M` no, `MM` sì (per
 * la sua metà nell'indice). I non tracciati (`??`) non sono in stage per
 * definizione — sono file che git ancora non conosce.
 */
export function stagedEntries(porcelainZ: string): { path: string; status: string }[] {
  return parsePorcelainZ(porcelainZ).filter(e => {
    const x = e.status[0];
    return x !== " " && x !== "?" && x !== "!";
  });
}

/**
 * Spezza un `git diff` unificato nei suoi file.
 *
 * L'ancora è `diff --git` a inizio riga, che è come git separa i file e non
 * può comparire dentro un contenuto (le righe di contenuto hanno sempre un
 * prefisso ` `, `+` o `-`).
 */
export function splitDiffByFile(diff: string): FileChunk[] {
  if (!diff.trim()) return [];
  const out: FileChunk[] = [];
  const righe = diff.split("\n");
  let corrente: string[] = [];
  let path = "";

  const chiudi = () => {
    if (corrente.length) out.push({ path: path || "(sconosciuto)", text: corrente.join("\n") });
  };

  for (const r of righe) {
    if (r.startsWith("diff --git ")) {
      chiudi();
      corrente = [r];
      // `diff --git a/x b/x` — si prende il lato b, che per un rename è il
      // nome NUOVO, cioè quello che si legge nella lista.
      const m = r.match(/ b\/(.+)$/);
      path = m ? m[1] : "";
    } else if (corrente.length) {
      corrente.push(r);
    }
  }
  chiudi();
  return out;
}

/**
 * Il diff ripartito nel budget: ogni file ha la sua quota, e chi sfora lo dice.
 *
 * La quota è uguale per tutti e non proporzionale alla taglia: un file da
 * 50 KB non ha bisogno di venti volte lo spazio di uno da 2 KB per far capire
 * cosa è successo, e la ripartizione proporzionale riporterebbe il problema di
 * partenza (uno grosso che si mangia il prompt).
 *
 * Chi sta sotto la propria quota lascia il resto agli altri: si fa un giro per
 * raccogliere l'avanzo e si ridistribuisce fra quelli che sforano, così su un
 * changeset con un solo file grosso quel file prende quasi tutto il budget
 * invece della sua fetta nominale.
 */
export function budgetedDiff(diff: string, budget = DIFF_BUDGET): string {
  const files = splitDiffByFile(diff);
  if (!files.length) return "";
  if (diff.length <= budget) return diff;

  const quota = Math.floor(budget / files.length);
  let avanzo = 0;
  const sforano: FileChunk[] = [];
  for (const f of files) {
    if (f.text.length <= quota) avanzo += quota - f.text.length;
    else sforano.push(f);
  }
  const extra = sforano.length ? Math.floor(avanzo / sforano.length) : 0;

  return files
    .map(f => {
      const suo = f.text.length <= quota ? quota : quota + extra;
      if (f.text.length <= suo) return f.text;
      const tagliato = f.text.slice(0, suo);
      // Si taglia a fine riga: mezza riga di diff è più confondente che utile.
      const ultimo = tagliato.lastIndexOf("\n");
      const testo = ultimo > 0 ? tagliato.slice(0, ultimo) : tagliato;
      const omesse = f.text.slice(testo.length).split("\n").length - 1;
      return `${testo}\n… (${omesse} righe omesse)`;
    })
    .join("\n");
}

/**
 * Il messaggio di sistema, con dentro gli esempi presi dal repo stesso.
 *
 * Lo stile NON è cablato, e non è una raffinatezza: il prompt di prima chiedeva
 * «conventional commit format» in inglese, mentre gli ultimi 200 commit di
 * questo repo sono frasi italiane descrittive e nemmeno uno porta un prefisso
 * `feat:`. Un modello che obbedisce a quel prompt produce messaggi fuori
 * registro in ogni repo che non segue quella convenzione — e la convenzione
 * non è scritta da nessuna parte (niente commitlint, niente `.gitmessage`), è
 * solo cosa fa la gente qui. Quindi gliela si mostra invece di dichiararla.
 */
export function buildSystemPrompt(esempi: string[]): string {
  const lista = esempi.filter(Boolean).map(e => `- ${e}`).join("\n");
  return [
    "Scrivi il messaggio di commit per le modifiche IN STAGE.",
    "",
    "Imita gli esempi qui sotto: sono i commit veri di questo repository — la",
    "loro lingua, la loro lunghezza, il loro modo di dire le cose. Se usano un",
    "prefisso tipo `feat:`, usalo anche tu; se non lo usano, non inventarlo.",
    "",
    "Prima riga: una frase sola, quello che il commit CAMBIA — non l'elenco dei",
    "file. Corpo solo se serve, e solo per dire il perché.",
    "Rispondi con il solo messaggio, nient'altro.",
    ...(lista ? ["", "Esempi (i commit più recenti di questo repository):", lista] : []),
  ].join("\n");
}

/** Il messaggio utente: la mappa dei file più il diff nel budget. */
export function buildUserPrompt(stat: string, diff: string, budget = DIFF_BUDGET): string {
  return [
    "File in stage:",
    stat.trim() || "(nessuno)",
    "",
    "Modifiche:",
    budgetedDiff(diff, budget) || "(nessuna)",
  ].join("\n");
}

/**
 * Il ripiego senza modello: una descrizione dai soli numeri.
 *
 * Sta qui e non nella `diff-summary` esistente perché quella legge `git diff
 * --stat HEAD` e la porcelain COMPLETA, non tracciati inclusi: descrive il
 * repo, non il commit che stai per fare. Un messaggio del genere è peggio di
 * nessun messaggio, perché è plausibile.
 */
export function rulesFallback(entries: { path: string; status: string }[]): string {
  if (!entries.length) return "chore: aggiorna file";
  const nomi = entries.map(e => e.path);
  const verbo = (() => {
    const x = new Set(entries.map(e => e.status[0]));
    if (x.size === 1 && x.has("A")) return "Aggiungi";
    if (x.size === 1 && x.has("D")) return "Rimuovi";
    if (x.size === 1 && x.has("R")) return "Rinomina";
    return "Aggiorna";
  })();
  if (nomi.length === 1) return `${verbo} ${nomi[0]}`;
  if (nomi.length <= 3) return `${verbo} ${nomi.join(", ")}`;
  return `${verbo} ${nomi.length} file (${nomi.slice(0, 2).join(", ")}, …)`;
}

/**
 * Il modello ha risposto qualcosa di usabile?
 *
 * `claude-code.complete()` su exit non-zero NON lancia: risolve con
 * `content: "Error: CLI exited with code N"`. Senza questo controllo il ✨
 * incollerebbe quella stringa nella casella del commit.
 */
/**
 * Did the provider answer with an ERROR instead of a result?
 *
 * It lives on its own because it has two callers and the rule must not drift:
 * this file (the commit message box) and `services/task-title.ts` (the title the
 * board derives for a card). The failure is the same on both sides: an answer the
 * code treats as good content and then writes over something a person wrote.
 */
export function isProviderError(content: string | undefined | null): boolean {
  return /^Error:/i.test((content ?? "").trim());
}

export function usableMessage(content: string | undefined | null): string | null {
  const t = (content ?? "").trim();
  if (!t) return null;
  if (isProviderError(t)) return null;
  // Il modello a volte incornicia la risposta in un blocco di codice.
  const blocco = t.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  return (blocco ? blocco[1] : t).trim() || null;
}
