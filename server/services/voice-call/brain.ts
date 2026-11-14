/**
 * The brain of the call. Gemini Live hears and speaks well but reasons little
 * (30% on tool tasks for Artificial Analysis; on 13/11 "is the assistant already
 * handling it?" became "relaunch the jobs"): with a brain model set, Gemini only
 * does ear, voice and turns, and every real phrase is thought by a stronger
 * model with the transcript of the call (the phrase as whisper heard it, which
 * errs less than Gemini). The brain answers in 2-3 s with a short context; jobs
 * that need tools still go to the agent's chat (`affida`), which takes 14-24 s.
 * It is OpenAI's "chat-supervisor" pattern (openai-realtime-agents): the fast
 * voice in front, the strong model behind.
 * Ported from jarvis-channels `src/voice/brain.rs`. The brain runs on a Topics
 * provider instead of a local Anthropic proxy, so it works for anyone.
 */
import type { ChatMessage, CompletionOptions, CompletionResult } from "../../providers/types";

/**
 * Past this the answer no longer arrives in time for a phone call: the job goes
 * to the agent's chat. On 13/11 Opus went over 9 s on a long phrase and the
 * question ended up in the slow chat (30 s): with "one moment" and "one more
 * second" said aloud, 14 s of the brain are worth more than an answer from chat.
 */
export const THINK_MAX_MS = 14_000;
/** The quick voice (Groq): two or three words in tone at once, and the steps of the job told. Over this, without. */
export const QUICK_MAX_MS = 2500;
/** The last lines that go to the brain: enough for what follows, and they keep the answer under 3 s. */
export const DIALOG_MAX = 40;

export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

/** Who is who in the prompts. */
export interface VoicePersona {
  /** how the assistant calls the owner aloud */
  name: string;
  /** the assistant's own name */
  assistant: string;
  /** where the owner works; empty = not said */
  org: string;
  /** the channel the call runs on, where the results are also written */
  channel: string;
}

const at = (p: VoicePersona): string => (p.org ? ` ad ${p.org}` : "");

export interface Thought {
  /** what the voice says now */
  say: string;
  /** a job for the agent's chat (tools, today's data); empty = nothing */
  task: string;
  close: boolean;
}

/** The call as the brain sees it: who said what, and the results that arrived. */
export class Dialog {
  readonly lines: string[] = [];

  push(who: string, text: string): void {
    const t = text.trim();
    if (!t) return;
    this.lines.push(`${who}: ${t}`);
    if (this.lines.length > DIALOG_MAX) this.lines.shift();
  }

  render(): string {
    return this.lines.join("\n");
  }
}

/**
 * The reply format, spelt out in the prompt: the Topics providers have no
 * structured output. Written by hand the JSON came out cut or doubled and the
 * voice read the brackets (13/11, 4 answers in 17), which is why `parse` keeps
 * only the first object.
 */
const FORMAT = 'Rispondi SOLO con un oggetto JSON, senza altro testo: {"di": "...", "affida": "...", "chiudi": false}.';

export function system(p: VoicePersona, now: string): string {
  const { name, assistant } = p;
  return (
    `Sei ${assistant}, l'assistente personale di ${name}${at(p)}, e stai parlando con lui al telefono. Adesso è ${now} (ora locale).\n` +
    "Una voce al telefono dice le tue parole: scrivi esattamente ciò che va detto, parlato e naturale, in italiano, dandogli del tu. " +
    "Una o due frasi brevi; di più solo se riferisci un risultato o te lo chiede. Niente elenchi, simboli, link, markdown.\n" +
    `Sai solo questa telefonata e i risultati arrivati in essa. Le frasi di ${name} sono trascritte dal telefono e possono ` +
    "avere errori: interpretale col contesto; se una non ha senso, chiedigli di ripetere.\n" +
    "Rispondi tu a ciò che sai già o che sta nella telefonata: conti, spiegazioni, consigli, il seguito di un risultato " +
    "(«come fai a dirlo?», «e quindi?»). Non inventare fatti né pareri su cose che non hai davanti con i dettagli.\n" +
    `Per ciò che richiede gli strumenti di ${assistant} (mail, calendario, file, messaggi, il computer, i lavori e le sessioni ` +
    "in corso, lo stato di qualcosa, ricerche sul web, dati di oggi, codice, chiamare qualcuno, correggere una cosa che " +
    `${assistant} ha fatto, valutare un documento) metti in «affida» il compito spiegato per intero, con il contesto della ` +
    "telefonata, e in «di» tre o quattro parole («Ci guardo subito»). Il risultato arriva più tardi, anche minuti, e " +
    `${name} lo riceve anche su ${p.channel}. Non riaffidare ciò che è già stato affidato e non è ancora tornato: digli che ` +
    "ci stai lavorando.\n" +
    "Se la richiesta è vaga («dimmi tu», «novità?», «dimmi tutto») chiedigli su cosa, invece di avviare un lavoro.\n" +
    "Se saluta per finire o chiede di chiudere la chiamata, saluta in breve e metti «chiudi»: true. Mai per una frase " +
    "che non hai capito.\n" +
    "In «di» la frase da dire, in «affida» il compito o vuoto, in «chiudi» se chiudere.\n" +
    FORMAT
  );
}

export function userTurn(dialog: Dialog, name: string, phrase: string, heard: string): string {
  let t = "";
  const past = dialog.render();
  if (past) t += `La telefonata finora:\n${past}\n\n`;
  t += `${name} adesso ha detto: «${phrase.trim()}»`;
  const h = heard.trim();
  if (h && h.toLowerCase() !== phrase.trim().toLowerCase()) t += ` (la voce aveva capito: «${h}»)`;
  return t;
}

/** The end of the JSON value that starts at `from` (a `{`), or -1 if it never closes. */
function objectEnd(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** The JSON of the reply, even inside a ```json fence or with text around. Without JSON, the text is what gets said. */
export function parse(text: string): Thought {
  const a = text.indexOf("{");
  if (a >= 0) {
    const b = objectEnd(text, a);
    if (b > 0) {
      try {
        const v = JSON.parse(text.slice(a, b)) as Record<string, unknown>;
        if (v && typeof v === "object" && !Array.isArray(v)) {
          return {
            say: typeof v.di === "string" ? v.di.trim() : "",
            task: typeof v.affida === "string" ? v.affida.trim() : "",
            close: v.chiudi === true,
          };
        }
      } catch {
        /* not JSON: what was written is what gets said */
      }
    }
  }
  return { say: text.trim(), task: "", close: false };
}

/** The door to a Topics provider: `AIProvider.complete`, bound to the configured provider. */
export type Complete = (messages: ChatMessage[], options?: CompletionOptions) => Promise<CompletionResult>;

export interface Brain {
  model: string;
  /** low = no thinking (~3 s, shallower opinions), empty = the model's own */
  effort: string;
  complete: Complete;
}

export async function think(brain: Brain, instructions: string, user: string): Promise<{ ok: true; thought: Thought } | { ok: false; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("tempo scaduto")), THINK_MAX_MS + 1000);
  });
  try {
    const r = await Promise.race([
      brain.complete(
        [
          { role: "system", content: instructions },
          { role: "user", content: user },
        ],
        { model: brain.model, timeoutMs: THINK_MAX_MS, isolated: true, purpose: "voice-call", ...(brain.effort ? { reasoningEffort: brain.effort } : {}) },
      ),
      late,
    ]);
    const text = r.content ?? "";
    if (!text.trim()) return { ok: false, error: "risposta vuota" };
    const t = parse(text);
    if (!t.say && !t.task && !t.close) return { ok: false, error: "niente da dire" };
    return { ok: true, thought: t };
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The system of the "mouth": a second Gemini session with the same voice, which
 * says only the quick voice's lines. The main one waits for the tool answer and
 * cannot talk (13/11: with NON_BLOCKING it skipped the answers).  allow-italian: NON_BLOCKING is the API constant
 */
export const MOUTH = "Ripeti esattamente, in italiano, il testo che ricevi, con tono naturale e tranquillo al telefono. Non aggiungere né togliere niente.";

/**
 * The acknowledgement in tone of the phrase just said: "Ok, opening the mail".
 * Never the answer. The ban on repeating a word that makes no sense came from
 * the calls of 13/11, where the old prompt repeated the misheard word aloud.
 */
export function ackPrompt(phrase: string): [string, string] {
  return [
    "Sei la voce di un assistente al telefono. Ti hanno appena chiesto qualcosa e ci devi pensare: di' in tre-sei parole " +
      "parlate, in prima persona, cosa stai per fare («vedi le mail» → «Ok, apro le mail»; «che appuntamenti ho domani?» → " +
      "«Controllo subito il calendario»; «che ne pensi?» → «Vediamo, ci penso un attimo»). Una frase troncata («quali sono " +
      "le mie») non dice cosa: frase generica. Nomina una cosa da controllare solo se la frase la nomina lei (la posta, il calendario, un " +
      "documento); una domanda generica («cosa succede?», «si è fermato qualcosa?», «chi se ne occupa?») vuole una frase " +
      "generica («Un attimo, vediamo», «Ci guardo subito»): mai inventare cosa controlli (lo schermo, i log, il sistema), " +
      "mai ripetere una parola che non ha senso (è il telefono che l'ha sentita male). «Hai ragione» solo se si lamenta " +
      "di te (aspetta da troppo, non hai capito, ti sei ripetuto): «Hai ragione, ci sto lavorando». Una domanda, anche " +
      "insistente, non è una lamentela. Mai la risposta, mai numeri, nomi o fatti. " +
      "Solo la frase.",
    `Ti ha detto: «${phrase.trim()}»`,
  ];
}

/** The technical steps of the agent's job said as a person would: "I am reading today's mail". */
export function progressPrompt(p: VoicePersona, task: string, steps: string[]): [string, string] {
  return [
    // no way out: with "answer with a dash if there is nothing new" the quick model always answered a dash (13/11)
    `Sei la voce di ${p.assistant} al telefono: mentre lavora a una richiesta, racconti a chi ascolta cosa sta facendo adesso. ` +
      "Ricevi il lavoro e gli ultimi passi tecnici; rispondi con UNA frase parlata in italiano, massimo dieci parole, prima " +
      "persona, presente. Traduci il passo in parole semplici: «gws-mail … gmail» = la posta, «calendar» = il calendario, " +
      "«Read» = sto leggendo, «grep/find» = sto cercando, script e comandi = sto controllando. Esempi: «Sto aprendo la " +
      "posta di oggi», «Sto leggendo l'ultima mail», «Sto cercando nei documenti». Mai comandi, nomi di file, sigle, " +
      "account, indirizzi, numeri o risultati che non conosci. Chi ascolta è la persona per cui lavori: dagli del tu " +
      "(«la tua posta»), mai il suo nome.",
    `Chi ascolta: ${p.name}\nIl lavoro: ${task.trim()}\nUltimi passi:\n${steps.join("\n")}`,
  ];
}

export interface QuickDeps {
  key: string;
  model: string;
  fetchImpl?: typeof fetch;
}

/** One line from the quick voice, within QUICK_MAX; empty, a dash or too long = nothing. */
export async function quick(deps: QuickDeps, [instructions, user]: [string, string]): Promise<string | null> {
  const body = {
    model: deps.model,
    max_tokens: 60,
    temperature: 0.4,
    reasoning_effort: "none",
    messages: [
      { role: "system", content: instructions },
      { role: "user", content: user },
    ],
  };
  try {
    const res = await (deps.fetchImpl ?? fetch)(GROQ_CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${deps.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(QUICK_MAX_MS),
    });
    const v = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const c = v.choices?.[0]?.message?.content;
    return typeof c === "string" ? cleanQuick(c) : null;
  } catch {
    return null;
  }
}

export function cleanQuick(t: string): string | null {
  const s = t
    .trim()
    .replace(/^[«»"“”]+|[«»"“”]+$/g, "")
    .trim();
  return /\p{L}/u.test(s) && s.split(/\s+/).filter(Boolean).length <= 14 ? s : null;
}
