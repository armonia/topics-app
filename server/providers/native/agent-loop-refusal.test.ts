/**
 * IL RIFIUTO CHE NON SI VEDEVA — segnalato il 21/09 su topic:a5c4a915.
 *
 * «Si è bloccata, non vedo nessun feedback.» La chat non era bloccata: l'API
 * aveva rifiutato il turno («violative cyber content») e il server aveva
 * scritto il verdetto. Il verdetto pero' era il 19° blocco di 19, in coda a una
 * pila di tool call, dove nessuno scorre — e il banner ambra sopra il
 * compositore, che esiste apposta per questo, non si accendeva.
 *
 * LA CATENA CHE MANCAVA, in un anello solo: il banner rende solo i blocchi
 * `error` che portano una `cause` (vedi `interruptedTurnOf`), e `stream:end`
 * mette `stopCause` sul filo solo se `endInfo.cause` c'e'. Un rifiuto tornava
 * con `end: "refusal"` e basta: nessuna causa, nessun banner, ne' in diretta
 * ne' dopo un reload.
 *
 * Questi test guardano la SORGENTE della causa. Piu' a valle ci sono i test del
 * banner (`client/src/components/Chat/turnError.test.ts`) e quelli della frase
 * (`server/lib/cancelled-notice.test.ts`).
 */
import { describe, test, expect } from "bun:test";
import { roundEnd } from "./agent-loop";
import { STOP_CAUSES } from "../../../shared/ws-outbound";

describe("roundEnd · un rifiuto porta la sua causa", () => {
  test("il rifiuto dichiara ANCHE chi ha chiuso il turno, non solo cosa e' successo", () => {
    const out = roundEnd("refusal", 0, 0, null);
    expect(out.end).toBe("refusal");
    // `cause` e' l'anello che mancava: senza, niente banner e niente stopCause.
    expect(out.cause).toBe("refusal");
  });

  test("la causa e' una del vocabolario del filo, o il broadcast viene scartato", () => {
    // Una `stopCause` fuori da `STOP_CAUSES` fa fallire la validazione di
    // `stream:end`: il client non riceve la fine del turno e la chat resta
    // «in esecuzione» per sempre. E' il guasto documentato accanto a quella
    // lista, e questo test e' il motivo per cui non puo' tornare.
    expect(STOP_CAUSES).toContain(roundEnd("refusal", 0, 0, null).cause as never);
  });

  test("la spiegazione dell'API viaggia col verdetto: e' l'unica parte utile", () => {
    const out = roundEnd("refusal", 0, 0, {
      type: "refusal",
      explanation: "violative cyber content",
    } as never);
    expect(out.detail ?? "").toContain("violative cyber content");
  });

  test("un rifiuto CON lavoro gia' fatto resta un rifiuto", () => {
    // Il caso reale: il turno aveva gia' eseguito tool prima del no. Se qui
    // prevalesse il ramo dei tool, il verdetto tornerebbe muto.
    const out = roundEnd("refusal", 6, 18, null);
    expect(out.end).toBe("refusal");
    expect(out.cause).toBe("refusal");
  });

  test("le altre fini NON diventano rifiuti", () => {
    expect(roundEnd("end_turn", 0, 1, null).end).toBe("end_turn");
    expect(roundEnd("max_tokens", 0, 1, null).end).toBe("max_tokens");
    // `max_tokens` non ha causa apposta: e' un limite di lunghezza, non una
    // fine attribuita a qualcuno.
    expect(roundEnd("max_tokens", 0, 1, null).cause).toBeUndefined();
  });
});
