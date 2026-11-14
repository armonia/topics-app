/**
 * The words of the call: what Gemini is told, which tools it has, how the call
 * opens, and the small recognisers that do not need Gemini. Ported from the
 * prompt half of jarvis-channels `src/voice/call.rs`; the people, the
 * organisation and the channel come from the call instead of the code.
 */
import { ASK_TOOL } from "./gemini";

export type Direction =
  | { kind: "incoming" }
  | { kind: "outgoing"; reason: string }
  /**
   * The assistant calls a contact on behalf of the owner (their mother, say) and
   * brings a message. With them no handoff tool: whoever is not the owner gives
   * the assistant no tasks, not even by voice. `callback`: they are calling back
   * after a call on behalf (missed or not), the call is already open.
   */
  | { kind: "on_behalf"; callee: string; message: string; callback: boolean };

/** Who is who in the prompts: the owner, the assistant, where the owner works, the channel the call runs on. */
export interface VoicePersona {
  name: string;
  assistant: string;
  org: string;
  channel: string;
  /** who does the jobs handed off, said when asked which model it is; empty = the assistant with its tools */
  agentLabel: string;
}

const at = (p: VoicePersona): string => (p.org ? ` ad ${p.org}` : "");

/** The assistant's name as the phone transcribes it: for "Jarvis" also "Giarvis", "Jervis", "Yarvis", "Jarbis"... */
export function namesAssistant(text: string, assistant: string): boolean {
  const t = [...text.toLowerCase()].filter((c) => /\p{L}/u.test(c)).join("");
  const name = [...assistant.toLowerCase()].filter((c) => /\p{L}/u.test(c)).join("");
  if (name === "jarvis") return ["arvis", "ervis", "jarv", "giarv", "arbis", "arviz"].some((n) => t.includes(n));
  return name.length > 0 && t.includes(name);
}

/**
 * In a group "Jarvis, close the call" said twice and Gemini answered "Goodbye"
 * without calling the hang-up tool (12/11, four requests and the assistant
 * still in): the request to leave is recognised here too.
 */
export function asksToLeave(text: string): boolean {
  const t = text.toLowerCase();
  return [
    "chiudi la chiamata",
    "chiudi la call",
    "chiudi la conversazione",
    "esci dalla chiamata",
    "esci dalla call",
    "esci pure",
    "lascia la chiamata",
    "disconnett",
    "vattene",
    "chiuditi",
    "chiudi pure",
    "puoi chiudere",
    "riattacca",
  ].some((p) => t.includes(p));
}

export function groupPrompt(p: VoicePersona): string {
  const { name, assistant } = p;
  return (
    `È una chiamata di gruppo: ${name} ti ha aggiunto a una chiamata con altre persone, che parlano anche fra loro. ` +
    `Ti rivolgono la parola chiamandoti «${assistant}»: rispondi a chi ti ha chiamato, in breve. I compiti da passare a ${assistant} ` +
    `(affida_a_jarvis) solo se li chiede ${name}; se li chiede un altro, di' che lo deve chiedere ${name}. ` +
    "Chiudi (chiudi_chiamata) solo se ti salutano o ti chiedono di uscire dalla chiamata."
  );
}

/**
 * The phone's audio is poor: a short Italian phrase ("what can you do?") Gemini
 * heard as Spanish, three times out of three, and twice it closed the call
 * (10/11). Better one more question than an action on a misheard phrase.
 */
export const PHONE =
  "L'audio del telefono è scarso e chi ti parla parla sempre italiano: se senti parole di un'altra lingua " +
  "o una frase che non torna, hai capito male: chiedi semplicemente di ripetere (senza nominare la lingua) e non agire su quella frase. " +
  "Rispondi sempre in italiano.";

export function systemPrompt(p: VoicePersona, dir: Direction, now: string): string {
  const { name, assistant } = p;
  if (dir.kind === "on_behalf") {
    const { callee, message } = dir;
    return (
      `Sei ${assistant}, l'assistente personale di ${name}. Stai telefonando su ${p.channel} a ${callee} per conto di ${name}. ` +
      `Non sei ${name}: appena risponde ti presenti come il suo assistente. Parli italiano. Adesso è ${now} (ora locale).\n` +
      "È una telefonata: frasi brevi, una o due alla volta, senza elenchi né simboli. Se non hai capito, chiedi di ripetere.\n" +
      `Tono caldo e naturale, come un amico di ${name}: se ${callee} scherza o fa una battuta (anche una parolaccia detta ` +
      "ridendo), rispondi con una battuta leggera e poi torna al punto. Mai frasi rigide da centralino come «mi dispiace, " +
      "devo riferire il messaggio». Scegli il tu o il lei dal tono del messaggio e da come ti risponde, e tienilo fino " +
      "alla fine.\n" +
      "Una battuta non è una risposta: ridici sopra in mezza frase e torna alla domanda del messaggio. Se il messaggio " +
      "chiede una risposta o un impegno, insisti con garbo (due volte al massimo) prima di salutare.\n" +
      `${PHONE}\n` +
      `Il messaggio di ${name} da portare: ${message}\n` +
      `Fai ciò che chiede il messaggio (per esempio chiedere come sta) e ascolta la risposta. Se ${callee} ha un messaggio ` +
      `per ${name}, ripetiglielo per conferma e di' che glielo riferisci.\n` +
      `Non prendere impegni a nome di ${name} oltre al messaggio, non dare altre informazioni su di lui e non fare altre ` +
      `richieste. A ciò che non sai rispondi che lo riferisci a ${name}.\n` +
      "Se una sua frase non ti è chiara, chiedile di ripetere invece di indovinare.\n" +
      `Prima di salutare chiedi se vuole dire altro a ${name}, e aspetta la risposta. Poi saluta in modo naturale ` +
      `(senza dire che chiudi la chiamata) e chiama chiudi_chiamata con l'esito per ${name}.`
    );
  }
  return (
    `Sei ${assistant}, l'assistente personale di ${name}${at(p)}, al telefono con lui su ${p.channel}. Parli italiano e gli dai del tu. Adesso è ${now} (ora locale).\n` +
    "È una telefonata: risposte brevi e naturali, una o due frasi, senza elenchi né simboli. Se non hai capito, chiedi di ripetere.\n" +
    `${PHONE}\n` +
    "Quello che sai già (conti, fatti noti, spiegazioni, consigli) rispondilo subito tu.\n" +
    "Per ciò che da solo non puoi fare (mail, calendario, file, messaggi da mandare, ricerche sul web, dati di oggi, codice, " +
    "lavori lunghi) chiama affida_a_jarvis col compito spiegato per intero, con tutto il contesto della telefonata: di' in " +
    "poche parole che ci stai lavorando. Il risultato arriva dopo, anche minuti: quando arriva riferiscilo in breve. " +
    `${assistant} glielo scrive comunque anche su ${p.channel}.\n` +
    `Se ti chiede di passare il lavoro a ${assistant} o all'agente, chiama sempre affida_a_jarvis.\n` +
    "Se la risposta sta già in un risultato che hai riferito in questa telefonata, rispondi tu: non riaffidarlo.\n" +
    "Non inventare pareri: se ti chiede se una cosa è fatta bene e non l'hai davanti con i dettagli, non dire «credo " +
    `sia completo»: passala a ${assistant} con affida_a_jarvis perché la valuti davvero, e di' che te la fai controllare.\n` +
    `Non dire mai che non hai accesso o non hai informazioni: ${assistant} vede il computer, le sessioni, i lavori in corso, la ` +
    "posta e i file. Ciò che riguarda il computer, i lavori o lo stato di qualcosa lo passi a lui con affida_a_jarvis.\n" +
    `Se corregge qualcosa che ${assistant} ha fatto o detto (un risultato, una mail, una cosa già fatta), passa la correzione ` +
    `a ${assistant} con affida_a_jarvis: tu non la ricordi oltre questa telefonata, lui sì.\n` +
    `Se ti chiede di chiamare qualcuno per conto suo, passalo a ${assistant} con affida_a_jarvis: chi chiamare e il messaggio ` +
    `esatto da portare (${assistant} chiama solo i contatti che ${name} ha autorizzato). Di' che la chiamata parte appena ` +
    `chiudete questa e che l'esito gli arriva su ${p.channel}.\n` +
    "Quando la telefonata è finita (si salutano, «ciao», «a dopo», «basta così»), saluta in breve e chiama chiudi_chiamata."
  );
}

/**
 * With the brain on, Gemini decides nothing: greetings, "yes", "repeat" it says
 * itself, everything else it passes to the ask tool and says the answer. It is
 * the owner on the phone, incoming or outgoing.
 */
export function voicePrompt(p: VoicePersona, now: string, speaksWhileThinking: boolean): string {
  const { name, assistant } = p;
  // on 13/11, to "Yes, thanks" Gemini answered on its own "I will pass the idea on" and did not: no promises of its own
  const wait = speaksWhileThinking
    ? ": mentre Jarvis pensa di' subito tre o quattro parole che dicono cosa stai facendo («Vediamo le mail», «Un attimo, " +
      "ci penso», «Controllo subito»), mai una risposta"
    : ", senza dire niente prima";
  return (
    `Sei la voce di ${assistant}, l'assistente personale di ${name}${at(p)}, al telefono con lui su ${p.channel}. Parli italiano e gli dai del tu. Adesso è ${now} (ora locale).\n` +
    `${PHONE}\n` +
    `Tu non ragioni, non decidi e non prometti niente: a pensare è ${assistant}. Da solo rispondi soltanto a un saluto iniziale, e ` +
    "chiedi di ripetere se non hai sentito. Per tutto il resto, anche «sì», «ok», «grazie» e le risposte alle domande di " +
    `${assistant}, chiama subito chiedi_a_jarvis con la sua frase${wait.replace("Jarvis", assistant)}, e poi di' la risposta che ti torna così com'è, con ` +
    "naturalezza, senza aggiungere né togliere. Non dire mai numeri, nomi, fatti o pareri tuoi: " +
    `solo quelli che ti dà ${assistant} o che stanno in un risultato.\n` +
    "Quando arriva il risultato di un lavoro, riferiscilo in breve.\n" +
    "Quando la telefonata è finita (si salutano, «ciao», «a dopo», «basta così», «chiudi»), saluta in breve e chiama chiudi_chiamata."
  );
}

/**
 * Who the voice on the phone is. Without it, to "which model are you?" Gemini
 * answered "Claude, the latest version" and insisted (10/11): it made it up.
 */
export function identity(model: string, p: VoicePersona): string {
  const who = p.agentLabel ? `li fa ${p.assistant} con ${p.agentLabel}` : `li fa ${p.assistant} con i suoi strumenti`;
  return (
    `Chi sei: la voce al telefono è ${model}, un modello di Google (Gemini Live); i lavori che passi a ${p.assistant} ${who}. ` +
    `Se ti chiedono che modello sei, rispondi così. Non inventare fatti che non sai: dillo, o passalo a ${p.assistant}.`
  );
}

type Tool = { name: string; description: string; parameters: unknown; behavior?: string };

const CLOSE_CALL_DESCRIPTION =
  "Chiude la telefonata dopo che hai salutato. Solo quando l'altro ha salutato o ha detto chiaramente che ha finito («ciao», «a dopo», «basta così»): mai per una frase che non hai capito bene.";

export function tools(dir: Direction, p: VoicePersona): [{ functionDeclarations: Tool[] }] {
  if (dir.kind === "on_behalf") {
    return [
      {
        functionDeclarations: [
          {
            name: "chiudi_chiamata",
            description: CLOSE_CALL_DESCRIPTION,
            parameters: {
              type: "OBJECT",
              properties: {
                esito: {
                  type: "STRING",
                  description:
                    "Per il proprietario, in una o due frasi: cosa ha risposto e gli eventuali messaggi per lui, con le sue parole dove contano. Solo ciò che ha detto lei o lui: niente del messaggio che hai portato tu e niente che non abbia detto (saluti, baci, affetto aggiunti di tuo). Se qualcosa non era chiaro, dillo invece di interpretarlo",
                },
              },
              required: ["esito"],
            },
          },
        ],
      },
    ];
  }
  return [
    {
      functionDeclarations: [
        {
          name: "affida_a_jarvis",
          description: `Passa a ${p.assistant}, l'agente con i suoi strumenti, un lavoro che da solo non puoi fare: mail, calendario, file, messaggi, ricerche sul web, dati di oggi, codice. Non per domande a cui sai rispondere. Il risultato arriva più tardi, anche minuti.`,
          parameters: { type: "OBJECT", properties: { compito: { type: "STRING", description: "Il compito completo, con tutto il contesto che serve" } }, required: ["compito"] },
        },
        { name: "chiudi_chiamata", description: CLOSE_CALL_DESCRIPTION, parameters: { type: "OBJECT", properties: {} } },
        {
          name: "velocita",
          description: "Cambia la velocità della tua voce, quando te lo chiede («parla più veloce», «più piano», «normale»). Vale da subito e resta per le prossime chiamate.",
          parameters: {
            type: "OBJECT",
            properties: { valore: { type: "NUMBER", description: "1 = normale; ogni «più veloce» +0,15, ogni «più lento» -0,15; da 0,8 a 1,6" } },
            required: ["valore"],
          },
        },
      ],
    },
  ];
}

/** The tools of the voice with the brain on: the ask tool in place of the handoff (the brain hands jobs off). */
export function voiceTools(p: VoicePersona, speaksWhileThinking: boolean): [{ functionDeclarations: Tool[] }] {
  const t = tools({ kind: "incoming" }, p);
  const list = t[0].functionDeclarations.filter((f) => f.name !== "affida_a_jarvis");
  const ask: Tool = {
    name: ASK_TOOL,
    description: `Passa a ${p.assistant} la frase che ti ha appena detto e ti torna la risposta da dire, in 2-3 secondi. Per tutto ciò che non è il saluto iniziale o una richiesta di ripetere.`,
    parameters: { type: "OBJECT", properties: { frase: { type: "STRING", description: "La sua frase, come l'hai sentita" } }, required: ["frase"] },
  };
  if (speaksWhileThinking) ask.behavior = "NON_BLOCKING";
  return [{ functionDeclarations: [ask, ...list] }];
}

/** The first turn, as soon as the call is open and Gemini is ready: the one who answers the phone speaks first. */
export function opening(p: VoicePersona, d: Direction, dropped = false): string {
  const { name, assistant } = p;
  // the line dropped a few minutes ago and they called back: "Hi, tell me" as if nothing had happened sounds like a stranger
  if (dropped && d.kind === "incoming") {
    return `[${name} ti ha richiamato: la telefonata di poco fa è caduta a metà. Di' solo «Eccomi, è caduta la linea» e in mezza frase riprendi da dove eravate rimasti.]`;
  }
  switch (d.kind) {
    case "incoming":
      return `[${name} ti ha chiamato e hai appena risposto. Di' solo un saluto brevissimo, per esempio «Ciao ${name}, dimmi».]`;
    case "outgoing":
      if (d.reason.trim()) {
        // the reason in quotes and to be said as written: rephrased, on 13/11 "ask me
        // for the mail" became "I would need the mail", and the owner hung up at the
        // greeting ("I gather something is wrong")
        return `[Hai chiamato tu ${name} e ha appena risposto. Il motivo, già rivolto a lui: «${d.reason.trim()}». Salutalo e diglielo con queste parole, senza cambiarne il senso né chi fa cosa. Non dire «Pronto?»: l'ha appena detto lui.]`;
      }
      return `[Hai chiamato tu ${name}, perché te l'ha chiesto, e ha appena risposto. Salutalo e chiedigli cosa gli serve. Non dire «Pronto?»: l'ha appena detto lui.]`;
    case "on_behalf":
      if (!d.callback) {
        // the message goes in the first line: in a call of 12/11 the assistant only
        // introduced itself and waited, and the message came after the first answer
        return `[${d.callee} ha appena risposto. In un'unica battuta, senza aspettare che parli: saluta, presentati come ${assistant}, l'assistente di ${name}, e porta subito il messaggio. Non dire «Pronto?»: l'ha appena detto ${d.callee}.]`;
      }
      return (
        `[${d.callee} ha richiamato il numero da cui l'avevi chiamato per conto di ${name}, e hai risposto. In un'unica battuta: saluta, ` +
        `presentati come ${assistant}, l'assistente di ${name}, di' in mezza frase che l'avevi chiamato tu per lui, e porta subito il messaggio.]`
      );
  }
}

/** The opening of a group call: a very short greeting to everyone. */
export function groupOpening(p: VoicePersona): string {
  return `[${p.name} ti ha aggiunto a una chiamata di gruppo e hai appena risposto. Di' solo un saluto brevissimo a tutti, per esempio «Ciao a tutti, sono ${p.assistant}».]`;
}

/** The last answer of the brain: the phrase it answered, what it said, when. */
export interface LastThought {
  phrase: string;
  say: string;
  at: number;
}

/** The same phrase asked less than 10 s after the brain's answer: the answer already thought, not a new thought. */
export function repeatedQuestion(last: LastThought | null, phrase: string, now: number, assistant = "Jarvis"): string | null {
  if (!last) return null;
  if (last.phrase.trim() !== phrase.trim() || now - last.at >= 10_000) return null;
  return `Questa è la risposta di ${assistant} che hai già: «${last.say}». Se non l'hai ancora detta, dilla adesso così; se l'hai detta, non dire niente.`;
}

export function replyText(t: string, p: VoicePersona): string {
  const cut = [...t].slice(0, 3000).join("");
  return `[Risultato del lavoro affidato a ${p.assistant}, che glielo ha anche scritto su ${p.channel}]\n${cut}\n\nRiferiscilo ora a voce in due o tre frasi: prima ciò che aspetta una sua decisione, poi l'essenziale (esito, numeri, nomi, scadenze); il resto in mezza frase («il resto è minore, lo trovi su ${p.channel}»). Niente link, codici o elenchi letti per intero.`;
}

/** What a call on behalf tells the callee when it is recorded: they hear it at once, they do not find out later. */
export function recordedNotice(p: VoicePersona): string {
  return ` [La chiamata è registrata per ${p.name}: diglielo in mezza frase subito dopo esserti presentato, poi il messaggio, tutto nella stessa battuta.]`;
}
