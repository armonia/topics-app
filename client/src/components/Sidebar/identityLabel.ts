/**
 * CHI SEI, in due righe di testo. Una funzione sola per le due superfici.
 *
 * ── LA DECISIONE CHE QUESTO FILE CAMBIA ─────────────────────────────────────
 * La riga in fondo alla sidebar diceva il nome del FERRO: «Questo computer» sul
 * Mac, «iPhone» dal telefono. Non era un refuso, era una scelta — la riga nasce
 * come conferma di appaiamento, e per quella domanda il ferro È la risposta.
 * Ma la domanda che si fa chi guarda una sidebar non è «su cosa sono», è «chi
 * sono»: «Questo computer» detto a chi il computer ce l'ha in mano non aggiunge
 * niente, e con due telefoni appaiati il nome del ferro non dice nemmeno che
 * sono miei. Attilio l'ha chiesto esplicitamente (card b8ca85e8).
 *
 * Quindi il soggetto diventa la PERSONA, e il ferro scende a dettaglio: resta
 * detto, perché il caso «ho appena appaiato il telefono, è andata?» è ancora
 * vero e la riga è l'unico posto che lo conferma.
 *
 * ── E QUANDO LA PERSONA NON SI SA ───────────────────────────────────────────
 * Non si inventa un nome. Uno schema anteriore alla 084, la rubrica che non
 * risponde, un dispositivo revocato: in tutti e tre `persona` è `null` e la riga
 * torna a dire il ferro, che è l'unica cosa vera che sa. Un nome dedotto da uno
 * user-agent è l'unica cosa che una persona non perdona (vedi il bootstrap della
 * migration 084, che per la stessa ragione scrive 'Proprietario' e non indovina).
 *
 * Le due superfici — la riga desktop (`DeviceIdentityRow`) e la voce del menu
 * sul telefono (`SidebarSystemMenu`) — chiamano QUESTA funzione. Erano due
 * copie della stessa decisione e già divergevano: il menu mostrava la persona,
 * la riga no.
 */
import type { PersonaConProfilo } from '@/lib/api';
import type { SessionState } from '@/lib/auth/session';

export interface EtichettaIdentita {
  /** La riga grossa: il nome della persona, o il ferro quando non c'è. */
  nome: string;
  /** La riga piccola: il ferro quando il nome è la persona, altrimenti niente
   *  (ripetere «Questo computer» sotto «Questo computer» non è un dettaglio). */
  dettaglio: string;
  /** Una o due lettere per il tondino, vuoto se non c'è un nome da cui
   *  ricavarle. Chi disegna decide cosa mettere al loro posto. */
  iniziali: string;
  /** La faccia vera, quando un profilo GitHub è agganciato e in cache. */
  avatarUrl: string | null;
  /** `true` quando `nome` è la persona. È ciò che un test guarda per dire che
   *  la riga NON è tornata al nome del ferro. */
  personale: boolean;
}

/** Una o due iniziali maiuscole. «Attilio Cianci» dà AC, «Mac» dà M. */
export function iniziali(nome: string): string {
  return nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** Il nome del ferro, che la sessione conosce solo quando è appaiata. */
function nomeDelFerro(sessione: SessionState): string {
  return sessione.status === 'paired' ? sessione.name : '';
}

export function etichettaIdentita(
  persona: Pick<PersonaConProfilo, 'displayName' | 'github'> | null,
  sessione: SessionState,
): EtichettaIdentita {
  const ferro = nomeDelFerro(sessione);
  const nomePersona = persona?.displayName?.trim() ?? '';
  const avatarUrl = persona?.github?.avatarUrl ?? null;

  if (nomePersona) {
    return {
      nome: nomePersona,
      // Il ferro sotto la persona, ma solo se ha un nome da dire: in attesa
      // della sessione la seconda riga resta vuota invece di occupare spazio
      // per poi cambiare sotto gli occhi.
      dettaglio: ferro,
      iniziali: iniziali(nomePersona),
      avatarUrl,
      personale: true,
    };
  }

  return {
    nome: ferro,
    dettaglio: '',
    iniziali: ferro ? iniziali(ferro) : '',
    avatarUrl,
    personale: false,
  };
}
