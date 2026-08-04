/**
 * L'UNICA costruzione delle dipendenze del resolver dei permalink.
 *
 * `resolveTabRef` ha DUE chiamanti, e non passano dallo stesso canale:
 *   · la rotta HTTP `GET /api/tabs/resolve` (`server/routes/tabs.ts`) — che è
 *     come lo raggiunge l'MCP degli agenti;
 *   · il control-tool `resolve_tab` della chat SDK (`server/routes/chat.ts`),
 *     che gira IN-PROCESSO e non fa un giro su HTTP (vedi l'header di
 *     `server/control-tools.ts`: il dispatcher usa i core direttamente).
 *
 * Se ognuno si costruisse le proprie deps, prima o poi uno dei due avrebbe una
 * fonte in meno dell'altro e la STESSA tab risponderebbe `open` di qua e
 * `unknown` di là. È esattamente la classe di bug che questo progetto ha già
 * pagato (una fonte vuota che «chiude» roba viva): due letture della stessa
 * verità che divergono. Qui si costruisce una volta sola, e chi aggiunge una
 * fonte al resolver la aggiunge per entrambi i canali.
 */
import type { AppContext } from "../types";
import type { BrowserService } from "../browser-service";
import { nativeDelegateRegistry } from "../browser-native-delegate";
import type { TabResolverDeps } from "./tab-resolver";

export function tabResolverDeps(
  ctx: AppContext,
  browserService: BrowserService | null | undefined,
): TabResolverDeps {
  return {
    db: ctx.db,
    // Assente ⇒ «non lo so», non «nessun browser vivo»: il resolver tratta i due
    // casi diversamente (vedi TabResolverDeps).
    listBrowserContexts: browserService
      ? () => (browserService.listContexts?.() ?? []).map((c) => ({ id: c.id, url: c.url, title: c.title }))
      : undefined,
    listDelegatedContextIds: () => nativeDelegateRegistry.listDelegated(),
    // La regola del cwd resta UNA (`server/utils.ts:resolveTopicCwd`): qui la si
    // inietta, non la si riscrive.
    resolveCwdForTopic: (topicId) => ctx.resolveTopicCwd(ctx.getTopicById(topicId)),
  };
}
