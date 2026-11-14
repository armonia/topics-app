/**
 * A phone call with the assistant: the caller's voice goes to Gemini Live only
 * when they speak (silence would be billed), Gemini's voice goes back to the
 * phone one 60 ms frame at a time. Gemini generates 3-5 times faster than real time, so
 * the interruption is decided here: 240 ms of voice while the assistant talks
 * are enough to silence it. What Gemini cannot do alone it hands to the agent
 * as a message of the owner; the answer arrives in the chat as always and, if
 * the call is still open, Gemini tells it aloud.
 *
 * Ported from jarvis-channels `src/voice/call.rs` (commit 80f1fd26) as a state
 * machine: each branch of the Rust `select!` is a method here, the 60 ms tick is
 * `step()`, run at every tick of the 60 ms clock the bridge drives. Every
 * dated note is a real call that went wrong; the log event names are the same,
 * because the bench and the channel read them.
 */
import { unlinkSync } from "node:fs";
import { progressPrompt, type Thought } from "./brain";
import { ASK_TOOL, addUsage, usageUsd, type GeminiEvent } from "./gemini";
import { joinSamples } from "./audio/pcm";
import { clampSpeed, echoOf, heardWrong } from "./audio/natural";
import { asksToLeave, namesAssistant, repeatedQuestion } from "./prompts";
import { CallAudio } from "./call-audio";
import { CLOCK_MS, FOLLOW_UP, onlyGreeting, MUSIC_HOLD, PROGRESS_EVERY, PROGRESS_FROM, ms, type CallOutcome, type WhisperResult } from "./call-rules";

export * from "./call-rules";

export class Call extends CallAudio {
  // ─── Gemini ───────────────────────────────────────────────────────────────

  /** Events put back into the loop (deferred actions, the anchored ask): handled after the current one. */
  protected reinject(e: GeminiEvent): void {
    this.reinjected.push(e);
    queueMicrotask(() => {
      const next = this.reinjected.shift();
      if (next) this.onGemini(next);
    });
  }

  protected onGemini(e: GeminiEvent): void {
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
        if (this.nameWait) this.nameWait.audio.push(pcm);
        else if (!open) this.nameWait = { at: now, audio: [pcm] };
        else if (this.earWait) this.earWait.audio.push(pcm);
        else if (pending && this.earChecked !== this.answerSeq) {
          this.earChecked = this.answerSeq;
          this.earWait = { at: now, audio: [pcm] };
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
          if (this.nameWait) this.nameWait.audio.push(tail);
          else if (this.earWait) this.earWait.audio.push(tail);
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
          if (this.nameWait) this.nameWait.audio.push(tail);
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
            this.play.push(joinSamples(this.nameWait.audio));
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

  protected toolResponse(id: string, name: string, result: string): void {
    if (!this.ended) this.send({ type: "toolResponse", id, name, result });
  }

  protected onTool(e: Extract<GeminiEvent, { type: "toolCall" }>): void {
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
      heardWrong(this.heard, this.wtext.text)
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
      const report = typeof args.esito === "string" ? args.esito.trim() : "";
      if (report) this.out.report = [...report].slice(0, 1000).join("");
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

  protected onCheck(seq: number, w: WhisperResult): void {
    if (this.ended || this.check?.seq !== seq) return;
    if (!this.greeted && w.ok && w.text !== null && onlyGreeting(w.text)) {
      // "Hello?" over the greeting: it goes on, and the hello needs no answer
      this.check = null;
      this.paused = false;
      this.held = [];
      this.deps.log("saluto_sopra", { whisper: w.text });
      return;
    }
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

  protected onWhisper(seq: number, w: string): void {
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
      this.play.push(joinSamples(e.audio));
    }
    for (const d of this.deferred.splice(0)) this.reinject(d.e);
  }

  // ─── the brain ────────────────────────────────────────────────────────────

  protected onThought(id: string, round: number, phrase: string, r: { ok: true; thought: Thought } | { ok: false; error: string }, took: number): void {
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
      const answer = (): void =>
        this.toolResponse(
          id,
          name,
          t.say ? `${this.persona.assistant} risponde: «${t.say}». Dillo adesso così, con naturalezza, senza aggiungere altro.` : `${this.persona.assistant} non ha niente da aggiungere: non dire niente.`,
        );
      // the close is decided now; the tool answer waits for the handoff, as the Rust one did synchronously
      if (t.close) {
        this.hangupAsked ??= this.deps.now();
        this.deps.log("chiude_jarvis", { esito: null });
      }
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

  protected onMouth(e: GeminiEvent): void {
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
  protected onQuick(round: number, line: string | null, took: number): void {
    if (this.ended) return;
    this.deps.log("voce_veloce", { ms: ms(took), frase: line });
    if (line) this.ackLine = { round, line };
  }

  protected onProgressLine(line: string | null): void {
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

  protected finish(reason: string, ours: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.gem.close();
    this.mouth?.close();
    void this.epilogue(reason, ours).then((o) => this.resolveDone(o));
  }

  protected async epilogue(reason: string, ours: boolean): Promise<CallOutcome> {
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
    if (this.recorder) {
      try {
        const p = this.recorder.finish();
        if (this.answeredAt !== null) out.recording = p;
        else unlinkSync(p);
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
 * Drives a call on the real clock: a tick every 60 ms, catching up in a burst
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
