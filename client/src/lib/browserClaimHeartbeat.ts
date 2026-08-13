/**
 * Il battito con cui QUESTA finestra rivendica le sue pane browser native.
 *
 * PERCHÉ UN RECLAMO RIPETUTO E NON UN CONGEDO. Una WKWebView figlia sopravvive
 * alla finestra che la ospita. Se quella finestra se ne va di colpo (chiusura
 * forzata, crash, un pop-out che sparisce) nessuno arriva mai a mandare il
 * «chiudi», e la webview resta appesa. Un messaggio di congedo è affidabile
 * solo quando chi lo manda è ancora vivo, cioè esattamente nel caso che non ci
 * preoccupa. Ribaltando il verso il problema non esiste più: ogni finestra
 * ripete «queste sono mie», e `browser_claim` chiude le webview che nessuna
 * finestra nomina più. Chi muore smette di parlare, e il silenzio è già la
 * risposta.
 *
 * PERCHÉ `liveBrowserViews()` È IL REGISTRO GIUSTO, e non una lista dedotta dal
 * pane-store o dal layout. È l'insieme delle pane browser MONTATE adesso in
 * questa pagina (`shell/nativeBrowserRoster.ts`), e vale come reclamo perché
 * una pane browser non viene MAI sfrattata dalla residenza:
 * `RESIDENCY_BUDGET.native = Infinity` in `state/pane/residency/policy.ts`,
 * perché smontarla non libera niente (wry non dealloca, tauri-apps/wry#1733).
 * Una tab di sfondo resta quindi montata e nascosta, non smontata. «Montata» e
 * «viva» coincidono: il registro non ha falsi negativi, che chiuderebbero sotto
 * gli occhi una pane aperta, né falsi positivi, che terrebbero in vita una
 * webview già morta.
 *
 * Solo su Tauri. Fuori dal guscio nativo non esistono webview figlie da
 * rivendicare, e `browser_claim` non esiste.
 */
import { isTauri } from './shell';
import { liveBrowserViews } from './shell/nativeBrowserRoster';
import { currentWindowLabel, tauriInvoke } from './shell/tauri';

/** Il passo del battito. Non è una scadenza: quanto aspettare prima di credere
 *  al silenzio lo decide il Rust. Questo dice solo ogni quanto la finestra si fa
 *  sentire, e va tenuto ben sotto quella soglia. */
export const BROWSER_CLAIM_INTERVAL_MS = 15_000;

/** L'id del battito, tenuto solo perché il reset dei test possa fermarlo. In
 *  produzione non si ferma mai: dura quanto la pagina. */
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Fa UN battito. Esportata a parte dallo scheduler così un test (o una
 * diagnostica) può eseguirla senza aspettare quindici secondi.
 * Ritorna quante webview il Rust ha chiuso, -1 se non c'era niente da fare.
 */
export async function claimBrowserViews(): Promise<number> {
  if (!isTauri) return -1;
  try {
    return await tauriInvoke<number>('browser_claim', {
      window: currentWindowLabel() ?? 'main',
      ids: [...liveBrowserViews()],
    });
  } catch {
    // Guscio vecchio senza il comando, o IPC che sbatte. Un battito perso non è
    // un guaio: il prossimo arriva fra poco, e intanto un errore di questa
    // finestra non chiude niente a nessuno.
    return -1;
  }
}

/**
 * Arma il battito. Idempotente: armarlo due volte non raddoppia il ritmo.
 *
 * Il primo battito parte SUBITO, non dopo il primo intervallo. Una finestra
 * appena aperta ha già le sue pane montate, e aspettare sarebbe un quarto di
 * minuto in cui quelle pane risultano non reclamate da nessuno.
 */
export function scheduleBrowserClaimHeartbeat(): void {
  if (timer !== null || !isTauri) return;
  void claimBrowserViews();
  timer = setInterval(() => { void claimBrowserViews(); }, BROWSER_CLAIM_INTERVAL_MS);
}

/** Test-only. Ferma il battito e disarma la guardia, così ogni test riparte da
 *  una finestra che non ha ancora reclamato niente. */
export function __resetBrowserClaimHeartbeatForTests(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}
