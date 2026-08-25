/**
 * Il contratto del messaggio di abbandono: si dice SOLO ciò che è stato
 * verificato. Il caso «branch assente» è la regressione del task `5770b9de` —
 * la riga vecchia giurava «è INTATTO (nessun commit perso)» su un ref che non
 * esisteva, e questi test devono diventare rossi se quella formula torna.
 *
 * @covers WORKTREE-12
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { abandonNoticeFromRepo, composeAbandonNotice } from "./worktree-abandon-notice";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const TTL_REASON = "task fermo in 'in_progress' da 9 giorni";
const GHOST_REASON = "il branch del worktree non esiste più";

describe("composeAbandonNotice — branch PRESENTE (verificato)", () => {
  const msg = composeAbandonNotice({
    reason: TTL_REASON,
    branchName: "topics/vibrant-creek",
    branchState: "present",
    aheadOfMain: 3,
  });

  test("dice perché il worktree è sparito e dove finisce il task", () => {
    expect(msg).toStartWith(`Worktree liberato: ${TTL_REASON}.`);
    expect(msg).toContain("Il task torna in backlog perché la sessione non c'è più.");
  });

  test("dice che il branch c'è, quanto contiene e come riprenderlo", () => {
    expect(msg).toContain("il branch `topics/vibrant-creek` c'è, con 3 commit oltre main");
    expect(msg).toContain("git switch topics/vibrant-creek");
  });

  test("un branch senza commit oltre main non viene spacciato per lavoro da riprendere", () => {
    const m = composeAbandonNotice({
      reason: TTL_REASON, branchName: "topics/vuoto", branchState: "present", aheadOfMain: 0,
    });
    expect(m).toContain("non ha commit oltre main");
    expect(m).toContain("non c'è lavoro committato da recuperare");
    expect(m).not.toContain("git switch");
  });

  test("conteggio non disponibile → si ammette, non si inventa un numero", () => {
    const m = composeAbandonNotice({
      reason: TTL_REASON, branchName: "topics/x", branchState: "present", aheadOfMain: null,
    });
    expect(m).toContain("i commit oltre main non sono contabili");
    expect(m).toContain("git switch topics/x");
    expect(m).not.toMatch(/\d+ commit/);
  });
});

describe("composeAbandonNotice — branch ASSENTE (la bugia del task 5770b9de)", () => {
  const msg = composeAbandonNotice({
    reason: GHOST_REASON,
    branchName: "topics/vibrant-creek",
    branchState: "gone",
  });

  // IL TEST CHE DEVE ROMPERSI SE QUALCUNO RIMETTE LA FORMULA FISSA.
  test("non promette MAI integrità su un ref che non esiste", () => {
    expect(msg).not.toContain("INTATTO");
    expect(msg).not.toContain("intatto");
    expect(msg).not.toContain("nessun commit perso");
    // «ripartilo da lì» mandava a un nome che non risolve.
    expect(msg).not.toContain("ripartilo da lì");
    expect(msg).not.toContain("git switch");
  });

  test("dice in chiaro che il branch non c'è, e dove guardare", () => {
    expect(msg).toContain("il branch NON c'è");
    expect(msg).toContain("git rev-parse --verify topics/vibrant-creek");
    expect(msg).toContain("git reflog");
    expect(msg).toContain("git fsck --lost-found");
  });

  test("non si contraddice nella stessa riga: nessuna rassicurazione accanto alla negazione", () => {
    expect(msg).toContain("non posso dire che il lavoro committato sia salvo");
    expect(msg).toStartWith(`Worktree liberato: ${GHOST_REASON}.`);
  });

  test("un conteggio residuo non trasforma un branch assente in un branch vivo", () => {
    const m = composeAbandonNotice({
      reason: GHOST_REASON, branchName: "topics/x", branchState: "gone", aheadOfMain: 7,
    });
    expect(m).not.toContain("7 commit");
    expect(m).toContain("il branch NON c'è");
  });
});

describe("composeAbandonNotice — casi in cui non si sa", () => {
  test("verifica impossibile → si passa la palla, non si rassicura", () => {
    const m = composeAbandonNotice({
      reason: TTL_REASON, branchName: "topics/x", branchState: "unverified",
    });
    expect(m).toContain("NON è stato verificato");
    expect(m).toContain("git rev-parse --verify topics/x");
    expect(m).not.toContain("INTATTO");
    expect(m).not.toContain("nessun commit perso");
  });

  test("worktree senza branch proprio → nessun ref da promettere", () => {
    const m = composeAbandonNotice({
      reason: TTL_REASON, branchName: null, branchState: "unverified",
    });
    expect(m).toContain("non aveva un branch proprio");
    expect(m).not.toContain("`null`");
    expect(m).not.toContain("INTATTO");
  });

  test("ragione vuota → la frase resta ben formata (niente «: .»)", () => {
    const m = composeAbandonNotice({ reason: "  ", branchName: "topics/x", branchState: "gone" });
    expect(m).toStartWith("Worktree liberato. ");
    expect(m).not.toContain("Worktree liberato: .");
  });
});

/**
 * Il percorso intero contro un repo VERO: è la prova che la verifica non è
 * decorativa — gli stessi due casi del task, provocati con git, non con un
 * mock che potrebbe raccontare quello che gli pare.
 */
describe("abandonNoticeFromRepo — verifica su un repo vero", () => {
  let repo: string;

  // Timeout largo: il costo qui sono gli spawn di git del fixture, non la logica.
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "abnotice-"));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git("add", "-A"); git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "topics/vivo");
    writeFileSync(join(repo, "b.txt"), "lavoro\n");
    git("add", "-A"); git("commit", "-q", "-m", "lavoro dell'agente");
    git("checkout", "-q", "main");
  }, 60_000);

  afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

  test("branch che ESISTE → dice quanto porta e come riprenderlo", async () => {
    const m = await abandonNoticeFromRepo({
      reason: "task fermo in 'in_progress' da 9 giorni", repoPath: repo, branchName: "topics/vivo",
    });
    expect(m).toBe(
      "Worktree liberato: task fermo in 'in_progress' da 9 giorni. " +
      "Verificato ora: il branch `topics/vivo` c'è, con 1 commit oltre main. " +
      "Per riprendere: `git switch topics/vivo`. " +
      "Il task torna in backlog perché la sessione non c'è più.",
    );
  });

  // IL CASO DEL TASK 5770b9de: il branch nominato non esiste.
  test("branch che NON esiste → nessuna promessa, e dove guardare", async () => {
    const m = await abandonNoticeFromRepo({
      reason: "il branch del worktree non esiste più", repoPath: repo, branchName: "topics/vibrant-creek",
    });
    expect(m).toBe(
      "Worktree liberato: il branch del worktree non esiste più. " +
      "⚠️ Verificato ora: `git rev-parse --verify topics/vibrant-creek` non risolve: il branch NON c'è, " +
      "quindi non posso dire che il lavoro committato sia salvo. " +
      "Dove guardare: `git reflog` e `git fsck --lost-found` nel repo del progetto. " +
      "Il task torna in backlog perché la sessione non c'è più.",
    );
    expect(m).not.toContain("INTATTO");
  });

  test("repo del progetto non risolvibile → si ammette di non aver guardato", async () => {
    const m = await abandonNoticeFromRepo({
      reason: "task fermo in 'in_progress' da 9 giorni", repoPath: join(tmpdir(), "repo-che-non-esiste"), branchName: "topics/vivo",
    });
    expect(m).toContain("NON è stato verificato");
    expect(m).not.toContain("INTATTO");
  });

  test("worktree senza branch → nessun ref da promettere", async () => {
    const m = await abandonNoticeFromRepo({ reason: "orfano", repoPath: repo, branchName: null });
    expect(m).toContain("non aveva un branch proprio");
  });

  // LO STESSO REF ASSENTE, IL SIGNIFICATO OPPOSTO. Il ramo potato da un land
  // riuscito non è un branch perduto: dirlo con l'allarme spaventava proprio le
  // card che avevano funzionato (guasto del 12/08).
  test("branch potato dopo il land → racconta l'atterraggio, non suona l'allarme", async () => {
    const m = await abandonNoticeFromRepo({
      reason: "il ramo è stato potato dopo un atterraggio riuscito",
      repoPath: repo,
      branchName: "topics/vibrant-creek",
      deliveryLanded: true,
      deliveryCommit: "0123456789abcdef",
      taskFate: "stays",
    });
    expect(m).toBe(
      "Worktree liberato: il ramo è stato potato dopo un atterraggio riuscito. " +
      "Verificato ora: il branch `topics/vibrant-creek` non c'è più perché il lavoro è ATTERRATO. " +
      "Il commit di consegna `01234567` risulta su main. " +
      "Il ramo è stato potato dal land: non c'è niente da recuperare. " +
      "Il task resta dov'è: il dispatcher non lo sposta di colonna, la decisione è di chi lo guarda.",
    );
    expect(m).not.toContain("⚠️");
    expect(m).not.toContain("backlog");
  });

  // Il ramo davvero sparito sotto una card in review: l'allarme resta (non
  // sappiamo dove sia finito il lavoro), ma la frase non promette un backlog
  // dove la card non va più.
  test("review + branch sparito davvero → allarme sì, backlog no", async () => {
    const m = await abandonNoticeFromRepo({
      reason: "il branch del worktree non esiste più",
      repoPath: repo,
      branchName: "topics/vibrant-creek",
      taskFate: "stays",
    });
    expect(m).toContain("il branch NON c'è");
    expect(m).toContain("git fsck --lost-found");
    expect(m).toEndWith("Il task resta dov'è: il dispatcher non lo sposta di colonna, la decisione è di chi lo guarda.");
  });

  // `deliveryLanded` parla SOLO del ramo sparito. Su un branch che esiste il
  // conteggio dei commit resta l'informazione utile.
  test("branch presente → `deliveryLanded` non riscrive la frase", async () => {
    const m = await abandonNoticeFromRepo({
      reason: "orfano", repoPath: repo, branchName: "topics/vivo", deliveryLanded: true,
    });
    expect(m).toContain("c'è, con 1 commit oltre main");
  });
});
