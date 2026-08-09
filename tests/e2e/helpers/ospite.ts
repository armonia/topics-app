/**
 * Come si fabbrica un OSPITE, in un posto solo.
 *
 * Stava dentro `guest-confinement.spec.ts`, ed è rimasto identico: qui è solo
 * uscito dal file perché un secondo spec — quello che entra dal RELAY invece
 * che dalla porta del tunnel — deve appaiare esattamente allo stesso modo.
 * Riscriverlo sarebbe due riti di appaiamento da tenere d'accordo, e quello
 * dimenticato racconterebbe di un ospite che il prodotto non produce.
 *
 * L'appaiamento è ASIMMETRICO di proposito, e l'asimmetria è il punto: la
 * richiesta arriva da FUORI (la porta del tunnel — è il telefono che chiede),
 * l'approvazione da DENTRO (loopback — è il proprietario che risponde). Un
 * helper che facesse tutto da una porta sola non produrrebbe un ospite: ne
 * produrrebbe la finzione.
 */
import { expect, type APIRequestContext } from "@playwright/test";
import { E2E_BASE, E2E_TUNNEL_BASE } from "./test-server";
import { SESSION_COOKIE } from "../../../server/lib/device-auth";

/** Appaia un dispositivo e lo fa approvare dal proprietario come persona
 *  DIVERSA da sé: è il gesto che lo rende ospite, e non c'è altro modo. */
export async function ospite(
  api: APIRequestContext,
  nome: string,
): Promise<{ cookie: string; deviceId: string }> {
  // La richiesta viene da fuori — è il telefono che chiede, non il Mac.
  const richiesta = await api.post(`${E2E_TUNNEL_BASE}/api/auth/pair/request`, {
    data: { name: nome },
  });
  expect(richiesta.ok()).toBeTruthy();
  // Il `claim` torna SOLO qui, a chi ha chiesto. Chi vede passare il
  // `requestId` in un frame non ce l'ha, ed è per questo che non può incassare.
  const { requestId, claim } = (await richiesta.json()) as { requestId: string; claim: string };

  // L'approvazione viene dal proprietario, cioè da dentro. `personName` è il
  // caso «è di un'altra persona»: è QUELLO che lo rende ospite — il ruolo
  // discende dalla persona, non si sceglie.
  const ok = await api.post(`${E2E_BASE}/api/auth/pair/approve`, {
    data: { requestId, personName: `Persona ${nome}` },
  });
  expect(ok.ok(), "il proprietario deve poter approvare da loopback").toBeTruthy();
  const approvato = (await ok.json()) as { deviceId: string; role: string };
  expect(approvato.role, "una persona diversa dal proprietario deve dare un ospite").toBe("guest");

  // Il token esce UNA volta sola, nel `Set-Cookie` dello status.
  const stato = await api.get(
    `${E2E_TUNNEL_BASE}/api/auth/pair/status?requestId=${requestId}&claim=${claim}`,
  );
  const corpo = (await stato.json()) as { state: string };
  expect(corpo.state).toBe("approved");
  const setCookie = stato.headers()["set-cookie"] ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  expect(cookie, "lo status approvato deve consegnare il biscotto di sessione").toContain(`${SESSION_COOKIE}=`);

  return { cookie, deviceId: approvato.deviceId };
}

/** Il biscotto come intestazione. Una riga sola, ma ripetuta in due spec. */
export const daOspite = (cookie: string) => ({ Cookie: cookie });
