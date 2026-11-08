/**
 * `/api/license` — la sola porta da cui si chiede «cosa è concesso».
 *
 * Una rotta e non tre: chi vuole sapere se questa installazione può essere
 * raggiunta da fuori, quanti posti ha e perché, chiede QUI. Le decisioni non si
 * prendono qui dentro — si prendono in `server/lib/licenza.ts`, e questa rotta
 * si limita a mostrarle. È la differenza fra una porta e una seconda copia
 * delle regole: una copia risponde diversamente il giorno in cui una delle due
 * viene aggiornata e l'altra no.
 *
 * ── NON È UN CANCELLO ───────────────────────────────────────────────────────
 * Questa rotta non nega niente a nessuno. Se il servizio delle licenze fosse
 * giù, se il gettone fosse illeggibile, se non ci fosse affatto: risponde `200`
 * col piano gratuito e il motivo. Un'interfaccia che chiede «cosa posso fare»
 * non deve mai ricevere un errore, perché un errore è indistinguibile da una
 * macchina rotta — e questa macchina funziona.
 *
 * Gli OSPITI non arrivano qui: `isGuestAllowedPath` non mette `/api/license` in
 * allowlist, e l'allowlist è un elenco di ciò che si può, non di ciò che non si
 * può. Chi arriva da un link condiviso non ha niente da sapere su chi paga.
 */
import type { AppContext, RouteHandler } from "../types";
import { sulFilo } from "../lib/licenza";

export function createLicenseRouter(ctx: AppContext): RouteHandler {
  const { json, readJSON } = ctx;

  return async function licenseRouter(req, _url, pathname, method) {
    if (pathname !== "/api/license") return null;

    const servizio = ctx.licenza?.();
    if (!servizio) {
      // Il servizio non è innestato (un contesto ridotto, una prova): la
      // risposta resta una risposta, e descrive la macchina più libera
      // possibile invece di sollevare.
      return json({
        plan: "free", seats: 1, remoteAccess: false, expiresAt: null,
        reason: "no_token", installationId: "",
      });
    }

    if (method === "GET") return json(sulFilo(servizio.stato()));

    // Installare un gettone. Arriva dal servizio di licenza dopo un pagamento,
    // oppure incollato a mano da chi lo ha ricevuto per posta.
    if (method === "PUT") {
      const body = await readJSON(req) as { token?: unknown } | null;
      const gettone = typeof body?.token === "string" ? body.token.trim() : "";
      if (!gettone) return json({ error: "token required" }, 400);
      const e = servizio.installa(gettone);
      // `409` e non `400`: il gettone è formalmente una richiesta legittima, e
      // ciò che non torna è lo STATO — è per un'altra macchina, è scaduto, non
      // abbiamo con cosa controllarlo. Il motivo esce per intero, perché
      // «rifiutato» senza il perché è ciò che trasforma un problema di
      // distribuzione in un sospetto di truffa.
      if (e.motivo !== "valid") return json({ ...sulFilo(e), error: "token_refused" }, 409);
      return json(sulFilo(e));
    }

    // Tornare al piano gratuito. Esiste perché una licenza che non si può
    // togliere è una licenza che non si può spostare su un'altra macchina.
    if (method === "DELETE") return json(sulFilo(servizio.rimuovi()));

    return null;
  };
}
