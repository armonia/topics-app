/**
 * La porta del tunnel, e la fiducia che NON porta con sé.
 *
 * Il caso che questo file presidia è il più grave che questo server possa
 * avere: un tunnel termina sulla macchina e inoltra a loopback, e loopback qui
 * è proprietario senza credenziale. Messo davanti così com'è, un tunnel non
 * estende il perimetro — lo rovescia, e chiunque su Internet entra come il
 * padrone di casa.
 *
 * Arriving on the tunnel listener must not confer ownership, even though the
 * peer address the server sees is loopback.
 *
 * @covers GUEST-03
 */
import { describe, expect, it } from "bun:test";
import {
  markViaTunnel, isViaTunnel, isLocalTransport, clientIpOf, tunnelPort,
} from "./tunnel";
import { isLoopbackAddress } from "./auth-gate";

const richiesta = (h: Record<string, string> = {}) => new Request("https://x/api/topics", { headers: h });

describe("tunnel · la fiducia sta nella PORTA, non in un header", () => {
  it("una richiesta locale non marcata è locale", () => {
    const r = richiesta();
    expect(isLocalTransport(r, "127.0.0.1", isLoopbackAddress)).toBe(true);
    expect(isLocalTransport(r, "::1", isLoopbackAddress)).toBe(true);
  });

  it("la STESSA richiesta, arrivata dal tunnel, NON è locale", () => {
    // Il peer è identico — è il tunnel che gira su questa macchina. Se la
    // domanda fosse solo «da che indirizzo?», la risposta sarebbe «da casa», e
    // chi ha bussato da Internet entrerebbe come proprietario.
    const r = richiesta();
    markViaTunnel(r);
    expect(isLocalTransport(r, "127.0.0.1", isLoopbackAddress)).toBe(false);
    expect(isLocalTransport(r, "::1", isLoopbackAddress)).toBe(false);
  });

  it("un peer remoto resta remoto in ogni caso", () => {
    expect(isLocalTransport(richiesta(), "192.168.1.7", isLoopbackAddress)).toBe(false);
    expect(isLocalTransport(richiesta(), null, isLoopbackAddress)).toBe(false);
  });

  it("nessun header può dichiarare di venire dal tunnel", () => {
    // La marcatura la mette SOLO l'ascoltatore dedicato. Se bastasse un header,
    // chiunque in rete locale potrebbe scegliersi il proprio livello di
    // fiducia — che è il difetto che questo disegno esiste per non avere.
    const finto = richiesta({
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "1.2.3.4",
      "x-via-tunnel": "1",
    });
    expect(isViaTunnel(finto)).toBe(false);
    expect(isLocalTransport(finto, "127.0.0.1", isLoopbackAddress)).toBe(true);
  });

  it("la marcatura non si propaga da una richiesta all'altra", () => {
    const a = richiesta(); const b = richiesta();
    markViaTunnel(a);
    expect(isViaTunnel(a)).toBe(true);
    expect(isViaTunnel(b)).toBe(false);
  });
});

describe("tunnel · l'indirizzo VERO di chi chiede", () => {
  it("fuori dal tunnel si usa il peer, e gli header si ignorano", () => {
    const r = richiesta({ "cf-connecting-ip": "9.9.9.9" });
    expect(clientIpOf(r, "192.168.1.7")).toBe("192.168.1.7");
  });

  it("dal tunnel si legge l'indirizzo dichiarato da Cloudflare", () => {
    // Senza, il tetto per-indirizzo sull'appaiamento — tre richieste a testa —
    // diventerebbe un tetto per l'INTERO Internet: il peer è sempre 127.0.0.1,
    // quindi il quarto telefono al mondo non riuscirebbe più ad appaiarsi.
    const r = richiesta({ "cf-connecting-ip": "203.0.113.9" });
    markViaTunnel(r);
    expect(clientIpOf(r, "127.0.0.1")).toBe("203.0.113.9");
  });

  it("di una catena `X-Forwarded-For` si prende il PRIMO", () => {
    const r = richiesta({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 172.16.0.2" });
    markViaTunnel(r);
    expect(clientIpOf(r, "127.0.0.1")).toBe("203.0.113.9");
  });

  it("senza header si ricade sul peer invece di restare senza", () => {
    const r = richiesta();
    markViaTunnel(r);
    expect(clientIpOf(r, "127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("tunnel · la porta si configura, e non si indovina", () => {
  it("senza variabile non c'è nessun secondo ascoltatore", () => {
    // Il default è: niente. Un tunnel è un gesto da operatore, non qualcosa
    // che si accende da solo.
    expect(tunnelPort({})).toBeNull();
    expect(tunnelPort({ TOPICS_TUNNEL_PORT: "" })).toBeNull();
  });

  it("un valore valido apre la porta", () => {
    expect(tunnelPort({ TOPICS_TUNNEL_PORT: "3334" })).toBe(3334);
  });

  it("un valore assurdo NON apre una porta a caso", () => {
    for (const v of ["0", "-1", "70000", "abc", "3334.5", " "]) {
      expect(`${v}→${tunnelPort({ TOPICS_TUNNEL_PORT: v })}`).toBe(`${v}→null`);
    }
  });
});
