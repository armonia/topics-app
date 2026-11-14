/**
 * A phone call with the assistant: the caller's voice goes to Gemini Live only
 * when they speak (silence would be billed), Gemini's voice goes back to the
 * phone on a 20 ms clock. Gemini generates 3-5 times faster than real time, so
 * the interruption is decided here: 240 ms of voice while the assistant talks
 * are enough to silence it. What Gemini cannot do alone it hands to the agent
 * as a message of the owner; the answer arrives in the chat as always and, if
 * the call is still open, Gemini tells it aloud.
 *
 * Ported from jarvis-channels `src/voice/call.rs` (commit 80f1fd26) as a state
 * machine: each branch of the Rust `select!` is a method here, the 60 ms tick is
 * `step()`, run every third tick of the 20 ms clock the bridge drives. Every
 * dated note is a real call that went wrong; the log event names are the same,
 * because the bench and the channel read them.
 */
import { DIALOG_MAX as _DIALOG_MAX, Dialog, MOUTH, ackPrompt, progressPrompt, system as brainSystem, userTurn, type Thought } from "./brain";
import { ASK_TOOL, addUsage, emptyUsage, usageUsd, type Cmd, type GeminiEvent, type OpenGemini, type Usage, type VoiceOptions } from "./gemini";
import { FRAME, FRAME_MS, Playout, Rechunk, Resampler, Vad, concatI16 } from "./audio/pcm";
import { Ambience, Stretch, clampSpeed, echoOf, misheard } from "./audio/natural";
import { Recorder } from "./audio/record";
import {
  asksToLeave,
  groupOpening,
  groupPrompt,
  identity,
  namesAssistant,
  opening,
  recordedNotice,
  repeatedQuestion,
  replyText,
  systemPrompt,
  tools,
  voicePrompt,
  voiceTools,
  type Direction,
  type LastThought,
  type Persona,
} from "./prompts";

void _DIALOG_MAX;

/** Rings without an answer (outgoing): then it gives up. */
export const RING_MAX = 45_000;
/** Ceiling of a call: past it, almost surely a phone forgotten on. */
export const MAX_CALL = 30 * 60_000;
/** Nobody talks for long: it closes (with a handed-off job running it waits longer, the result can arrive). */
export const IDLE = 3 * 60_000;
export const IDLE_WAITING = 10 * 60_000;
/** Voice in a row that interrupts the assistant while it talks (4 x 60 ms): less, and a cough or an echo silence it. */
const BARGE_FRAMES = 4;
/** After this silence without an answer a filler starts: the median answer is 0.9 s, the slow ones 1.6-1.8. */
const FILLER_AFTER = 1300;
/** With the brain the answer surely arrives after 2-4 s: "Ok, give me a moment" starts before, as a person would. */
const ACK_AFTER = 1600;
/** The brain still thinks: "one more second", once per question. */
const STILL_THINKING = 6000;
/** A step of the job said aloud no more often than this, and not before the job has been running a while. */
const PROGRESS_EVERY = 8000;
const PROGRESS_FROM = 4000;
/** A step does not start if they talked less than this ago: in the pauses inside a phrase the line looks free. */
const STEP_GAP = 1500;
/** The fillers from here on say it is thinking (fillers.ts, FILLER_LINES). */
export const ACK_FROM = 4;
/** How much voice over the assistant whisper needs to tell if it is words; and how long its answer is awaited. */
const CHECK_AUDIO_MS = 700;
const CHECK_MAX = 2500;
/** silence after which whisper already starts (6 x 60 ms): before the gate (1 s) and Gemini's answer (0.7 s) */
const EARLY_QUIET = 6;
/** how long the start of an answer is held waiting for whisper: it usually arrives 0.1-0.5 s after the first audio */
const EAR_WAIT = 700;
/** how long a Gemini action waits for whisper's verdict */
const ACTION_WAIT = 1500;
/** no event from Gemini for this long while "generating": the turn will never close */
const GEMINI_MUTE = 5000;
/** a finished phrase with no answer: after this whisper's text is sent to it */
const ANSWER_MISSING = 3500;
/** After a sound that was not voice (music), for a while another loud sound does not pause: it is only checked. */
const MUSIC_HOLD = 5000;
/**
 * Outgoing, the assistant greets after the other's "Hello?": once they have
 * been quiet for GREET_QUIET, or after GREET_SILENT if they say nothing, and in
 * any case within GREET_MAX (a background noise must not keep it quiet).
 */
const GREET_QUIET = 400;
const GREET_SILENT = 1500;
const GREET_MAX = 4000;
/** How much of the voice said over the assistant is held back, waiting to know if it is an interruption (2.4 s). */
const HELD_MAX = 40;
/**
 * In a group people talk among themselves and Gemini would answer every phrase:
 * its answer is heard only if the phrase has the name in it, or if it comes
 * within FOLLOW_UP of the last time the assistant talked (the conversation with
 * it goes on). The transcript arrives a bit after the audio: the answer waits
 * for the name up to NAME_WAIT, then it is dropped.
 */
const FOLLOW_UP = 8000;
const NAME_WAIT = 900;
/** The 20 ms clock of the bridge; the call logic runs on every third tick. */
export const CLOCK_MS = 20;
const SUB = FRAME / 3;

export interface Outcome {
  reason: string;
  /** the assistant closes it: it is up to us to tell the other phone */
  ours: boolean;
  answered: boolean;
  talkS: number;
  turns: number;
  handoffs: number;
  usage: Usage;
  /** call on behalf: the outcome Gemini gave when closing (what they answered, messages for the owner) */
  report: string | null;
  /** everything the other side said, transcribed: the fallback outcome if the call drops before the goodbye */
  heard: string;
  /** the recording (WAV), if there was one and someone answered */
  recording: string | null;
  /** the speed at the end of the call: if they changed it by voice, it stays for the next ones */
  speed: number;
}

export type WhisperResult = { ok: true; text: string | null } | { ok: false };

/** The doors of a call to the outside, injectable: production wires the real ones, the tests their fakes. */
export interface CallDeps {
  now(): number;
  openGemini: OpenGemini;
  gemini: VoiceOptions & { key: string; model: string; speaksWhileThinking: boolean };
  /** whisper on a phrase; null = no second opinion (no Groq key) */
  whisper: ((pcm: Int16Array) => Promise<WhisperResult>) | null;
  /** one line of the quick voice; null = no quick voice (no Groq key) */
  quick: ((prompt: [string, string]) => Promise<string | null>) | null;
  /** the brain; null = Gemini thinks alone */
  think: ((system: string, user: string) => Promise<{ ok: true; thought: Thought } | { ok: false; error: string }>) | null;
  /** passes a task to the agent (a message of the owner in their chat); rejects = it did not leave */
  handoff(task: string): Promise<void>;
  /** one 20 ms piece of the assistant's voice to the phone; false = the audio is closed */
  toPeer(chunk: Int16Array): boolean;
  /** the phone side is behind: a voiced frame waits for the next tick, a silent one is dropped */
  backlogged?(): boolean;
  /** a line of the call log */
  log(event: string, data: Record<string, unknown>): void;
  /** "Saturday 14/11/2026, 18:05": now, as the prompts say it */
  spokenNow: string;
  debug?: boolean;
}

export interface CallSpec {
  id: string;
  persona: Persona;
  direction: Direction;
  /** where to record the call (both voices in a mono WAV); null = no recording */
  record: string | null;
  /** group call (the owner added the assistant to a call with others): it speaks only when called */
  group: boolean;
  /** speed of the voice (1 = Gemini's); changed by voice during the call */
  speed: number;
  /** fillers with the same voice, PCM at 16 kHz: they cover a long wait before the answer */
  fillers: Int16Array[];
}

type Ask = { id: string; round: number; phrase: string; seq: number };

const VERSO: Record<string, string> = { group: "di gruppo", incoming: "in arrivo", outgoing: "in uscita", callback: "richiamata per conto", on_behalf: "per conto" };

export function versoOf(d: Direction, group: boolean): string {
  if (d.kind === "incoming") return group ? VERSO.group! : VERSO.incoming!;
  if (d.kind === "outgoing") return VERSO.outgoing!;
  return d.callback ? VERSO.callback! : VERSO.on_behalf!;
}

const ms = (x: number): number => Math.max(0, Math.round(x));

export class Call {
  readonly done: Promise<Outcome>;
  private resolveDone!: (o: Outcome) => void;
  private ended = false;

  private readonly brainOn: boolean;
  private readonly brainSys: string;
  private readonly dialog = new Dialog();
  private readonly persona: Persona;
  private readonly gem: { send(c: Cmd): void; close(): void };
  private mouth: { send(c: Cmd): void; close(): void } | null = null;

  // the questions to the brain in flight, and those overtaken by a new phrase:
  // the old answer is not said. On 13/11 two pieces of the same phrase left as
  // two questions and the assistant said two answers in a row.
  // The question in flight: tool id, generation, phrase, whisper phrase it refers
  // to. A new question closes the old one at once; a longer transcript of the
  // same phrase redoes it with the same id (13/11: it left with "ok", whisper
  // 0.3 s later said "this is a problem, so the conversation too").
  private asking: Ask | null = null;
  private askedAt: number;
  // the "mouth": same voice, second session, it says the quick voice's lines
  // (acknowledgement and steps of the job). mouthLive = the audio coming from it
  // is heard; it goes off when the main session talks or they interrupt it
  private mouthLive = false;
  private mouthReady = false;
  private mouthRs = new Resampler();
  private mouthStretch: Stretch;
  // the acknowledgement sent to the mouth for question `round`: it becomes "said" at the first audio
  private mouthWait: { round: number; at: number } | null = null;
  private ackedRound = 0;
  private stillRound = 0;
  private ackLine: { round: number; line: string } | null = null;
  private stepLine: { line: string; at: number } | null = null;
  private stepsSeen = 0;
  private progressSaid: number;
  private progressAsking = false;
  private jobTask = "";
  private jobAt: number;
  private lastStepLine = "";
  private askGen = 0;
  // the brain's last answer: Gemini sometimes calls the tool again with the same phrase instead of saying it
  private lastThought: LastThought | null = null;

  private readonly start: number;
  private answeredAt: number | null;
  private opened = false;
  // whoever answers talks first: the assistant when it is called (also when they call back), the other when the assistant calls
  private readonly speaksFirst: boolean;
  private heardAfterAnswer = false;
  // outgoing, the greeting is generated while it rings and starts after their
  // "Hello?": released = the assistant is heard and Gemini hears the other.
  // Waiting for Gemini after the "Hello?" left a second of silence, and the other
  // said "Hello?" again
  private released = false;
  // until the greeting is all said the other's voice does not interrupt it: a "Hello?" said over it cut it (10/11)
  private greeted = false;
  // in a group: until when Gemini's answers are heard without the name; the
  // answer waiting for the name; the turn we asked for (greeting, result of a
  // job), which is always heard
  private addressedUntil: number | null = null;
  private nameWait: { at: number; buf: Int16Array[] } | null = null;
  private textTurn = false;
  // the answer in progress is to a phrase with the name (or is our turn): only
  // that opens the follow-up without the name. Before, the follow-up was renewed
  // at every phrase of the assistant, even of a follow-up: in a group it answered
  // everything they said among themselves (12/11)
  private named = false;
  private playNamed = false;
  private vad = new Vad();
  private rs = new Resampler();
  private play = new Playout();
  private chunks = new Rechunk();
  private stretch: Stretch;
  private amb = new Ambience();
  // the phrase being said, as it goes to Gemini: when it ends whisper hears it too
  private utt: number[] = [];
  // the last closed turn: whisper also answers after Gemini has finished
  private prevHeard = "";
  private prevSaid = "";
  // end of the last phrase sent to Gemini and how long it was: the filler covers a long wait
  private endAt: { at: number; ms: number; seq: number } | null = null;
  private fillerAt: number | null = null;
  private fillerN = 0;
  // a filler only after a real answer of Gemini: two "One moment" in a row with nothing in between (12/11)
  private fillerArmed = true;
  // every phrase sent to Gemini has a number; whisper says if it was voice
  // (words) or not: the filler only after real voice. Without it, with music on,
  // fillers started on nothing, and the phone sent them back (12/11)
  private uttSeq = 0;
  private uttVoice = 0;
  // the phrase Gemini is answering: if it starts while the other still talks
  // (our gate closes after its), it is the one in progress, not the last closed
  // one. Comparing the answer with the whisper of the phrase before made fake
  // corrections that cut right answers (12/11 evening, 4 in 7)
  private answerSeq = 0;
  // the current answer has already fixed its phrase: Gemini's transcript (said) sometimes arrives before the audio
  private anchored = false;
  // the phrase in progress when Gemini started answering is part of the turn it
  // answers: the turn is emptied after it ends, not before (otherwise whisper of
  // a split phrase would hear only its second half)
  private clearAfterEnd = false;
  // the start of the answer held a moment until whisper says what they said: if
  // Gemini misheard it is dropped before it is heard. Without it, "I did not
  // understand, can you repeat?" was heard and then the right answer (13/11, 12
  // scenarios in 21). At most EAR_WAIT, then it goes anyway
  private earWait: { at: number; buf: Int16Array[] } | null = null;
  private earChecked = 0;
  // Gemini actions that arrived before whisper wait for its verdict (a medical
  // term handed off as a task, 13/11). They come back into the event loop from here
  private deferred: { at: number; e: GeminiEvent }[] = [];
  private deferredIds = new Set<string>();
  // a finished phrase Gemini does not answer: after ANSWER_MISSING whisper's
  // text is sent to it. And a Gemini that does not close the turn after an
  // interruption keeps "generating" on forever: no results, no answers (13/11, a
  // test call mute for 20 s)
  private awaitAnswer: { at: number; seq: number } | null = null;
  private lastGemini: number;
  // whisper starts after EARLY_QUIET of silence, not at the end of the phrase:
  // the gate closes after 1 s, Gemini answers after 0.7, and whisper almost
  // always arrived after the start of the answer (13/11: 40 waits in 46 expired).
  // If they do not start talking again, at the end of the phrase it is not redone
  private earlySeq = 0;
  private voicedAfterEarly = false;
  // interruption to confirm: a loud sound while the assistant talks pauses it at
  // once (like someone hesitating), and silences it only if whisper hears words
  // in it that are not its echo. Music at voice volume silenced it (12/11)
  private check: { seq: number; at: number; sent: boolean } | null = null;
  private checkSeq = 0;
  private paused = false;
  private musicUntil: number | null = null;
  // they asked to close: their "bye, you too" after that no longer cancel the
  // close (12/11: four rounds of goodbyes and at the end "close the call",
  // because each of their words cancelled it)
  private leave = false;
  // the last phrase as whisper heard it, and the last one for which Gemini was already corrected
  private wtext: { seq: number; text: string } | null = null;
  private hinted = 0;
  // every phrase as whisper heard it: in the outcome on behalf they count more
  // than Gemini's, which gets wrong exactly what matters (12/11)
  private whispered: { seq: number; text: string }[] = [];
  // voice said over the assistant, held until it is clear whether it is an interruption or an echo
  private held: Int16Array[] = [];
  private barged = false;
  // after an interruption the rest of the answer Gemini is still generating must not be said
  private generating = false;
  private dropRest = false;
  private pendingFrame: Int16Array | null = null;
  private lastVoice: number;
  // the caller's last voiced frame, and when Gemini finished its last answer: the
  // latency is measured from the end of the question to the first audio of the answer
  private spokeAt: number | null = null;
  private answerDoneAt: number;
  // the results of handed-off jobs wait for a moment of silence: a text sent to Gemini while the assistant talks cuts it mid-phrase
  private replies: string[] = [];
  // since when the first queued result waits: on 12/11 one left 30 s later, with no why in the log
  private replySince: number | null = null;
  // everything they said since Gemini's last answer: the gate splits "Dimmi
  // tutto" in two pieces under 400 ms, and whisper on the piece alone never
  // started (12/11). Gemini hears the whole turn, whisper must hear the same
  private turnPcm: number[] = [];
  // which turn each phrase sent to whisper belongs to: in the report only the longest transcript of each turn stays
  private turnId = 0;
  private turnOf: { seq: number; turn: number }[] = [];
  // the hang-up tool: Gemini may call it before or after the goodbye. It closes at turn end with the goodbye said (or after 8 s)
  private hangupAsked: number | null = null;
  private hangupWhenSaid = false;
  private waitingJobs = 0;
  private heard = "";
  private said = "";
  private readonly out: Outcome;
  private rec: Recorder | null = null;
  private openText: string;
  private reinjected: GeminiEvent[] = [];
  private clockTicks = 0;
  private outChunks: Int16Array[] = [];
  private whisperInFlight = new Set<Promise<unknown>>();
  private collecting = false;

  constructor(private readonly spec: CallSpec, private readonly deps: CallDeps) {
    this.done = new Promise((r) => (this.resolveDone = r));
    const now = deps.now();
    this.persona = spec.persona;
    const d = spec.direction;
    // the brain is for the owner alone on the phone: on behalf and in a group Gemini stays as it was
    this.brainOn = !spec.group && (d.kind === "incoming" || d.kind === "outgoing") && deps.think !== null;
    this.brainSys = brainSystem(this.persona, deps.spokenNow);
    this.askedAt = now;
    this.progressSaid = now;
    this.jobAt = now;
    this.start = now;
    this.lastGemini = now;
    this.lastVoice = now;
    this.answerDoneAt = now;
    this.mouthStretch = new Stretch(spec.speed);
    this.stretch = new Stretch(spec.speed);
    this.answeredAt = d.kind === "incoming" || (d.kind === "on_behalf" && d.callback) ? now : null;
    this.speaksFirst = d.kind === "incoming" || (d.kind === "on_behalf" && d.callback);
    this.out = {
      reason: "",
      ours: false,
      answered: false,
      talkS: 0,
      turns: 0,
      handoffs: 0,
      usage: emptyUsage(),
      report: null,
      heard: "",
      recording: null,
      speed: spec.speed,
    };
    deps.log("inizio", { verso: versoOf(d, spec.group), modello: deps.gemini.model });

    const g = deps.gemini;
    const voice = { voice: g.voice, vocabulary: g.vocabulary, thinkingLevel: g.thinkingLevel, key: g.key, model: g.model, speaksWhileThinking: g.speaksWhileThinking };
    if (this.brainOn) {
      this.mouth = deps.openGemini({ ...voice, system: MOUTH, tools: [] }, (e) => this.onMouth(e));
    }
    let sys = this.brainOn
      ? voicePrompt(this.persona, deps.spokenNow, g.speaksWhileThinking)
      : `${systemPrompt(this.persona, d, deps.spokenNow)}\n${identity(g.model, this.persona)}`;
    if (d.kind !== "on_behalf") {
      sys += `\nLa tua voce oggi va a velocità ${spec.speed.toFixed(2)}: se ti chiede di parlare più veloce o più piano chiama velocita, e poi conferma in due parole.`;
    }
    if (spec.group) sys += `\n${groupPrompt(this.persona)}`;
    const gemTools = this.brainOn ? voiceTools(this.persona, g.speaksWhileThinking) : tools(d, this.persona);
    this.gem = deps.openGemini({ ...voice, system: sys, tools: gemTools }, (e) => this.onGemini(e));

    if (spec.record) {
      try {
        this.rec = Recorder.create(spec.record);
      } catch (e) {
        deps.log("registrazione_fallita", { errore: e instanceof Error ? e.message : String(e) });
      }
    }
    this.openText = spec.group ? groupOpening(this.persona) : opening(this.persona, d);
    // whoever does not know they are talking to a recorded assistant hears it at once, does not find out later
    if (this.rec && d.kind === "on_behalf") this.openText += recordedNotice(this.persona);
  }

  private send(c: Cmd): void {
    this.gem.send(c);
  }

  private speaking(): boolean {
    return this.play.isPlaying() || this.pendingFrame !== null;
  }

  // ─── the assistant really goes quiet: what is left of the answer is dropped, and the held voice goes to Gemini
  private cut(ev: string): void {
    this.barged = true;
    this.check = null;
    this.paused = false;
    const notSaid = Math.floor(this.play.clear() / 16) + (this.pendingFrame !== null ? FRAME_MS : 0);
    this.pendingFrame = null;
    this.stretch.reset();
    this.mouthLive = false;
    this.mouthStretch.reset();
    this.dropRest = this.generating;
    const [db, floor] = this.vad.levelsDb();
    this.deps.log(ev, { ms_non_detti: notSaid, db: Math.round(db), fondo: Math.round(floor) });
    // the interrupted goodbye was not heard: closing now would hang up in their face
    if (!this.spec.group && !this.leave && this.hangupAsked !== null) {
      this.hangupAsked = null;
      this.hangupWhenSaid = false;
      this.deps.log("chiusura_annullata", {});
    }
    for (const h of this.held.splice(0)) {
      for (const s of h) this.utt.push(s);
      this.send({ type: "audio", pcm: h });
    }
  }

  // Gemini asks to repeat a phrase whisper understood: it is stopped and given
  // the transcript. It is judged when Gemini starts answering, not when whisper
  // arrives: whisper often arrives after the start of the answer, and on 12/11 a
  // phrase heard by Gemini as Spanish went through
  private anchor(): void {
    if (this.anchored) return;
    this.anchored = true;
    this.answerSeq = this.utt.length === 0 ? this.uttSeq : this.uttSeq + 1;
    if (this.utt.length > 0) this.clearAfterEnd = true;
    else if (this.turnPcm.length > 0) {
      this.turnPcm = [];
      this.turnId += 1;
    }
  }

  private ask(id: string, phrase: string, heard: string): void {
    const think = this.deps.think;
    if (!this.brainOn || !think) return;
    this.askGen += 1;
    const round = this.askGen;
    const user = userTurn(this.dialog, this.persona.name, phrase, heard);
    if (this.asking === null) {
      this.askedAt = this.deps.now();
      const quick = this.deps.quick;
      if (quick && this.mouth) {
        const t0 = this.deps.now();
        void quick(ackPrompt(phrase)).then((a) => this.onQuick(round, a, this.deps.now() - t0));
      }
    }
    this.asking = { id, round, phrase, seq: this.answerSeq };
    this.awaitAnswer = null;
    const t0 = this.deps.now();
    void think(this.brainSys, user).then((r) => this.onThought(id, round, phrase, r, this.deps.now() - t0));
  }

  private tryHint(): void {
    const w = this.wtext;
    if (!w || w.seq !== this.answerSeq || this.hinted === w.seq || this.spec.group || this.hangupAsked !== null) return;
    // two cases: Gemini asks to repeat (its transcript may already be in
    // prevHeard), or it is already answering a phrase whisper heard differently.
    // The second is judged only once the answer has started, when Gemini's
    // transcript is whole: a half one would look wrong.
    // On 12/11 "Dimmi tutto" was heard as English, then an empty answer, 3 times in 3 also outside the call
    const source = (this.said.trim() === "" ? this.prevSaid : this.said).toLowerCase();
    const asksRepeat = ["ripet", "non ho capito", "non ti sento", "in italiano", "sentito male"].some((p) => source.includes(p));
    const answering = !this.textTurn && (this.said.trim() !== "" || this.earWait !== null) && this.heard.trim() !== "";
    const g = this.heard.trim() === "" ? this.prevHeard : this.heard;
    // with the brain the phrase already reaches it as whisper heard it:
    // correcting Gemini relaunched the same question, and the assistant said two
    // answers in a row (13/11)
    if ((asksRepeat || answering) && !this.brainOn && misheard(g, w.text)) {
      this.hinted = w.seq;
      if (this.earWait !== null) {
        this.earWait = null;
        this.deps.log("risposta_buttata", {});
      }
      this.play.clear();
      this.stretch.reset();
      this.dropRest = this.generating;
      this.deps.log("capito_male", { gemini: g.trim(), whisper: w.text });
      this.textTurn = true;
      this.send({ type: "text", text: `[Al telefono hai capito male la sua ultima frase. Ha detto: «${w.text}». Rispondi a questo: non chiedergli di ripetere e non scusarti a lungo.]` });
    }
  }

  // ─── the clock ─────────────────────────────────────────────────────────────

  /** One tick of the 20 ms clock: the call logic every third tick, one 20 ms piece of voice to the phone at every tick. */
  tick(): void {
    if (this.ended) return;
    if (this.clockTicks++ % 3 === 0) this.step();
    if (this.ended) return;
    const c = this.outChunks.shift();
    if (c && !this.deps.toPeer(c)) this.finish("audio chiuso", false);
  }

  /** The 60 ms tick of the Rust loop. */
  private step(): void {
    const now = this.deps.now();
    const at = this.answeredAt;
    if (at === null) {
      if (now - this.start > RING_MAX) this.finish("nessuna risposta", true);
      return;
    }
    // greeting as soon as they answer ended over their "Hello?", which cut the
    // greeting: three outgoing calls in three on 10/11, with "what?" and "I cannot hear you" right after
    if (this.opened && !this.released) {
      const quiet = now - this.lastVoice >= GREET_QUIET;
      const waited = now - at;
      if ((this.heardAfterAnswer && quiet) || (!this.heardAfterAnswer && waited >= GREET_SILENT) || waited >= GREET_MAX) {
        this.released = true;
        this.vad.closeGate();
        this.deps.log("saluto", { dopo_ms: ms(waited), ha_detto_pronto: this.heardAfterAnswer, pronto_ms: this.play.queuedMs() });
      }
    }
    // a frame at every tick, voice or silence: the other phone expects a continuous stream
    let f: Int16Array | null = null;
    if (this.released && !this.paused) {
      f = this.pendingFrame ?? this.play.nextFrame();
      this.pendingFrame = null;
    }
    // whisper does not answer: as before, the interruption counts
    if (this.check && now - this.check.at > CHECK_MAX) this.cut("verifica_scaduta");
    const voiced = f !== null;
    // on the phone digital silence sounds like a dropped line; in a group no
    // background is added. No more keys while the assistant works: "the typing
    // sound is annoying" (the owner, 13/11)
    const frame = f ?? (this.released && !this.spec.group ? this.amb.frame(FRAME, false) : new Int16Array(FRAME));
    if (this.deps.backlogged?.()) {
      if (voiced) this.pendingFrame = frame;
    } else {
      this.rec?.said(frame);
      for (let k = 0; k < 3; k++) this.outChunks.push(frame.subarray(k * SUB, (k + 1) * SUB));
    }
    const speaking = this.speaking();
    if (this.spec.group && speaking && (this.named || this.textTurn || this.playNamed)) this.addressedUntil = now + FOLLOW_UP;
    if (!speaking && !this.generating) this.playNamed = false;
    if (this.nameWait && now - this.nameWait.at > NAME_WAIT) {
      const buf = this.nameWait.buf;
      this.nameWait = null;
      this.dropRest = true;
      this.deps.log("non_per_jarvis", { sentito: this.heard.trim(), ms_non_detti: Math.floor(buf.reduce((a, b) => a + b.length, 0) / 16) });
    }
    if (this.released && !this.greeted && this.out.turns > 0 && !speaking && !this.generating) this.greeted = true;
    const free = !speaking && !this.generating && !this.vad.isOpen() && this.replies.length === 0 && !this.leave && this.hangupAsked === null && this.mouthReady;
    if (this.ackLine && this.mouth && free) {
      const { round: r, line: l } = this.ackLine;
      this.ackLine = null;
      if (this.asking?.round === r && this.ackedRound !== r) {
        this.mouthLive = true;
        this.mouthWait = { round: r, at: now };
        this.fillerArmed = false;
        this.fillerAt = now;
        this.endAt = null;
        this.deps.log("voce_veloce_detta", { dopo_ms: ms(now - this.askedAt), frase: l });
        this.mouth.send({ type: "text", text: l });
      }
    }
    // a step ready while they talk is already old: maybe they are correcting
    // exactly that job. On 14/11 on the bench "I am reading the last mail of your
    // inbox" was said in the pause of "No, ... it is not in the inbox", 3 in 3
    if (this.stepLine && (now - this.stepLine.at > 6000 || this.lastVoice > this.stepLine.at)) {
      const l = this.stepLine.line;
      this.stepLine = null;
      this.deps.log("passo_saltato", { frase: l });
    }
    // the told steps started again from zero at every handoff: after "it is not
    // in the mail, it is on another app" the assistant still said "I am looking
    // for the mail in your inboxes" (13/11). Only a growing list or a new turn counts
    if (
      this.stepLine &&
      this.mouth &&
      free &&
      this.waitingJobs > 0 &&
      this.asking === null &&
      now - this.jobAt >= PROGRESS_FROM &&
      now - this.lastVoice >= STEP_GAP &&
      // their last phrase has not been taken by anyone yet: between the end of
      // the phrase and the question to the brain ~0.7 s pass, and the old step got
      // in there (bench 14/11, loaded Mac). 6 s = it was noise, not a phrase
      (this.answerSeq >= this.uttSeq || now - this.lastVoice > 6000)
    ) {
      const l = this.stepLine.line;
      this.stepLine = null;
      this.mouthLive = true;
      this.progressSaid = now;
      this.deps.log("passo_detto", { frase: l });
      this.lastStepLine = l;
      this.mouth.send({ type: "text", text: l });
    }
    // the brain still thinks after STILL_THINKING: "one more second", with the mouth, once per question
    if (
      this.asking &&
      this.mouth &&
      this.stillRound !== this.asking.round &&
      now - this.askedAt >= STILL_THINKING &&
      !speaking &&
      !this.generating &&
      !this.vad.isOpen() &&
      this.replies.length === 0
    ) {
      this.stillRound = this.asking.round;
      this.mouthLive = true;
      this.mouth.send({ type: "text", text: "Ancora un secondo, ci sto ragionando." });
      this.deps.log("ancora_un_secondo", {});
    }
    // the quick voice said nothing within ACK_AFTER: a recorded "Ok, give me a
    // moment", one per question. There was also the limit of one every 8 s, and a
    // question right after a filler stayed mute (13/11)
    if (
      this.asking &&
      this.ackedRound !== this.asking.round &&
      now - this.askedAt >= ACK_AFTER &&
      this.greeted &&
      !speaking &&
      !this.generating &&
      !this.vad.isOpen() &&
      (this.mouthWait === null || this.mouthWait.round !== this.asking.round || now - this.mouthWait.at >= ACK_AFTER / 2) &&
      this.spec.fillers.length > ACK_FROM &&
      this.replies.length === 0 &&
      !this.leave &&
      this.hangupAsked === null
    ) {
      this.ackedRound = this.asking.round;
      this.ackLine = null;
      // the mouth came late: its audio is no longer heard over the recorded one
      this.mouthLive = false;
      this.mouthWait = null;
      this.endAt = null;
      this.fillerArmed = false;
      this.fillerAt = now;
      const acks = this.spec.fillers.slice(ACK_FROM);
      this.play.push(acks[this.fillerN % acks.length]!);
      this.play.turnDone = true;
      this.fillerN += 1;
      this.deps.log("intercalare", { dopo_ms: ms(now - this.askedAt), cervello: true });
    }
    // a late answer: a "Mmh..." as a person would, no more than one every 8 s
    const e = this.endAt;
    if (
      e &&
      !this.spec.group &&
      this.greeted &&
      !speaking &&
      !this.generating &&
      e.ms >= 600 &&
      now - e.at >= FILLER_AFTER &&
      this.uttVoice === e.seq &&
      (this.fillerAt === null || now - this.fillerAt > 8000) &&
      this.spec.fillers.length > 0 &&
      this.fillerArmed &&
      // with the brain thinking there is already the acknowledgement: "Mmh" plus "Ok, give me a moment" in a row (13/11)
      this.asking === null &&
      // a ready result is said, not covered by a filler; and after "close" no fillers
      this.replies.length === 0 &&
      !this.leave &&
      this.hangupAsked === null
    ) {
      this.endAt = null;
      this.fillerArmed = false;
      this.fillerAt = now;
      const short = this.spec.fillers.slice(0, Math.min(this.spec.fillers.length, ACK_FROM));
      this.play.push(short[this.fillerN % short.length]!);
      this.play.turnDone = true;
      this.fillerN += 1;
      this.deps.log("intercalare", { dopo_ms: ms(now - e.at) });
    }
    if (this.earWait && now - this.earWait.at > EAR_WAIT) {
      const w = this.earWait;
      this.earWait = null;
      this.deps.log("attesa_whisper_scaduta", { ms: ms(now - w.at) });
      this.play.push(concatI16(w.buf));
    }
    if (this.deferred.length > 0 && now - this.deferred[0]!.at > ACTION_WAIT) {
      for (const d of this.deferred.splice(0)) this.reinject(d.e);
    }
    // while the brain thinks Gemini waits for the tool answer: it is not mute and
    // it missed nothing. Pushed to answer on its own, it made things up (a price
    // of five thousand euros, 13/11)
    if ((this.generating || this.dropRest) && !speaking && this.asking === null && now - this.lastGemini > GEMINI_MUTE) {
      this.generating = false;
      this.dropRest = false;
      this.anchored = false;
      this.deps.log("gemini_muto", { s: Math.floor((now - this.lastGemini) / 1000) });
    }
    const aa = this.awaitAnswer;
    if (aa && now - aa.at > ANSWER_MISSING && !this.generating && !speaking && !this.vad.isOpen() && !this.spec.group && this.asking === null) {
      this.awaitAnswer = null;
      const w = this.wtext;
      if (w && w.seq === aa.seq && this.hinted !== aa.seq) {
        this.hinted = aa.seq;
        this.textTurn = true;
        this.deps.log("risposta_mancata", { whisper: w.text });
        this.send({ type: "text", text: `[Al telefono ha appena detto: «${w.text}». Non hai risposto: rispondigli ora.]` });
      }
    }
    if (this.hangupAsked !== null && now - this.hangupAsked > 8000) this.hangupWhenSaid = true;
    if (this.hangupWhenSaid && !speaking && !this.generating) return this.finish("chiusa da Jarvis", true);
    if (now - at > MAX_CALL) return this.finish("durata massima", true);
    if (!speaking && !this.generating && !this.vad.isOpen() && this.replies.length > 0) {
      const t = this.replies.shift()!;
      this.textTurn = true;
      this.deps.log("risultato_a_gemini", { attesa_ms: this.replySince === null ? 0 : ms(now - this.replySince) });
      this.replySince = this.replies.length === 0 ? null : now;
      this.send({ type: "text", text: replyText(t, this.persona) });
    }
    const idle = this.waitingJobs > 0 ? IDLE_WAITING : IDLE;
    if (!speaking && now - this.lastVoice > idle) this.finish("silenzio", true);
  }

  // ─── the other side's audio ───────────────────────────────────────────────

  /** PCM16 at 16 kHz from the phone, any length. */
  peerAudio(f: ArrayLike<number>): void {
    if (this.ended || this.answeredAt === null) return;
    for (const fr of this.chunks.push(f)) this.peerFrame(fr);
  }

  private spawnWhisper(seq: number, pcm: Int16Array): void {
    const whisper = this.deps.whisper;
    if (!whisper) return;
    const p = whisper(pcm).then((r) => {
      // empty = no words, "\0" = whisper did not answer: they arrive anyway, for the log
      const t = r.ok ? (r.text ?? "") : "\0";
      this.onWhisper(seq, t);
    });
    this.whisperInFlight.add(p);
    void p.finally(() => this.whisperInFlight.delete(p));
  }

  private peerFrame(f: Int16Array): void {
    this.rec?.heard(f);
    const speaking = this.speaking();
    if (!speaking && !this.barged && this.held.length > 0) {
      // the assistant finished while the other still talked: what was held back was real voice
      for (const h of this.held.splice(0)) {
        for (const s of h) this.utt.push(s);
        this.send({ type: "audio", pcm: h });
      }
    }
    const gate = this.vad.push(f);
    if (this.vad.voicedRun > 0 && this.earlySeq === this.uttSeq + 1) this.voicedAfterEarly = true;
    if (!speaking && this.vad.isOpen() && this.vad.quiet() === EARLY_QUIET && this.utt.length > 0 && !this.spec.group && this.deps.whisper) {
      const pcm = Int16Array.from([...this.turnPcm, ...this.utt]);
      if (pcm.length / 16 >= 400) {
        const seq = this.uttSeq + 1;
        this.earlySeq = seq;
        this.voicedAfterEarly = false;
        this.turnOf.push({ seq, turn: this.turnId });
        this.spawnWhisper(seq, pcm);
      }
    }
    if (this.vad.voicedRun > 0) {
      this.lastVoice = this.deps.now();
      this.spokeAt = this.lastVoice;
      this.heardAfterAnswer = true;
    }
    // before the greeting their voice ("Hello?") does not go to Gemini: it would answer in place of the greeting
    if (!this.released) return;
    // after the hang-up tool the other still talks (finishes the phrase, "wait,
    // one more thing"): no hanging up in their face. If the conversation is really
    // over, Gemini closes again after answering. In a group the others always talk
    // among themselves: there their voice does not cancel the exit (12/11, cancelled so)
    if (!this.spec.group && !this.leave && this.hangupAsked !== null && this.vad.barges(BARGE_FRAMES)) {
      this.hangupAsked = null;
      this.hangupWhenSaid = false;
      this.deps.log("chiusura_annullata", {});
    }
    if (speaking && !this.barged && this.greeted && this.check === null && this.vad.barges(BARGE_FRAMES)) {
      if (!this.deps.whisper || this.spec.group) {
        this.cut("interrotto");
      } else {
        this.checkSeq += 1;
        const now = this.deps.now();
        this.check = { seq: this.checkSeq, at: now, sent: false };
        this.paused = !(this.musicUntil !== null && now < this.musicUntil);
        const [db, floor] = this.vad.levelsDb();
        this.deps.log("forse_interrotto", { db: Math.round(db), fondo: Math.round(floor), in_pausa: this.paused });
      }
    }
    const whisper = this.deps.whisper;
    if (this.check && !this.check.sent && this.held.length * FRAME_MS >= CHECK_AUDIO_MS && whisper) {
      this.check.sent = true;
      const seq = this.check.seq;
      const audio = concatI16(this.held);
      void whisper(audio).then((r) => this.onCheck(seq, r));
    }
    const hold = speaking && !this.barged;
    if (gate.kind === "send") {
      for (const fr of gate.frames) {
        if (hold) {
          this.held.push(fr);
          if (this.held.length > HELD_MAX) this.held.shift();
        } else {
          for (const s of fr) this.utt.push(s);
          this.send({ type: "audio", pcm: fr });
        }
      }
    } else if (gate.kind === "end") {
      // Gemini answers after 0.9 s of silence, our gate closes later: the phrase
      // started before the assistant talked (utt not empty) is real even if it
      // ends while it answers. Before it was dropped as an echo, and whisper never heard it (12/11)
      const answered = hold;
      if (hold) {
        // the held tail: echo or noise while the assistant talked. It is logged:
        // a short phrase said softly over the end of the greeting vanished like
        // this, without a trace (13/11, mute scenario)
        if (this.utt.length === 0 && this.check === null && this.held.length > 0) {
          const [db] = this.vad.levelsDb();
          this.deps.log("scartato_mentre_parlava", { ms: this.held.length * FRAME_MS, db: Math.round(db) });
        }
        this.held = [];
        if (this.check) {
          this.check = null;
          this.paused = false;
          this.deps.log("ripreso", { perche: "suono breve" });
        }
      } else {
        for (const s of gate.frame) this.utt.push(s);
        this.send({ type: "audio", pcm: gate.frame });
        this.send({ type: "streamEnd" });
        this.barged = false;
      }
      if (this.utt.length === 0) return;
      const phraseLen = this.utt.length;
      for (const s of this.utt) this.turnPcm.push(s);
      this.utt = [];
      const phraseMs = Math.floor(phraseLen / 16);
      this.uttSeq += 1;
      const now = this.deps.now();
      // already answered: the filler has nothing to cover
      this.endAt = answered ? null : { at: now, ms: phraseMs, seq: this.uttSeq };
      // while the brain thinks the answer is already on its way: no "you did not answer"
      if (!answered && this.asking === null) this.awaitAnswer = { at: now, seq: this.uttSeq };
      const turn = Int16Array.from(this.turnPcm);
      this.deps.log("fine_frase", { ms: phraseMs, turno_ms: Math.floor(turn.length / 16) });
      const earlyDone = this.earlySeq === this.uttSeq && !this.voicedAfterEarly;
      if (this.deps.whisper && !this.spec.group && !earlyDone && turn.length / 16 >= 400) {
        this.turnOf.push({ seq: this.uttSeq, turn: this.turnId });
        this.spawnWhisper(this.uttSeq, turn);
      }
      if (this.clearAfterEnd) {
        this.clearAfterEnd = false;
        this.turnPcm = [];
        this.turnId += 1;
      }
    }
  }

  // ─── Gemini ───────────────────────────────────────────────────────────────

  /** Events put back into the loop (deferred actions, the anchored ask): handled after the current one. */
  private reinject(e: GeminiEvent): void {
    this.reinjected.push(e);
    queueMicrotask(() => {
      const next = this.reinjected.shift();
      if (next) this.onGemini(next);
    });
  }

  private onGemini(e: GeminiEvent): void {
    if (this.ended) return;
    this.lastGemini = this.deps.now();
    if (this.deps.debug) {
      const ev = e.type === "audio" ? `Audio(${e.pcm.length})` : JSON.stringify(e).slice(0, 80);
      this.deps.log("dbg_gemini", { ev, gen: this.generating, drop: this.dropRest, mouth: this.mouthLive });
    }
    const name = this.persona.assistant;
    switch (e.type) {
      case "gone":
        return this.finish(`gemini: ${e.why}`, true);
      case "ready": {
        this.deps.log("gemini_pronto", { ripresa: e.resumed });
        if (!this.opened && (this.answeredAt !== null || !this.speaksFirst)) {
          this.opened = true;
          this.textTurn = true;
          this.send({ type: "text", text: this.openText });
          if (this.speaksFirst) {
            this.released = true;
            this.vad.closeGate();
          }
        }
        return;
      }
      case "audio": {
        if (this.dropRest) return;
        if (this.mouthLive) {
          this.mouthLive = false;
          this.mouthWait = null;
          this.mouthStretch.reset();
        }
        if (!this.generating) {
          this.generating = true;
          this.playNamed = false;
          if (this.spokeAt !== null && this.spokeAt > this.answerDoneAt) {
            this.deps.log("latenza", { ms: ms(this.deps.now() - this.spokeAt) });
          }
          this.spokeAt = null;
        }
        if (!this.play.isPlaying()) this.barged = false;
        this.endAt = null;
        this.awaitAnswer = null;
        this.fillerArmed = true;
        this.anchor();
        const pcm = this.stretch.push(this.rs.push(e.pcm));
        const now = this.deps.now();
        const open = !this.spec.group || this.textTurn || (this.addressedUntil !== null && now < this.addressedUntil);
        const pending = this.deps.whisper !== null && !this.spec.group && !this.textTurn && this.answerSeq > 0 && (this.wtext === null || this.wtext.seq < this.answerSeq);
        if (this.nameWait) this.nameWait.buf.push(pcm);
        else if (!open) this.nameWait = { at: now, buf: [pcm] };
        else if (this.earWait) this.earWait.buf.push(pcm);
        else if (pending && this.earChecked !== this.answerSeq) {
          this.earChecked = this.answerSeq;
          this.earWait = { at: now, buf: [pcm] };
        } else {
          this.earChecked = this.answerSeq;
          this.play.push(pcm);
        }
        return;
      }
      case "interrupted": {
        this.earWait = null;
        const n = this.play.clear();
        this.stretch.reset();
        this.pendingFrame = null;
        this.nameWait = null;
        this.generating = false;
        this.dropRest = false;
        this.anchored = false;
        this.deps.log("interrotto_da_gemini", { ms_non_detti: Math.floor(n / 16) });
        return;
      }
      // the answer has all arrived: the tail goes out and the assistant is free
      // again (results, "one moment", the next phrase) without waiting for the
      // turnComplete, which Google sends only once playback is over by its own count
      case "generationDone": {
        const tail = this.stretch.flush();
        if (!this.dropRest && tail.length > 0) {
          if (this.nameWait) this.nameWait.buf.push(tail);
          else if (this.earWait) this.earWait.buf.push(tail);
          else this.play.push(tail);
        }
        this.play.turnDone = true;
        this.generating = false;
        return;
      }
      case "turnComplete": {
        // the tail of the slowed or sped up answer goes out before the end of the turn
        const tail = this.stretch.flush();
        if (!this.dropRest && tail.length > 0) {
          if (this.nameWait) this.nameWait.buf.push(tail);
          else this.play.push(tail);
        }
        this.playNamed = this.named || this.textTurn;
        this.named = false;
        this.play.turnDone = true;
        this.hangupWhenSaid ||= this.hangupAsked !== null;
        this.generating = false;
        this.answerDoneAt = this.deps.now();
        this.dropRest = false;
        this.textTurn = false;
        this.out.turns += 1;
        if (this.heard.trim() || this.said.trim()) this.deps.log("turno", { sentito: this.heard.trim(), detto: this.said.trim() });
        if (this.heard.trim()) {
          this.out.heard += `${this.heard.trim()} `;
          if (this.brainOn) {
            const w = this.wtext && this.wtext.seq === this.answerSeq ? this.wtext.text : this.heard.trim();
            this.dialog.push(this.persona.name, w);
          }
        }
        if (this.brainOn) this.dialog.push(name, this.said);
        this.prevHeard = this.heard;
        this.heard = "";
        this.prevSaid = this.said;
        this.said = "";
        this.anchored = false;
        return;
      }
      case "toolCall":
        return this.onTool(e);
      case "heard": {
        this.heard += e.text;
        const now = this.deps.now();
        const open = this.addressedUntil !== null && now < this.addressedUntil;
        if ((!this.spec.group || namesAssistant(this.heard, name) || open) && asksToLeave(this.heard) && !this.leave) {
          this.leave = true;
          this.hangupAsked ??= now;
          this.deps.log("esce_su_richiesta", { sentito: this.heard.trim() });
        }
        if (this.spec.group && namesAssistant(this.heard, name)) {
          this.named = true;
          this.addressedUntil = now + FOLLOW_UP;
          if (this.nameWait) {
            this.play.push(concatI16(this.nameWait.buf));
            this.nameWait = null;
          }
        }
        return;
      }
      case "said": {
        this.said += e.text;
        if (!this.textTurn) this.anchor();
        this.tryHint();
        return;
      }
      case "usage":
        addUsage(this.out.usage, e.usage);
        return;
    }
  }

  private toolResponse(id: string, name: string, result: string): void {
    if (!this.ended) this.send({ type: "toolResponse", id, name, result });
  }

  private onTool(e: Extract<GeminiEvent, { type: "toolCall" }>): void {
    const { id, name, args } = e;
    // the question arrives before Gemini's audio: without fixing here the phrase
    // it answers, the brain got the phrase before (13/11)
    if (name === ASK_TOOL && this.brainOn && !this.anchored && !this.textTurn) {
      this.anchor();
      return this.reinject(e);
    }
    if (
      ["affida_a_jarvis", ASK_TOOL, "velocita", "chiudi_chiamata"].includes(name) &&
      !this.textTurn &&
      !this.leave &&
      this.deps.whisper !== null &&
      !this.spec.group &&
      !this.deferredIds.has(id) &&
      this.answerSeq > 0 &&
      (this.wtext === null || this.wtext.seq < this.answerSeq)
    ) {
      this.deps.log("azione_in_attesa", { strumento: name });
      this.deferredIds.add(id);
      this.deferred.push({ at: this.deps.now(), e });
      return;
    }
    // the phrase goes to the brain as whisper heard it (Gemini gets wrong exactly
    // the words that matter); the answer goes back to Gemini when it arrives, and
    // meanwhile the filler covers
    if (name === ASK_TOOL && this.brainOn) {
      const fallback = typeof args.frase === "string" ? args.frase.trim() : "";
      const phrase = this.wtext && this.wtext.seq === this.answerSeq ? this.wtext.text : fallback || this.heard.trim();
      if (this.asking) {
        const old = this.asking.id;
        this.asking = null;
        this.deps.log("pensiero_superato", {});
        this.send({ type: "toolResponse", id: old, name, result: "Superata da una sua frase nuova: non dire niente." });
      }
      // 13/11: the same phrase asked 1 s after the answer: a second "ok, let me
      // think" and a second thought, and the owner heard the assistant repeat itself
      const result = repeatedQuestion(this.lastThought, phrase, this.deps.now(), this.persona.assistant);
      if (result !== null) {
        this.deps.log("domanda_doppia", { frase: phrase });
        this.send({ type: "toolResponse", id, name, result });
        return;
      }
      this.deps.log("chiesto", { frase: phrase, sentito: this.heard.trim() });
      const h = this.heard.trim() === "" ? fallback : this.heard;
      this.ask(id, phrase, h);
      return;
    }
    const now = this.deps.now();
    const forAssistant = !this.spec.group || this.textTurn || (this.addressedUntil !== null && now < this.addressedUntil);
    // in a group a phrase said among them ("send me the mail") is not a task for the assistant
    if ((name === "affida_a_jarvis" || name === "chiudi_chiamata") && (!forAssistant || (this.dropRest && this.spec.group))) {
      this.deps.log("strumento_ignorato", { strumento: name, sentito: this.heard.trim() });
      return this.toolResponse(id, name, "Non era rivolto a te: non fare niente e non dire niente.");
    }
    // an action on a misheard phrase: "is the assistant already handling it?" had
    // become "relaunch the jobs on the PC" (12/11). If whisper hears something
    // else, the action stops and Gemini gets the phrase
    // An action deferred waiting for whisper, when whisper's verdict has just
    // corrected Gemini (capito_male turned the text turn on): the action belongs to
    // the misheard phrase and stops too. The Rust loop let it through, because the
    // correction sets text_turn before the deferred action comes back (found while
    // porting, 14/11)
    const correctedNow = this.deferredIds.has(id) && this.hinted === this.answerSeq;
    if (
      (name === "affida_a_jarvis" || name === "velocita" || name === "chiudi_chiamata") &&
      (!this.textTurn || correctedNow) &&
      !this.leave &&
      this.wtext !== null &&
      this.wtext.seq === this.answerSeq &&
      this.heard.trim() !== "" &&
      misheard(this.heard, this.wtext.text)
    ) {
      const w = this.wtext.text;
      this.hinted = this.answerSeq;
      this.deps.log("azione_fermata", { strumento: name, gemini: this.heard.trim(), whisper: w });
      return this.toolResponse(id, name, `Fermo: hai capito male. Ha detto: «${w}». Non fare l'azione che avevi capito: rispondi a questa frase.`);
    }
    if (name === "affida_a_jarvis") {
      const task = typeof args.compito === "string" ? args.compito.trim() : "";
      this.out.handoffs += 1;
      void this.deps.handoff(task).then(
        () => {
          if (this.ended) return;
          this.waitingJobs += 1;
          this.deps.log("affidato", { compito: task });
          this.jobTask = task;
          this.jobAt = this.deps.now();
          this.stepLine = null;
          this.toolResponse(id, name, `Passato a ${this.persona.assistant}, il risultato arriva più tardi. Se hai già detto che ci guardi non aggiungere altro, sennò dillo in tre parole.`);
        },
        (err: unknown) => {
          if (this.ended) return;
          const msg = err instanceof Error ? err.message : String(err);
          this.deps.log("affido_fallito", { compito: task, errore: msg });
          this.toolResponse(id, name, `Non è partito (${msg}). Dillo in breve.`);
        },
      );
      return;
    }
    // the close arrives with an answer they have just interrupted (10/11: "Yes,
    // but can you do all of it in this..." and the call closed in silence): what
    // counts is what they are saying, not that answer
    if (name === "chiudi_chiamata" && this.dropRest && !this.leave) {
      this.deps.log("chiusura_ignorata", {});
      return this.toolResponse(id, name, "Non chiudere: ti ha interrotto mentre rispondevi. Ascolta cosa dice e rispondigli.");
    }
    if (name === "chiudi_chiamata") {
      this.hangupAsked ??= now;
      const esito = typeof args.esito === "string" ? args.esito.trim() : "";
      if (esito) this.out.report = [...esito].slice(0, 1000).join("");
      this.deps.log("chiude_jarvis", { esito: this.out.report });
      return this.toolResponse(id, name, "Ok, la chiamata si chiude appena hai finito di parlare.");
    }
    if (name === "velocita") {
      const v = clampSpeed(typeof args.valore === "number" ? args.valore : 1);
      this.stretch.rate = v;
      this.mouthStretch.rate = v;
      this.out.speed = v;
      this.deps.log("velocita", { valore: v });
      return this.toolResponse(id, name, `Velocità ${v.toFixed(2)}, già attiva e salvata per le prossime chiamate. Conferma in due parole.`);
    }
    this.toolResponse(id, name, `strumento sconosciuto: ${name}`);
  }

  // ─── whisper ──────────────────────────────────────────────────────────────

  private onCheck(seq: number, w: WhisperResult): void {
    if (this.ended || this.check?.seq !== seq) return;
    if (w.ok && w.text !== null && !echoOf(this.said, w.text) && !echoOf(this.prevSaid, w.text)) {
      this.deps.log("voce_confermata", { whisper: w.text });
      return this.cut("interrotto");
    }
    if (!w.ok) return this.cut("interrotto");
    this.check = null;
    this.paused = false;
    this.held = [];
    this.musicUntil = this.deps.now() + MUSIC_HOLD;
    this.deps.log("non_era_voce", { whisper: w.text });
  }

  private onWhisper(seq: number, w: string): void {
    if (this.collecting) {
      if (w !== "" && w !== "\0") this.whispered.push({ seq, text: w });
      return;
    }
    if (this.ended) return;
    if (w === "" || w === "\0") {
      this.deps.log("whisper_vuoto", { frase: seq, errore: w !== "" });
      return;
    }
    if (w.split(/\s+/).filter(Boolean).length >= 2) this.uttVoice = Math.max(this.uttVoice, seq);
    this.deps.log("whisper", { frase: seq, risposta_a: this.answerSeq, testo: w, detto: this.said.trim(), sentito: this.heard.trim() });
    // the same piece heard twice (early and at the end of the phrase): the last one counts
    if (this.whispered.at(-1)?.seq === seq) this.whispered.pop();
    this.whispered.push({ seq, text: w });
    const a = this.asking;
    if (a && a.seq === seq && w.trim() !== a.phrase.trim() && [...w].length > [...a.phrase].length) {
      this.deps.log("richiesto", { frase: w });
      this.ask(a.id, w, "");
    }
    // "you may close the conversation" said over the end of an answer: Gemini
    // heard only its first word and the call stayed open (13/11, mail scenario, 3
    // rounds in 3). Whisper heard it whole
    if (!this.spec.group && !this.leave && asksToLeave(w)) {
      this.leave = true;
      this.hangupAsked ??= this.deps.now();
      this.deps.log("esce_su_richiesta", { whisper: w });
    }
    this.wtext = { seq, text: w };
    this.tryHint();
    if (this.earWait) {
      const e = this.earWait;
      this.earWait = null;
      this.deps.log("attesa_whisper", { ms: ms(this.deps.now() - e.at) });
      this.play.push(concatI16(e.buf));
    }
    for (const d of this.deferred.splice(0)) this.reinject(d.e);
  }

  // ─── the brain ────────────────────────────────────────────────────────────

  private onThought(id: string, round: number, phrase: string, r: { ok: true; thought: Thought } | { ok: false; error: string }, took: number): void {
    if (this.ended) return;
    this.lastGemini = this.deps.now();
    // already answered (overtaken) or redone with a longer transcript: this one no longer counts
    if (!this.asking || this.asking.round !== round) {
      this.deps.log("pensiero_scartato", { ms: ms(took) });
      return;
    }
    this.asking = null;
    // the answer has arrived: Gemini is about to say it, the "you did not answer"
    // guard would double it (13/11, first call with the brain)
    this.awaitAnswer = null;
    const name = ASK_TOOL;
    if (r.ok) {
      const t = r.thought;
      this.deps.log("pensato", { ms: ms(took), di: t.say, affida: t.task, chiudi: t.close });
      this.lastThought = t.say ? { phrase, say: t.say, at: this.deps.now() } : null;
      const answer = (): void => {
        if (t.close) {
          this.hangupAsked ??= this.deps.now();
          this.deps.log("chiude_jarvis", { esito: null });
        }
        this.toolResponse(
          id,
          name,
          t.say ? `${this.persona.assistant} risponde: «${t.say}». Dillo adesso così, con naturalezza, senza aggiungere altro.` : `${this.persona.assistant} non ha niente da aggiungere: non dire niente.`,
        );
      };
      if (!t.task) return answer();
      this.out.handoffs += 1;
      void this.deps.handoff(t.task).then(
        () => {
          if (this.ended) return;
          this.waitingJobs += 1;
          this.deps.log("affidato", { compito: t.task });
          this.jobTask = t.task;
          this.jobAt = this.deps.now();
          this.stepLine = null;
          answer();
        },
        (err: unknown) => {
          if (this.ended) return;
          this.deps.log("affido_fallito", { compito: t.task, errore: err instanceof Error ? err.message : String(err) });
          answer();
        },
      );
      return;
    }
    // the brain does not answer: the phrase goes to the agent's chat, which has time and tools
    this.deps.log("pensiero_fallito", { ms: ms(took), errore: r.error });
    const task = `Al telefono ${this.persona.name} ti ha chiesto: «${phrase}». Rispondigli.`;
    this.out.handoffs += 1;
    const reply = `${this.persona.assistant} ci deve guardare: di' in tre parole che ci guardi e che ti fai sentire.`;
    void this.deps.handoff(task).then(
      () => {
        if (this.ended) return;
        this.waitingJobs += 1;
        this.deps.log("affidato", { compito: task });
        this.jobTask = task;
        this.jobAt = this.deps.now();
        this.stepLine = null;
        this.toolResponse(id, name, reply);
      },
      () => this.toolResponse(id, name, reply),
    );
  }

  // ─── the mouth and the quick voice ────────────────────────────────────────

  private onMouth(e: GeminiEvent): void {
    if (this.ended) return;
    switch (e.type) {
      case "gone":
        // without the mouth the recorded fillers remain: the call goes on the same
        this.deps.log("bocca_chiusa", {});
        this.mouth?.close();
        this.mouth = null;
        this.mouthReady = false;
        this.mouthLive = false;
        return;
      case "ready":
        this.mouthReady = true;
        return;
      case "audio":
        if (!this.mouthLive || this.generating) return;
        if (this.mouthWait) {
          this.ackedRound = this.mouthWait.round;
          const now = this.deps.now();
          this.deps.log("riconosciuto", { dopo_ms: ms(now - this.askedAt), bocca_ms: ms(now - this.mouthWait.at) });
          this.mouthWait = null;
        }
        this.play.push(this.mouthStretch.push(this.mouthRs.push(e.pcm)));
        return;
      case "generationDone":
      case "turnComplete":
        if (this.mouthLive) {
          this.play.push(this.mouthStretch.flush());
          this.play.turnDone = true;
        }
        this.mouthLive = false;
        return;
      default:
        return;
    }
  }

  // the quick voice's lines wait for a free moment (they still talking, the
  // assistant saying something else): dropping them left the call mute for 24 s
  // on a mail job (13/11, "I am waiting, you are not getting back to me")
  private onQuick(round: number, line: string | null, took: number): void {
    if (this.ended) return;
    this.deps.log("voce_veloce", { ms: ms(took), frase: line });
    if (line) this.ackLine = { round, line };
  }

  private onProgressLine(line: string | null): void {
    if (this.ended) return;
    this.progressAsking = false;
    if (line && line !== this.lastStepLine) this.stepLine = { line, at: this.deps.now() };
    else this.deps.log("passo_saltato", { frase: line });
  }

  // ─── what the channel says ────────────────────────────────────────────────

  /** the other side answered (outgoing call) */
  answered(): void {
    if (this.ended || this.answeredAt !== null) return;
    const now = this.deps.now();
    this.answeredAt = now;
    this.lastVoice = now;
    this.deps.log("risposto", { squilli_ms: ms(now - this.start) });
  }

  /** the agent's answer to a job handed off from this call */
  reply(t: string): void {
    if (this.ended) return;
    this.waitingJobs = Math.max(0, this.waitingJobs - 1);
    this.deps.log("risultato", { testo: [...t].slice(0, 300).join("") });
    this.dialog.push(`[Risultato di un lavoro affidato a ${this.persona.assistant}]`, [...t].slice(0, 1500).join(""));
    this.replies.push(t);
    this.replySince ??= this.deps.now();
  }

  /** the steps of the handed-off job in progress (one line per tool, from the start of the agent's turn) */
  progress(steps: string[]): void {
    if (this.ended) return;
    // a shorter list = a new turn of the agent has started
    if (steps.length < this.stepsSeen) this.stepsSeen = 0;
    const now = this.deps.now();
    const quick = this.deps.quick;
    if (
      steps.length > this.stepsSeen &&
      this.waitingJobs > 0 &&
      this.mouthReady &&
      !this.progressAsking &&
      now - this.progressSaid >= PROGRESS_EVERY &&
      now - this.jobAt >= PROGRESS_FROM &&
      quick
    ) {
      const fresh = steps.slice(Math.max(this.stepsSeen, steps.length - 4));
      this.stepsSeen = steps.length;
      this.progressAsking = true;
      void quick(progressPrompt(this.persona, this.jobTask, fresh)).then((l) => this.onProgressLine(l));
    }
  }

  /** the call is over from outside: they hung up, refused, the audio closed */
  endedByPeer(why: string): void {
    this.finish(why, false);
  }

  /** the service is stopping, or the channel's socket dropped */
  shutdown(): void {
    this.finish("servizio fermo", true);
  }

  // ─── the end ──────────────────────────────────────────────────────────────

  private finish(reason: string, ours: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.gem.close();
    this.mouth?.close();
    void this.epilogue(reason, ours).then((o) => this.resolveDone(o));
  }

  private async epilogue(reason: string, ours: boolean): Promise<Outcome> {
    const out = this.out;
    // what the other side was saying when the call dropped, without a closed turn
    if (this.heard.trim()) out.heard += this.heard.trim();
    out.heard = out.heard.trim();
    // on behalf: the outcome reports whisper's words. The ones in flight and the
    // last phrase left halfway are awaited (the callee hung up while talking), 3 s at most
    if (this.spec.direction.kind === "on_behalf" && this.deps.whisper) {
      this.collecting = true;
      if (this.utt.length >= (16000 * 4) / 10) {
        for (const s of this.utt) this.turnPcm.push(s);
        const seq = this.uttSeq + 1;
        this.turnOf.push({ seq, turn: this.turnId });
        const phrase = Int16Array.from(this.turnPcm);
        this.turnPcm = [];
        const p = this.deps.whisper(phrase).then((r) => {
          if (r.ok && r.text) this.onWhisper(seq, r.text);
        });
        this.whisperInFlight.add(p);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...this.whisperInFlight]), new Promise((r) => (timer = setTimeout(r, 3000)))]);
      clearTimeout(timer);
      this.collecting = false;
      if (this.whispered.length > 0) {
        const ws = [...this.whispered].sort((a, b) => a.seq - b.seq);
        const turn = (s: number): number | undefined => this.turnOf.find((t) => t.seq === s)?.turn;
        // whisper of the whole turn: the next phrase, in the same turn, already contains the one before
        const kept = ws.filter((w, i) => {
          const next = ws[i + 1];
          return next === undefined || turn(w.seq) !== turn(next.seq);
        });
        out.heard = kept.map((w) => w.text).join(" ");
      }
    }
    // with no answer there is nothing to hear: the empty file is removed
    if (this.rec) {
      try {
        const p = this.rec.finish();
        if (this.answeredAt !== null) out.recording = p;
        else (await import("node:fs")).unlinkSync(p);
      } catch {
        /* the recording failed: there is none */
      }
    }
    out.reason = reason;
    out.ours = ours;
    out.answered = this.answeredAt !== null;
    out.talkS = this.answeredAt === null ? 0 : Math.floor((this.deps.now() - this.answeredAt) / 1000);
    this.deps.log("fine", { motivo: out.reason, secondi: out.talkS, turni: out.turns, affidati: out.handoffs, usd: Math.round(usageUsd(out.usage) * 10000) / 10000 });
    return out;
  }
}

/**
 * Drives a call on the real clock: a tick every 20 ms, catching up in a burst
 * when the event loop was late (the Rust interval's `Burst`), so the other
 * phone keeps receiving real-time audio.
 */
export function runClock(call: Call, now: () => number = () => performance.now()): () => void {
  let next = now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = () => {
    if (stopped) return;
    const t = now();
    let n = 0;
    while (next <= t && n < 50) {
      call.tick();
      next += CLOCK_MS;
      n++;
    }
    // a stall longer than a second is not caught up: that audio is already old
    if (next <= t) next = t + CLOCK_MS;
    timer = setTimeout(loop, Math.max(0, next - now()));
  };
  loop();
  void call.done.then(() => (stopped = true));
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
