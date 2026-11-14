/**
 * The brain and the quick voice, ported with the cases of jarvis-channels `brain.rs`
 * and the `acks` test of `tests/voce.rs` (live on Groq, only with GROQ_API_KEY).
 * @covers CALL-03
 */
import { describe, expect, test } from "bun:test";
import { DIALOG_MAX, Dialog, ackPrompt, cleanQuick, parse, progressPrompt, quick, system, think, userTurn } from "./brain";
import { DEFAULT_QUICK_MODEL } from "./config";

const persona = { name: "Ada", assistant: "Jarvis", org: "", channel: "WhatsApp" };

describe("brain", () => {
  test("reads the json even with a fence around", () => {
    const t = parse('```json\n{"di": "Ci guardo subito", "affida": "Controlla la mail di Dario", "chiudi": false}\n```');
    expect(t).toEqual({ say: "Ci guardo subito", task: "Controlla la mail di Dario", close: false });
  });

  test("two objects in a row count as the first", () => {
    expect(parse('{"di": "Scusa", "affida": "", "chiudi": false}\n\nCorreggo:\n{"di": "Altro"}').say).toBe("Scusa");
  });

  test("a brace inside a string does not end the object", () => {
    expect(parse('{"di": "Sì } davvero", "affida": "", "chiudi": true}')).toEqual({ say: "Sì } davvero", task: "", close: true });
  });

  test("the quick voice says nothing on a dash or a speech", () => {
    expect(cleanQuick("«Ok, apro le mail.»")).toBe("Ok, apro le mail.");
    expect(cleanQuick(" - ")).toBeNull();
    expect(cleanQuick("parola ".repeat(20))).toBeNull();
  });

  test("plain text is what gets said", () => {
    expect(parse("Sì, è giusto.").say).toBe("Sì, è giusto.");
  });

  test("the dialog keeps only the last lines", () => {
    const d = new Dialog();
    for (let i = 0; i < 50; i++) d.push("Ada", `frase ${i}`);
    d.push("Jarvis", "  ");
    expect(d.lines.length).toBe(DIALOG_MAX);
    expect(d.render().startsWith("Ada: frase 10")).toBe(true);
  });

  test("the turn says what the voice misheard", () => {
    const u = userTurn(new Dialog(), "Ada", "Dimmi tutto.", "Happy minute");
    expect(u.includes("«Dimmi tutto.»") && u.includes("«Happy minute»")).toBe(true);
    expect(userTurn(new Dialog(), "Ada", "Sì.", "sì.")).not.toContain("la voce aveva capito");
  });

  test("the prompts name the people of this call and no one else", () => {
    const s = system({ ...persona, org: "Acme" }, "sabato 14/11/2026, 18:05");
    expect(s).toContain("Sei Jarvis, l'assistente personale di Ada ad Acme");
    expect(s).toContain("lo riceve anche su WhatsApp");
    expect(system(persona, "x")).not.toContain(" ad ");
    const [instructions, user] = progressPrompt(persona, "leggi la posta", ["Bash: gws-mail gmail"]);
    expect(instructions).toContain("mai il suo nome");
    expect(user).toBe("Chi ascolta: Ada\nIl lavoro: leggi la posta\nUltimi passi:\nBash: gws-mail gmail");
  });

  test("think asks the configured model and reads its first object", async () => {
    const seen: unknown[] = [];
    const brain = {
      model: "m1",
      effort: "low",
      complete: async (messages: unknown, options: unknown) => (seen.push(messages, options), { content: '{"di":"Fa 391","affida":"","chiudi":false}' }),
    };
    expect(await think(brain, "S", "U")).toEqual({ ok: true, thought: { say: "Fa 391", task: "", close: false } });
    expect(seen[0]).toEqual([{ role: "system", content: "S" }, { role: "user", content: "U" }]);
    expect(seen[1]).toMatchObject({ model: "m1", reasoningEffort: "low", purpose: "voice-call" });
  });

  test("an empty or failed thought is an error, so the phrase goes to the agent's chat", async () => {
    const reply = (content: string) => ({ model: "m", effort: "", complete: async () => ({ content }) });
    expect(await think(reply(""), "S", "U")).toEqual({ ok: false, error: "risposta vuota" });
    expect(await think(reply('{"di":"","affida":"","chiudi":false}'), "S", "U")).toEqual({ ok: false, error: "niente da dire" });
    const broken = {
      model: "m",
      effort: "",
      complete: async () => {
        throw new Error("provider offline");
      },
    };
    expect(await think(broken, "S", "U")).toEqual({ ok: false, error: "provider offline" });
  });

  test("quick reads the first choice and keeps the key in the header only", async () => {
    let auth = "";
    let body = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).Authorization!;
      body = String(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "«Ok, apro le mail.»" } }] }));
    }) as unknown as typeof fetch;
    expect(await quick({ key: "K", model: "q", fetchImpl }, ackPrompt("vedi le mail"))).toBe("Ok, apro le mail.");
    expect(auth).toBe("Bearer K");
    expect(body).not.toContain("K\"");
    expect(JSON.parse(body)).toMatchObject({ model: "q", max_tokens: 60, reasoning_effort: "none" });
  });
});

const groqKey = process.env.GROQ_API_KEY ?? "";

describe("acks on the real phrases of the calls", () => {
  // The acknowledgement in tone on the real phrases of the calls of 13/11, 3 times
  // each: no misheard word repeated ("I update the avvoli at once"), nothing not
  // asked ("checking the calendar", "your profile").
  test.skipIf(!groqKey)(
    "acks name only what is asked (live on Groq, 30 of 30)",
    async () => {
      const cases: [string, string[]][] = [
        ["Tu ti sei ripetuto. Sto aspettando ancora che ne aggiorni sugli avvoli.", ["avvol", "avvis"]],
        ["Dimmi un po' quali sono le miei", ["calendario"]],
        ["eh sto aspettando che mi fai salere  non mi sto tornando su nulla", ["profilo", "salere"]],
        ["No, non è nella posta, è su Biper.", ["mail", "posta"]],
        ["me l'ha detto due volte ma va bene  cioè non va bene", ["calendario", "mail"]],
        ["vedi l'ultima mail che ha ricevuto", ["calendario"]],
        // 14/11, the first call through Topics: things to check that nobody named, and a question taken for a complaint
        ["E sottoagenti si sono interrotti.", ["log", "sistema", "schermo"]],
        ["Cosa sta succedendo sul computer?", ["schermo", "log"]],
        ["Lo sta già gestendo Jarvis.", ["hai ragione", "ci sto lavorando"]],
        ["No, ho chiesto. Sì, sì, sì, sì, sta già occupando.", ["hai ragione", "ci sto lavorando"]],
      ];
      const model = process.env.TOPICS_VOICE_QUICK_MODEL || DEFAULT_QUICK_MODEL;
      const bad: string[] = [];
      for (const [phrase, banned] of cases) {
        for (let i = 0; i < 3; i++) {
          // Groq's free tier allows 30 requests a minute: back to back, the tail of the run was all 429s (14/11)
          await Bun.sleep(2100);
          const a = (await quick({ key: groqKey, model }, ackPrompt(phrase))) ?? "";
          const l = a.toLowerCase();
          if (!a || a.split(/\s+/).length > 8 || banned.some((b) => l.includes(b))) bad.push(`${phrase} -> «${a}»`);
        }
      }
      expect(bad).toEqual([]);
    },
    180_000,
  );
});
