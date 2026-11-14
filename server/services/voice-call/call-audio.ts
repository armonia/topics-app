/**
 * The clock of a call and the other side's audio: the 60 ms tick of the Rust
 * loop (greeting, fillers, steps, results, closing) and the frames from the
 * phone (voice detector, barge-in, whisper). Every tick of the 60 ms clock
 * sends one frame to the phone, voice or background.
 */
import { FRAME, FRAME_MS, joinSamples } from "./audio/pcm";
import { echoOf } from "./audio/natural";
import { CallState } from "./call-state";
import {
  ACK_AFTER,
  ACK_FROM,
  ANSWER_MISSING,
  ACTION_WAIT,
  BARGE_FRAMES,
  CHECK_AUDIO_MS,
  CHECK_MAX,
  EAR_WAIT,
  EARLY_QUIET,
  FILLER_AFTER,
  FOLLOW_UP,
  GEMINI_MUTE,
  GREET_MAX,
  GREET_QUIET,
  GREET_SILENT,
  HELD_MAX,
  LATE_MIN_MS,
  onlyGreeting,
  IDLE,
  IDLE_WAITING,
  MAX_CALL,
  NAME_WAIT,
  PROGRESS_FROM,
  RING_MAX,
  STEP_GAP,
  STILL_THINKING,
  ms,
} from "./call-rules";
import { replyText } from "./prompts";

export abstract class CallAudio extends CallState {
  // ─── the clock ─────────────────────────────────────────────────────────────

  /** One tick of the 60 ms clock. */
  tick(): void {
    if (this.ended) return;
    this.step();
  }

  /** The 60 ms tick of the Rust loop. */
  protected step(): void {
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
      if (!this.deps.toPeer(frame)) return this.finish("audio chiuso", false);
      this.recorder?.said(frame);
    }
    const speaking = this.speaking();
    if (this.spec.group && speaking && (this.named || this.textTurn || this.playNamed)) this.addressedUntil = now + FOLLOW_UP;
    if (!speaking && !this.generating) this.playNamed = false;
    if (this.nameWait && now - this.nameWait.at > NAME_WAIT) {
      const audio = this.nameWait.audio;
      this.nameWait = null;
      this.dropRest = true;
      this.deps.log("non_per_jarvis", { sentito: this.heard.trim(), ms_non_detti: Math.floor(audio.reduce((a, b) => a + b.length, 0) / 16) });
    }
    if (this.released && !this.greeted && this.out.turns > 0 && !speaking && !this.generating) {
      this.greeted = true;
      if (this.lateHeld) this.passLate();
    }
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
      this.play.push(joinSamples(w.audio));
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

  protected spawnWhisper(seq: number, pcm: Int16Array): void {
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

  protected peerFrame(f: Int16Array): void {
    this.recorder?.heard(f);
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
    // over the greeting only words whisper confirms interrupt: a "Hello?" or the
    // echo of the greeting itself must not cut it (10/11)
    const canBarge = this.greeted || (this.deps.whisper !== null && !this.spec.group);
    if (speaking && !this.barged && canBarge && this.check === null && this.vad.barges(BARGE_FRAMES)) {
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
      const audio = joinSamples(this.held);
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
        if (!this.greeted && !this.spec.group && this.utt.length === 0 && this.held.length * FRAME_MS >= LATE_MIN_MS) {
          this.lateHeld = [...(this.lateHeld ?? []), ...this.held].slice(-HELD_MAX);
          this.deps.log("tenuto_per_dopo", { ms: this.held.length * FRAME_MS });
        } else if (this.utt.length === 0 && this.check === null && this.held.length > 0) {
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
      this.endPhrase(answered);
    }
  }

  /** The bookkeeping of a finished phrase: its turn, its whisper, the filler timer. */
  protected endPhrase(answered: boolean): void {
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

  /**
   * What was said over the greeting and ended before it: now that the greeting is
   * over it goes to Gemini as a phrase, unless whisper hears only the greeting's
   * own echo or a "Hello?". If the other is already talking again, the new phrase wins.
   */
  protected passLate(): void {
    const frames = this.lateHeld ?? [];
    this.lateHeld = null;
    if (frames.length === 0) return;
    const pass = (text: string | null) => {
      if (this.ended || this.vad.isOpen() || this.utt.length > 0) return this.deps.log("scartato_nel_saluto", { perche: "parla di nuovo", whisper: text });
      this.deps.log("detto_nel_saluto", { ms: frames.length * FRAME_MS, whisper: text });
      for (const f of frames) {
        for (const s of f) this.utt.push(s);
        this.send({ type: "audio", pcm: f });
      }
      this.send({ type: "streamEnd" });
      this.endPhrase(false);
    };
    const whisper = this.deps.whisper;
    if (!whisper) return pass(null);
    void whisper(joinSamples(frames)).then((r) => {
      const t = r.ok ? (r.text ?? "") : null;
      if (t !== null && (t.trim() === "" || onlyGreeting(t) || echoOf(this.said, t) || echoOf(this.prevSaid, t))) {
        return this.deps.log("scartato_nel_saluto", { perche: "eco o saluto", whisper: t });
      }
      pass(t);
    });
  }
}
