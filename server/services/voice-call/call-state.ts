/**
 * The state of a call and the moves every handler shares (cut, anchor, ask,
 * the mishearing hint): the fields of the Rust `run` loop, one by one, each
 * with the call that put it there. The clock lives in call-audio.ts, the
 * handlers in call.ts.
 */
import { Dialog, MOUTH, ackPrompt, system as brainSystem, userTurn, type Thought } from "./brain";
import { emptyUsage, type Cmd, type GeminiEvent } from "./gemini";
import { FRAME_MS, PlaybackQueue, FrameBuilder, Resampler, Vad } from "./audio/pcm";
import { Ambience, Stretch, heardWrong } from "./audio/natural";
import { Recorder } from "./audio/record";
import { groupOpening, groupPrompt, identity, opening, recordedNotice, systemPrompt, tools, voicePrompt, voiceTools, type LastThought, type VoicePersona } from "./prompts";
import { versoOf, type Ask, type CallDeps, type CallSpec, type CallOutcome, type WhisperResult } from "./call-rules";

export abstract class CallState {
  readonly done: Promise<CallOutcome>;
  protected resolveDone!: (o: CallOutcome) => void;
  protected ended = false;

  protected readonly brainOn: boolean;
  protected readonly brainSys: string;
  protected readonly dialog = new Dialog();
  protected readonly persona: VoicePersona;
  protected readonly gem: { send(c: Cmd): void; close(): void };
  protected mouth: { send(c: Cmd): void; close(): void } | null = null;

  // the questions to the brain in flight, and those overtaken by a new phrase:
  // the old answer is not said. On 13/11 two pieces of the same phrase left as
  // two questions and the assistant said two answers in a row.
  // The question in flight: tool id, generation, phrase, whisper phrase it refers
  // to. A new question closes the old one at once; a longer transcript of the
  // same phrase redoes it with the same id (13/11: it left with "ok", whisper
  // 0.3 s later said "this is a problem, so the conversation too").
  protected asking: Ask | null = null;
  protected askedAt: number;
  // the "mouth": same voice, second session, it says the quick voice's lines
  // (acknowledgement and steps of the job). mouthLive = the audio coming from it
  // is heard; it goes off when the main session talks or they interrupt it
  protected mouthLive = false;
  protected mouthReady = false;
  protected mouthRs = new Resampler();
  protected mouthStretch: Stretch;
  // the acknowledgement sent to the mouth for question `round`: it becomes "said" at the first audio
  protected mouthWait: { round: number; at: number } | null = null;
  protected ackedRound = 0;
  protected stillRound = 0;
  protected ackLine: { round: number; line: string } | null = null;
  protected stepLine: { line: string; at: number } | null = null;
  protected stepsSeen = 0;
  protected progressSaid: number;
  protected progressAsking = false;
  protected jobTask = "";
  protected jobAt: number;
  protected lastStepLine = "";
  protected askGen = 0;
  // the brain's last answer: Gemini sometimes calls the tool again with the same phrase instead of saying it
  protected lastThought: LastThought | null = null;

  protected readonly start: number;
  protected answeredAt: number | null;
  protected opened = false;
  // whoever answers talks first: the assistant when it is called (also when they call back), the other when the assistant calls
  protected readonly speaksFirst: boolean;
  protected heardAfterAnswer = false;
  // outgoing, the greeting is generated while it rings and starts after their
  // "Hello?": released = the assistant is heard and Gemini hears the other.
  // Waiting for Gemini after the "Hello?" left a second of silence, and the other
  // said "Hello?" again
  protected released = false;
  // until the greeting is all said the other's voice does not interrupt it: a "Hello?" said over it cut it (10/11)
  protected greeted = false;
  // what the other said over the greeting and finished before it did: passed to Gemini once the greeting is over
  protected lateHeld: Int16Array[] | null = null;
  // in a group: until when Gemini's answers are heard without the name; the
  // answer waiting for the name; the turn we asked for (greeting, result of a
  // job), which is always heard
  protected addressedUntil: number | null = null;
  protected nameWait: { at: number; audio: Int16Array[] } | null = null;
  protected textTurn = false;
  // the answer in progress is to a phrase with the name (or is our turn): only
  // that opens the follow-up without the name. Before, the follow-up was renewed
  // at every phrase of the assistant, even of a follow-up: in a group it answered
  // everything they said among themselves (12/11)
  protected named = false;
  protected playNamed = false;
  protected vad = new Vad();
  protected rs = new Resampler();
  protected play = new PlaybackQueue();
  protected chunks = new FrameBuilder();
  protected stretch: Stretch;
  protected amb = new Ambience();
  // the phrase being said, as it goes to Gemini: when it ends whisper hears it too
  protected utt: number[] = [];
  // the last closed turn: whisper also answers after Gemini has finished
  protected prevHeard = "";
  protected prevSaid = "";
  // end of the last phrase sent to Gemini and how long it was: the filler covers a long wait
  protected endAt: { at: number; ms: number; seq: number } | null = null;
  protected fillerAt: number | null = null;
  protected fillerN = 0;
  // a filler only after a real answer of Gemini: two "One moment" in a row with nothing in between (12/11)
  protected fillerArmed = true;
  // every phrase sent to Gemini has a number; whisper says if it was voice
  // (words) or not: the filler only after real voice. Without it, with music on,
  // fillers started on nothing, and the phone sent them back (12/11)
  protected uttSeq = 0;
  protected uttVoice = 0;
  // the phrase Gemini is answering: if it starts while the other still talks
  // (our gate closes after its), it is the one in progress, not the last closed
  // one. Comparing the answer with the whisper of the phrase before made fake
  // corrections that cut right answers (12/11 evening, 4 in 7)
  protected answerSeq = 0;
  // the current answer has already fixed its phrase: Gemini's transcript (said) sometimes arrives before the audio
  protected anchored = false;
  // the phrase in progress when Gemini started answering is part of the turn it
  // answers: the turn is emptied after it ends, not before (otherwise whisper of
  // a split phrase would hear only its second half)
  protected clearAfterEnd = false;
  // the start of the answer held a moment until whisper says what they said: if
  // Gemini misheard it is dropped before it is heard. Without it, "I did not
  // understand, can you repeat?" was heard and then the right answer (13/11, 12
  // scenarios in 21). At most EAR_WAIT, then it goes anyway
  protected earWait: { at: number; audio: Int16Array[] } | null = null;
  protected earChecked = 0;
  // Gemini actions that arrived before whisper wait for its verdict (a medical
  // term handed off as a task, 13/11). They come back into the event loop from here
  protected deferred: { at: number; e: GeminiEvent }[] = [];
  protected deferredIds = new Set<string>();
  // a finished phrase Gemini does not answer: after ANSWER_MISSING whisper's
  // text is sent to it. And a Gemini that does not close the turn after an
  // interruption keeps "generating" on forever: no results, no answers (13/11, a
  // test call mute for 20 s)
  protected awaitAnswer: { at: number; seq: number } | null = null;
  protected lastGemini: number;
  // whisper starts after EARLY_QUIET of silence, not at the end of the phrase:
  // the gate closes after 1 s, Gemini answers after 0.7, and whisper almost
  // always arrived after the start of the answer (13/11: 40 waits in 46 expired).
  // If they do not start talking again, at the end of the phrase it is not redone
  protected earlySeq = 0;
  protected voicedAfterEarly = false;
  // interruption to confirm: a loud sound while the assistant talks pauses it at
  // once (like someone hesitating), and silences it only if whisper hears words
  // in it that are not its echo. Music at voice volume silenced it (12/11)
  protected check: { seq: number; at: number; sent: boolean } | null = null;
  protected checkSeq = 0;
  protected paused = false;
  protected musicUntil: number | null = null;
  // they asked to close: their "bye, you too" after that no longer cancel the
  // close (12/11: four rounds of goodbyes and at the end "close the call",
  // because each of their words cancelled it)
  protected leave = false;
  // the last phrase as whisper heard it, and the last one for which Gemini was already corrected
  protected wtext: { seq: number; text: string } | null = null;
  protected hinted = 0;
  // every phrase as whisper heard it: in the outcome on behalf they count more
  // than Gemini's, which gets wrong exactly what matters (12/11)
  protected whispered: { seq: number; text: string }[] = [];
  // voice said over the assistant, held until it is clear whether it is an interruption or an echo
  protected held: Int16Array[] = [];
  protected barged = false;
  // after an interruption the rest of the answer Gemini is still generating must not be said
  protected generating = false;
  protected dropRest = false;
  protected pendingFrame: Int16Array | null = null;
  protected lastVoice: number;
  // the caller's last voiced frame, and when Gemini finished its last answer: the
  // latency is measured from the end of the question to the first audio of the answer
  protected spokeAt: number | null = null;
  protected answerDoneAt: number;
  // the results of handed-off jobs wait for a moment of silence: a text sent to Gemini while the assistant talks cuts it mid-phrase
  protected replies: string[] = [];
  // since when the first queued result waits: on 12/11 one left 30 s later, with no why in the log
  protected replySince: number | null = null;
  // everything they said since Gemini's last answer: the gate splits "Dimmi
  // tutto" in two pieces under 400 ms, and whisper on the piece alone never  allow-italian: the quoted phrase is the real one
  // started (12/11). Gemini hears the whole turn, whisper must hear the same
  protected turnPcm: number[] = [];
  // which turn each phrase sent to whisper belongs to: in the report only the longest transcript of each turn stays
  protected turnId = 0;
  protected turnOf: { seq: number; turn: number }[] = [];
  // the hang-up tool: Gemini may call it before or after the goodbye. It closes at turn end with the goodbye said (or after 8 s)
  protected hangupAsked: number | null = null;
  protected hangupWhenSaid = false;
  protected waitingJobs = 0;
  protected heard = "";
  protected said = "";
  // how much of the current answer was pushed to the phone (ms), and the part
  // of its text they really heard when they interrupted it: the brain must not
  // believe they heard the rest (it would build on things never said)
  protected answerMs = 0;
  protected saidHeard: string | null = null;
  // the last moment either side made a sound: the silence that asks "are you still there?" counts from here
  protected lastSound: number;
  protected askedStillThere = false;
  protected jobNotes = 0;
  protected jobNoteAt = 0;
  protected idleBye = false;
  protected readonly out: CallOutcome;
  protected recorder: Recorder | null = null;
  protected openText: string;
  protected reinjected: GeminiEvent[] = [];
  protected whisperInFlight = new Set<Promise<unknown>>();
  protected collecting = false;

  constructor(protected readonly spec: CallSpec, protected readonly deps: CallDeps) {
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
    this.lastSound = now;
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
    let instructions = this.brainOn
      ? voicePrompt(this.persona, deps.spokenNow, g.speaksWhileThinking)
      : `${systemPrompt(this.persona, d, deps.spokenNow)}\n${identity(g.model, this.persona)}`;
    if (d.kind !== "on_behalf") {
      instructions += `\nLa tua voce oggi va a velocità ${spec.speed.toFixed(2)}: se ti chiede di parlare più veloce o più piano chiama velocita, e poi conferma in due parole.`;
    }
    if (spec.group) instructions += `\n${groupPrompt(this.persona)}`;
    const gemTools = this.brainOn ? voiceTools(this.persona, g.speaksWhileThinking) : tools(d, this.persona);
    this.gem = deps.openGemini({ ...voice, system: instructions, tools: gemTools }, (e) => this.onGemini(e));

    if (spec.record) {
      try {
        this.recorder = Recorder.create(spec.record);
      } catch (e) {
        deps.log("registrazione_fallita", { errore: e instanceof Error ? e.message : String(e) });
      }
    }
    const prev = this.brainOn ? (spec.previous ?? null) : null;
    if (prev) {
      this.dialog.lines.push(`[La telefonata di ${prev.agoMin} minuti fa${prev.dropped ? ", caduta senza saluti" : ""}]`, ...prev.lines, "[Questa telefonata]");
    }
    this.openText = spec.group ? groupOpening(this.persona) : opening(this.persona, d, prev?.dropped === true);
    // whoever does not know they are talking to a recorded assistant hears it at once, does not find out later
    if (this.recorder && d.kind === "on_behalf") this.openText += recordedNotice(this.persona);
  }

  protected send(c: Cmd): void {
    this.gem.send(c);
  }

  protected speaking(): boolean {
    return this.play.isPlaying() || this.pendingFrame !== null;
  }

  // ─── the assistant really goes quiet: what is left of the answer is dropped, and the held voice goes to Gemini
  protected cut(ev: string): void {
    this.barged = true;
    this.check = null;
    this.paused = false;
    const notSaid = Math.floor(this.play.clear() / 16) + (this.pendingFrame !== null ? FRAME_MS : 0);
    this.pendingFrame = null;
    this.stretch.reset();
    this.mouthLive = false;
    this.mouthStretch.reset();
    this.dropRest = this.generating;
    // the text runs ahead of the voice: only the share of the answer played out was heard
    const words = this.said.trim().split(/\s+/).filter(Boolean);
    if (words.length > 0 && this.answerMs > 0) {
      const share = Math.max(0, Math.min(1, (this.answerMs - notSaid) / this.answerMs));
      const kept = words.slice(0, Math.round(words.length * share)).join(" ");
      this.saidHeard = kept ? `${kept}… (interrotto qui: il resto non l'ha sentito)` : "(interrotto prima che sentisse qualcosa)";
    }
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
  protected anchor(): void {
    if (this.anchored) return;
    this.anchored = true;
    this.answerSeq = this.utt.length === 0 ? this.uttSeq : this.uttSeq + 1;
    if (this.utt.length > 0) this.clearAfterEnd = true;
    else if (this.turnPcm.length > 0) {
      this.turnPcm = [];
      this.turnId += 1;
    }
  }

  protected ask(id: string, phrase: string, heard: string): void {
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

  protected tryHint(): void {
    const w = this.wtext;
    if (!w || w.seq !== this.answerSeq || this.hinted === w.seq || this.spec.group || this.hangupAsked !== null) return;
    // two cases: Gemini asks to repeat (its transcript may already be in
    // prevHeard), or it is already answering a phrase whisper heard differently.
    // The second is judged only once the answer has started, when Gemini's
    // transcript is whole: a half one would look wrong.
    // On 12/11 "Dimmi tutto" was heard as English, then an empty answer, 3 times in 3 also outside the call  allow-italian: the quoted phrase is the real one
    const source = (this.said.trim() === "" ? this.prevSaid : this.said).toLowerCase();
    const asksRepeat = ["ripet", "non ho capito", "non ti sento", "in italiano", "sentito male"].some((p) => source.includes(p));
    const answering = !this.textTurn && (this.said.trim() !== "" || this.earWait !== null) && this.heard.trim() !== "";
    const g = this.heard.trim() === "" ? this.prevHeard : this.heard;
    // with the brain the phrase already reaches it as whisper heard it:
    // correcting Gemini relaunched the same question, and the assistant said two
    // answers in a row (13/11)
    if ((asksRepeat || answering) && !this.brainOn && heardWrong(g, w.text)) {
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

  // the handlers the call implements (call.ts): the state only routes to them
  protected abstract onGemini(e: GeminiEvent): void;
  protected abstract onMouth(e: GeminiEvent): void;
  protected abstract onQuick(round: number, line: string | null, took: number): void;
  protected abstract onThought(id: string, round: number, phrase: string, r: { ok: true; thought: Thought } | { ok: false; error: string }, took: number): void;
  protected abstract onWhisper(seq: number, w: string): void;
  protected abstract onCheck(seq: number, w: WhisperResult): void;
  protected abstract reinject(e: GeminiEvent): void;
  protected abstract finish(reason: string, ours: boolean): void;
}
