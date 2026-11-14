/**
 * The call loop against a fake Gemini, with the rules of jarvis-channels `call.rs`
 * and its tests (prompts, tools, the same question asked twice, the step dropped
 * while the caller talks).
 * @covers CALL-04
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { World } from "./call.testkit";
import { asksToLeave, identity, namesAssistant, opening, repeatedQuestion, replyText, systemPrompt, tools, voiceTools } from "./prompts";

const P = { name: "Ada", assistant: "Jarvis", org: "", channel: "WhatsApp", agentLabel: "Claude di Anthropic" };
const names = (t: { functionDeclarations: { name: string }[] }[]) => t[0]!.functionDeclarations.map((f) => f.name);

describe("call prompts", () => {
  test("a request to leave is recognised without gemini", () => {
    for (const t of ["Vabbè, Jarvis, chiudi la chiamata.", "Jarvis, disconnettiti.", "Esci dalla chiamata.", "Jarvis esci pure", "Va bene, chiuditi.", "ok, puoi chiudere"]) {
      expect(asksToLeave(t)).toBe(true);
    }
    for (const t of ["Ok, ma un consulente può prendersi la responsabilità?", "non chiudere ancora", "Jarvis, ci senti?"]) expect(asksToLeave(t)).toBe(false);
  });

  test("the name is heard however the phone mangles it", () => {
    for (const t of ["Ehi Jarvis, quanto fa?", "giarvis senti", "Jervis!", "ok Yarvis", "Jarbis, mandami la mail"]) expect(namesAssistant(t, "Jarvis")).toBe(true);
    for (const t of ["Ciao Mario, come stai?", "pasa a cerrar", "il servizio è pronto", "Ada, dimmi"]) expect(namesAssistant(t, "Jarvis")).toBe(false);
    // another assistant name is matched as written
    expect(namesAssistant("Ehi Friday, ci sei?", "Friday")).toBe(true);
  });

  test("the assistant opens the call with the reason it called for", () => {
    expect(opening(P, { kind: "incoming" })).toContain("Ciao Ada, dimmi");
    expect(opening(P, { kind: "outgoing", reason: "la riunione delle 15 è spostata alle 16" })).toContain("la riunione delle 15 è spostata alle 16");
    expect(opening(P, { kind: "outgoing", reason: " " })).toContain("cosa gli serve");
  });

  test("the tools are the handoff, the hang up and the speed; with the brain the ask tool replaces the handoff", () => {
    expect(names(tools({ kind: "incoming" }, P))).toEqual(["affida_a_jarvis", "chiudi_chiamata", "velocita"]);
    expect(systemPrompt(P, { kind: "incoming" }, "sabato")).toContain("chiudi_chiamata");
    expect(names(voiceTools(P, false))).toEqual(["chiedi_a_jarvis", "chiudi_chiamata", "velocita"]);
    expect((voiceTools(P, true)[0].functionDeclarations[0] as { behavior?: string }).behavior).toBe("NON_BLOCKING");
  });

  test("the voice says which model it is", () => {
    const i = identity("gemini-3.8-live", P);
    expect(i.includes("gemini-3.8-live") && i.includes("Google") && i.includes("Claude di Anthropic")).toBe(true);
  });

  test("whoever the assistant calls on behalf cannot give it tasks and hears who is calling", () => {
    const d = { kind: "on_behalf" as const, callee: "Mamma", message: "chiedile come sta", callback: false };
    expect(names(tools(d, P))).toEqual(["chiudi_chiamata"]);
    const p = systemPrompt(P, d, "sabato");
    expect(p.includes("per conto di Ada") && p.includes("chiedile come sta") && !p.includes("affida_a_jarvis")).toBe(true);
    expect(opening(P, d)).toContain("l'assistente di Ada");
  });

  test("no name of a person is in the prompts unless the call brings it", () => {
    const all = [systemPrompt(P, { kind: "incoming" }, "x"), identity("m", { ...P, agentLabel: "" }), opening(P, { kind: "incoming" })].join(" ");
    expect(all).not.toMatch(/Attilio|Armonia|Roma|jarvis-channels/);
  });

  test("the same question right after the answer gets the same answer", () => {
    // the call of 13/11 evening: a phrase asked again by Gemini 1 s after the answer
    const t0 = 1000;
    const last = { phrase: "Tu ti sei ripetuto.", say: "Hai ragione, scusa.", at: t0 };
    expect(repeatedQuestion(last, "Tu ti sei ripetuto. ", t0 + 1000)).toContain("«Hai ragione, scusa.»");
    // another phrase, or the same much later, is thought again
    expect(repeatedQuestion(last, "E il preventivo?", t0 + 1000)).toBeNull();
    expect(repeatedQuestion(last, "Tu ti sei ripetuto.", t0 + 11_000)).toBeNull();
    expect(repeatedQuestion(null, "Tu ti sei ripetuto.", t0)).toBeNull();
  });

  test("a long result is cut before it reaches the voice, and asks for two or three phrases", () => {
    const r = replyText("x".repeat(10_000), P);
    expect([...r].length).toBeLessThan(3500);
    expect(r).toContain("in due o tre frasi");
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("call loop", () => {
  test("an incoming call greets first, then streams the voice on the 60 ms clock", async () => {
    const w = new World();
    expect(w.events()[0]).toBe("inizio");
    w.main.emit({ type: "ready", resumed: false });
    expect(w.main.texts()[0]).toContain("Ciao Ada, dimmi");
    w.geminiSays(400, "Ciao Ada, dimmi.", { turn: true });
    await w.advance(600);
    // one 960-sample frame per tick, never more
    expect(w.chunks.length).toBe(10);
    expect(w.chunks.every((c) => c.length === 960)).toBe(true);
    expect(w.voicedMs(600)).toBeGreaterThanOrEqual(400);
    expect(w.first("turno")?.data).toEqual({ sentito: "", detto: "Ciao Ada, dimmi." });
  });

  test("generationComplete frees the assistant: a result goes out without waiting for the turn end", async () => {
    const w = new World();
    await w.greet();
    w.call.reply("Fatto: quattro riunioni e due scadenze.");
    // Gemini is still busy on another answer, which it finishes generating but whose turn it never closes
    w.geminiSays(300, "Un attimo.", { turn: false });
    await w.advance(1200);
    expect(w.has("risultato_a_gemini")).toBe(true);
    expect(w.has("gemini_muto")).toBe(false);
    expect(w.main.texts().at(-1)).toContain("quattro riunioni");
  });

  test("a step ready while the caller talks is dropped, and is not said in the pause after", async () => {
    const w = new World({ brain: true, quick: true });
    await w.greet();
    w.main.emit({ type: "toolCall", id: "c1", name: "chiedi_a_jarvis", args: { frase: "leggi la posta" } });
    await w.flush();
    w.thinks[0]!.resolve({ ok: true, thought: { say: "Ci guardo subito.", task: "leggi la posta", close: false } });
    w.quicks[0]!.resolve(null);
    await w.flush();
    expect(w.handed).toEqual(["leggi la posta"]);
    w.main.emit({ type: "turnComplete" });
    await w.advance(8000);
    // the caller starts correcting the job; the steps arrive while they talk
    w.say(2000);
    await w.advance(600);
    w.call.progress(["Bash: gws-mail gmail +triage"]);
    await w.flush();
    w.quicks[1]!.resolve("Sto aprendo la tua posta.");
    await w.advance(2400);
    // Gemini answers the phrase; the pause after its answer looks free
    w.geminiSays(500, "Ok.", { turn: true });
    await w.advance(4000);
    expect(w.log.filter((l) => l.event === "passo_saltato").map((l) => l.data.frase)).toContain("Sto aprendo la tua posta.");
    expect(w.has("passo_detto")).toBe(false);
  });

  test("a step ready on a quiet line is said by the mouth", async () => {
    const w = new World({ brain: true, quick: true });
    await w.greet();
    w.main.emit({ type: "toolCall", id: "c1", name: "chiedi_a_jarvis", args: { frase: "leggi la posta" } });
    await w.flush();
    w.thinks[0]!.resolve({ ok: true, thought: { say: "Ci guardo subito.", task: "leggi la posta", close: false } });
    w.quicks[0]!.resolve(null);
    await w.flush();
    w.main.emit({ type: "turnComplete" });
    await w.advance(8000);
    w.call.progress(["Bash: gws-mail gmail +triage"]);
    await w.flush();
    w.quicks[1]!.resolve("Sto aprendo la tua posta.");
    await w.advance(200);
    expect(w.first("passo_detto")?.data.frase).toBe("Sto aprendo la tua posta.");
    expect(w.mouth!.texts()).toContain("Sto aprendo la tua posta.");
  });

  test("the same question asked again right after the answer is not thought twice", async () => {
    const w = new World({ brain: true });
    await w.greet();
    w.main.emit({ type: "toolCall", id: "c1", name: "chiedi_a_jarvis", args: { frase: "Tu ti sei ripetuto." } });
    await w.flush();
    expect(w.first("chiesto")?.data.frase).toBe("Tu ti sei ripetuto.");
    w.thinks[0]!.resolve({ ok: true, thought: { say: "Hai ragione, scusa.", task: "", close: false } });
    await w.flush();
    expect(w.main.toolResponses().at(-1)?.result).toContain("«Hai ragione, scusa.»");
    w.main.emit({ type: "turnComplete" });
    await w.advance(1000);
    w.main.emit({ type: "toolCall", id: "c2", name: "chiedi_a_jarvis", args: { frase: "Tu ti sei ripetuto." } });
    await w.flush();
    expect(w.has("domanda_doppia")).toBe(true);
    expect(w.thinks.length).toBe(1);
    expect(w.main.toolResponses().at(-1)).toMatchObject({ id: "c2", name: "chiedi_a_jarvis" });
    expect(w.main.toolResponses().at(-1)?.result).toContain("che hai già");
  });

  test("a new phrase overtakes the question in flight, and the old answer is not said", async () => {
    const w = new World({ brain: true });
    await w.greet();
    w.main.emit({ type: "toolCall", id: "c1", name: "chiedi_a_jarvis", args: { frase: "Vabbè" } });
    await w.flush();
    w.main.emit({ type: "turnComplete" });
    w.main.emit({ type: "toolCall", id: "c2", name: "chiedi_a_jarvis", args: { frase: "questo è un problema" } });
    await w.flush();
    expect(w.has("pensiero_superato")).toBe(true);
    expect(w.main.toolResponses()[0]).toMatchObject({ id: "c1", result: "Superata da una sua frase nuova: non dire niente." });
    w.thinks[0]!.resolve({ ok: true, thought: { say: "vecchia", task: "", close: false } });
    await w.flush();
    expect(w.has("pensiero_scartato")).toBe(true);
  });

  test("the quick voice acknowledges in tone through the mouth when the line is free", async () => {
    const w = new World({ brain: true, quick: true });
    await w.greet();
    w.main.emit({ type: "toolCall", id: "c1", name: "chiedi_a_jarvis", args: { frase: "vedi le mail" } });
    await w.flush();
    w.quicks[0]!.resolve("Ok, apro le mail.");
    await w.advance(120);
    expect(w.first("voce_veloce_detta")?.data.frase).toBe("Ok, apro le mail.");
    expect(w.mouth!.texts()).toEqual(["Ok, apro le mail."]);
    w.mouth!.emit({ type: "audio", pcm: new Int16Array(4800).fill(3000) });
    expect(w.has("riconosciuto")).toBe(true);
  });

  test("the brain that does not answer hands the phrase to the agent's chat", async () => {
    const w = new World({ brain: true });
    await w.greet();
    w.main.emit({ type: "toolCall", id: "c1", name: "chiedi_a_jarvis", args: { frase: "qual è il prezzo?" } });
    await w.flush();
    w.thinks[0]!.resolve({ ok: false, error: "tempo scaduto" });
    await w.flush();
    expect(w.events()).toContain("pensiero_fallito");
    expect(w.handed).toEqual(["Al telefono Ada ti ha chiesto: «qual è il prezzo?». Rispondigli."]);
    expect(w.main.toolResponses().at(-1)?.result).toContain("ci deve guardare");
  });

  test("talking over the assistant silences it, and the held voice reaches gemini", async () => {
    const w = new World();
    await w.greet();
    w.geminiSays(3000, "Allora, la storia di Roma comincia...", { turn: false });
    await w.advance(300);
    expect(w.voicedMs(200)).toBeGreaterThan(0);
    w.say(800);
    await w.advance(500);
    expect(w.first("interrotto")?.data.ms_non_detti).toBeGreaterThan(1000);
    await w.advance(200);
    expect(w.voicedMs(200)).toBe(0);
    expect(w.main.audioSamples()).toBeGreaterThan(0);
  });

  // 14/11, Attilio: "it does not listen to what I say when I answer or while it starts the
  // first sentence". Over the greeting nothing could interrupt, and a phrase that ended
  // before the greeting did was thrown away (2.4 s of his voice, logged as dropped).
  async function greetingPlaying(w: World): Promise<void> {
    w.main.emit({ type: "ready", resumed: false });
    await w.advance(60);
    w.geminiSays(8000, "Ciao Ada, ti chiamo per dirti che la riunione di domani è spostata alle dieci", { turn: true });
    await w.advance(300);
  }

  test("words said over the greeting interrupt it, once whisper confirms them", async () => {
    const w = new World({ whisper: true });
    await greetingPlaying(w);
    w.say(900);
    await w.advance(1000);
    expect(w.has("forse_interrotto")).toBe(true);
    w.whispers.at(-1)!.resolve({ ok: true, text: "aspetta, sono in macchina" });
    await w.advance(100);
    expect(w.events()).toContain("interrotto");
    expect(w.main.audioSamples()).toBeGreaterThan(0);
  });

  test("a hello said over the greeting does not cut it", async () => {
    const w = new World({ whisper: true });
    await greetingPlaying(w);
    w.say(900);
    await w.advance(1000);
    w.whispers.at(-1)!.resolve({ ok: true, text: "Pronto?" });
    await w.advance(200);
    expect(w.has("interrotto")).toBe(false);
    expect(w.has("saluto_sopra")).toBe(true);
    expect(w.voicedMs(180)).toBeGreaterThan(0);
  });

  test("a phrase that ends during the greeting reaches Gemini after it, not the bin", async () => {
    const w = new World();
    await greetingPlaying(w);
    w.say(800);
    await w.advance(2000);
    expect(w.has("scartato_mentre_parlava")).toBe(false);
    const before = w.main.audioSamples();
    await w.advance(7000);
    expect(w.has("detto_nel_saluto")).toBe(true);
    expect(w.main.audioSamples() - before).toBeGreaterThanOrEqual(800 * 16 * 0.8);
    expect(w.main.sent.some((c) => c.type === "streamEnd")).toBe(true);
  });

  test("with whisper, a held echo of the greeting is dropped after it", async () => {
    const w = new World({ whisper: true });
    await greetingPlaying(w);
    w.say(500);
    await w.advance(2000);
    const before = w.main.audioSamples();
    await w.advance(7000);
    w.whispers.at(-1)!.resolve({ ok: true, text: "la riunione di domani è spostata" });
    await w.advance(100);
    expect(w.has("detto_nel_saluto")).toBe(false);
    expect(w.main.audioSamples()).toBe(before);
  });

  test("with whisper a loud sound only pauses: an echo resumes, words interrupt", async () => {
    const w = new World({ whisper: true });
    await w.greet();
    w.geminiSays(6000, "Ti stavo dicendo che oggi il meteo è stato molto variabile", { turn: false });
    await w.advance(300);
    w.say(900);
    await w.advance(1000);
    expect(w.first("forse_interrotto")?.data.in_pausa).toBe(true);
    expect(w.whispers.length).toBe(1);
    w.whispers[0]!.resolve({ ok: true, text: "il meteo è stato molto variabile" });
    await w.advance(100);
    expect(w.has("non_era_voce")).toBe(true);
    expect(w.has("interrotto")).toBe(false);
    // the next loud sound within MUSIC_HOLD does not pause, and words cut it
    await w.advance(1500);
    w.say(900);
    await w.advance(1000);
    expect(w.log.filter((l) => l.event === "forse_interrotto").at(-1)?.data.in_pausa).toBe(false);
    w.whispers.at(-1)!.resolve({ ok: true, text: "aspetta basta" });
    await w.advance(100);
    expect(w.events()).toContain("voce_confermata");
    expect(w.events()).toContain("interrotto");
  });

  // 10-14/11: 6 of the 17 interruptions whisper confirmed were "ah", "Ok", "va bene", "eccoci"
  test("a 'mh, va bene' said over the assistant does not stop it; an 'ok ma' does", async () => {
    const w = new World({ whisper: true });
    await w.greet();
    w.geminiSays(8000, "Ti spiego come funziona il preventivo, sono tre parti", { turn: false });
    await w.advance(300);
    w.say(900);
    await w.advance(1000);
    w.whispers.at(-1)!.resolve({ ok: true, text: "Mh, va bene." });
    await w.advance(200);
    expect(w.has("solo_ascolto")).toBe(true);
    expect(w.has("interrotto")).toBe(false);
    expect(w.voicedMs(180)).toBeGreaterThan(0);
    await w.advance(1500);
    w.say(900);
    await w.advance(1000);
    w.whispers.at(-1)!.resolve({ ok: true, text: "ok ma" });
    await w.advance(100);
    expect(w.events()).toContain("interrotto");
  });

  test("an interrupted answer reaches the brain only as far as it was heard", async () => {
    const w = new World({ brain: true });
    await w.greet();
    w.geminiSays(6000, "uno due tre quattro cinque sei sette otto nove dieci", { turn: false });
    await w.advance(1200);
    w.say(800);
    await w.advance(600);
    expect(w.has("interrotto")).toBe(true);
    w.main.emit({ type: "turnComplete" });
    await w.advance(1500);
    const part = String(w.first("sentito_in_parte")?.data.detto);
    expect(part).toContain("uno");
    expect(part).not.toContain("dieci");
    w.main.emit({ type: "heard", text: "aspetta" });
    w.main.emit({ type: "toolCall", id: "c1", name: "chiedi_a_jarvis", args: { frase: "aspetta" } });
    await w.advance(100);
    const user = String(w.thinks.at(-1)!.args[1]);
    expect(user).toContain("interrotto qui");
    expect(user).not.toContain("nove dieci");
  });

  test("after half a minute of silence it asks once if they are still there", async () => {
    const w = new World();
    await w.greet();
    await w.advance(29_000);
    expect(w.has("ci_sei")).toBe(false);
    await w.advance(2000);
    expect(w.main.texts().filter((t) => t.includes("se c'è ancora")).length).toBe(1);
    w.geminiSays(600, "Ci sei ancora?", { turn: true });
    await w.advance(40_000);
    expect(w.log.filter((l) => l.event === "ci_sei").length).toBe(1);
  });

  test("a call silent for minutes says goodbye before it closes, and their voice cancels the goodbye", async () => {
    const w = new World();
    await w.greet();
    await w.advance(181_000);
    expect(w.has("silenzio_saluta")).toBe(true);
    expect(w.has("fine")).toBe(false);
    w.say(700);
    await w.advance(1500);
    expect(w.has("chiusura_annullata")).toBe(true);
    await w.advance(10_000);
    expect(w.has("fine")).toBe(false);
    await w.advance(181_000);
    w.geminiSays(800, "Ok, ti lascio. Ciao!", { turn: true });
    await w.advance(2000);
    expect(w.first("fine")?.data.motivo).toBe("silenzio");
  });

  test("after 'aspetta un attimo' the silence is theirs: no 'are you there?' for two minutes", async () => {
    const w = new World();
    await w.greet();
    w.say(900);
    await w.advance(1000);
    w.main.emit({ type: "heard", text: "Aspetta un attimo che lo cerco." });
    w.geminiSays(500, "Certo, fai pure.", { turn: true });
    await w.advance(60_000);
    expect(w.has("ci_sei")).toBe(false);
    await w.advance(62_000);
    expect(w.has("ci_sei")).toBe(true);
  });

  test("a call back after a dropped line picks up the thread", async () => {
    const lines = ["Ada: com'è andata la riunione col fornitore?", "Jarvis: Hanno accettato lo sconto del dieci per cento."];
    const w = new World({ brain: true, previous: { lines, dropped: true, agoMin: 2 } });
    w.main.emit({ type: "ready", resumed: false });
    await w.advance(60);
    expect(w.main.texts()[0]).toContain("è caduta la linea");
    w.geminiSays(600, "Eccomi, è caduta la linea. Dicevamo dello sconto.", { turn: true });
    await w.advance(1500);
    w.main.emit({ type: "heard", text: "e sulle consegne?" });
    w.main.emit({ type: "toolCall", id: "c1", name: "chiedi_a_jarvis", args: { frase: "e sulle consegne?" } });
    await w.advance(100);
    const user = String(w.thinks.at(-1)!.args[1]);
    expect(user).toContain("sconto del dieci per cento");
    expect(user).toContain("caduta senza saluti");
    // the memory handed to the next call holds only this call
    expect(w.call.memory().lines.join(" ")).not.toContain("sconto del dieci");
  });

  test("a call that ended with a goodbye is not resumed as dropped", () => {
    const w = new World({ brain: true, previous: { lines: ["Ada: ciao"], dropped: false, agoMin: 3 } });
    w.main.emit({ type: "ready", resumed: false });
    expect(w.main.texts()[0]).toContain("Ciao Ada, dimmi");
  });

  test("a handed-off job is told when the line is free, in two or three phrases", async () => {
    const w = new World();
    await w.greet();
    w.main.emit({ type: "toolCall", id: "t1", name: "affida_a_jarvis", args: { compito: "le ultime mail" } });
    await w.flush();
    expect(w.handed).toEqual(["le ultime mail"]);
    expect(w.main.toolResponses()[0]?.result).toContain("Passato a Jarvis");
    w.call.reply("Hai tre mail nuove: una di Dario sul preventivo.");
    await w.advance(100);
    expect(w.events().filter((e) => ["affidato", "risultato", "risultato_a_gemini"].includes(e))).toEqual(["affidato", "risultato", "risultato_a_gemini"]);
    expect(w.main.texts().at(-1)).toContain("Riferiscilo ora a voce in due o tre frasi");
  });

  test("a handoff the channel refuses is said, not counted as running", async () => {
    const w = new World({ handoff: async () => Promise.reject(new Error("handoff_err: canale non avviato")) });
    await w.greet();
    w.main.emit({ type: "toolCall", id: "t1", name: "affida_a_jarvis", args: { compito: "x" } });
    await w.flush();
    expect(w.first("affido_fallito")?.data.errore).toContain("canale non avviato");
    expect(w.main.toolResponses()[0]?.result).toContain("Non è partito");
  });

  test("the hang up waits for the goodbye to be said, and talking over it cancels it", async () => {
    const w = new World();
    await w.greet();
    w.main.emit({ type: "toolCall", id: "h1", name: "chiudi_chiamata", args: {} });
    w.geminiSays(600, "Ciao, a dopo.", { turn: true });
    await w.advance(200);
    // "wait, one more thing" over the goodbye: no hanging up in their face
    w.say(600);
    await w.advance(800);
    expect(w.has("chiusura_annullata")).toBe(true);
    await w.advance(2000);
    expect(w.has("fine")).toBe(false);
    w.main.emit({ type: "toolCall", id: "h2", name: "chiudi_chiamata", args: {} });
    w.geminiSays(400, "Ciao.", { turn: true });
    await w.advance(1500);
    const out = await w.call.done;
    expect([out.reason, out.ours, out.answered]).toEqual(["chiusa da Jarvis", true, true]);
  });

  test("outgoing, the greeting is ready while it rings and starts after their hello", async () => {
    const w = new World({ direction: { kind: "outgoing", reason: "la riunione è spostata alle 16" } });
    w.main.emit({ type: "ready", resumed: false });
    expect(w.main.texts()[0]).toContain("«la riunione è spostata alle 16»");
    w.geminiSays(1500, "Ciao Ada, la riunione è spostata alle 16.", { turn: true });
    await w.advance(2000);
    // while it rings nothing reaches the phone
    expect(w.chunks.length).toBe(0);
    w.call.answered();
    w.say(500);
    await w.advance(400);
    expect(w.voicedMs(400)).toBe(0);
    await w.advance(800);
    const s = w.first("saluto")!;
    expect(s.data.ha_detto_pronto).toBe(true);
    expect(Number(s.data.pronto_ms)).toBeGreaterThan(500);
    expect(w.voicedMs(200)).toBeGreaterThan(0);
  });

  test("an outgoing call nobody answers ends after the rings, without a recording", async () => {
    const d = mkdtempSync(join(tmpdir(), "voice-call-"));
    dirs.push(d);
    const recorder = join(d, "c.wav");
    const w = new World({ direction: { kind: "outgoing", reason: "" }, record: recorder });
    await w.advance(46_000);
    const out = await w.call.done;
    expect([out.reason, out.answered, out.recording]).toEqual(["nessuna risposta", false, null]);
    expect(existsSync(recorder)).toBe(false);
  });

  test("on behalf: only the hang up, the outcome for the owner, and the recording of the call", async () => {
    const d = mkdtempSync(join(tmpdir(), "voice-call-"));
    dirs.push(d);
    const recorder = join(d, "c.wav");
    const w = new World({ direction: { kind: "on_behalf", callee: "Mamma", message: "chiedile come sta", callback: false }, record: recorder });
    expect(w.main.tools).toEqual(tools({ kind: "on_behalf", callee: "Mamma", message: "", callback: false }, { ...P, agentLabel: "" }));
    w.main.emit({ type: "ready", resumed: false });
    // the recorded call says so in the first line
    expect(w.main.texts()[0]).toContain("La chiamata è registrata per Ada");
    w.call.answered();
    await w.advance(1600);
    w.geminiSays(800, "Ciao, sono Jarvis.", { turn: true });
    await w.advance(1200);
    w.main.emit({ type: "toolCall", id: "h1", name: "chiudi_chiamata", args: { esito: "Sta bene, porta il pane." } });
    w.geminiSays(300, "Ciao!", { turn: true });
    await w.advance(1000);
    const out = await w.call.done;
    expect([out.reason, out.report, out.handoffs]).toEqual(["chiusa da Jarvis", "Sta bene, porta il pane.", 0]);
    expect(out.recording).toBe(recorder);
    expect(statSync(recorder).size).toBeGreaterThan(44 + 32_000 * 3);
  });

  test("the speed changes by voice and stays in the outcome", async () => {
    const w = new World();
    await w.greet();
    w.main.emit({ type: "toolCall", id: "v1", name: "velocita", args: { valore: 9 } });
    await w.flush();
    expect(w.first("velocita")?.data.valore).toBeCloseTo(1.6, 5);
    w.call.endedByPeer("riattaccato");
    const out = await w.call.done;
    expect([out.reason, out.ours]).toEqual(["riattaccato", false]);
    expect(out.speed).toBeCloseTo(1.6, 5);
  });

  test("a misheard action is stopped and gemini gets the phrase whisper heard", async () => {
    const w = new World({ whisper: true });
    await w.greet();
    w.say(1500);
    await w.advance(1600);
    // Gemini heard another language and wants to hand off a job; whisper heard the real phrase
    w.main.emit({ type: "heard", text: "Tú debes leer completamente" });
    w.main.emit({ type: "said", text: "Ok, ci guardo." });
    w.main.emit({ type: "toolCall", id: "t1", name: "affida_a_jarvis", args: { compito: "leggi tutto" } });
    await w.flush();
    expect(w.has("azione_in_attesa")).toBe(true);
    await w.advance(1200);
    for (const p of w.whispers) p.resolve({ ok: true, text: "tu devi assegnare un compito a me" });
    await w.advance(100);
    expect(w.first("capito_male")?.data.whisper).toBe("tu devi assegnare un compito a me");
    expect(w.first("azione_fermata")?.data.whisper).toBe("tu devi assegnare un compito a me");
    expect(w.handed).toEqual([]);
  });
});
