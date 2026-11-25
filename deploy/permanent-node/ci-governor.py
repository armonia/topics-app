#!/usr/bin/env python3
"""Tetto sui job CI in parallelo di tutto il server fisso, valido per ogni repo.

Perché: il 22/11 alle 22:40 il server aveva 10 runner di 4 repo (topics-app 5, gli altri 5)
con 8 job insieme, 85 Chromium e load a 70 su 16 core: gli e2e cadevano a caso.

Come: ogni runner è un servizio con un utente suo, quindi nessun lock condiviso può fermare gli altri
dall'interno (un hook gira come l'utente del runner e non può mandare segnali ai Listener altrui).
Lo fa questo servizio come root, con lo stesso trucco del posto unico `ci-slot` di armonia-crm: un
Listener in pausa (SIGSTOP) non prende job, che restano in coda su GitHub, dove l'attesa non consuma il
`timeout-minutes` (attendere dentro il job lo consumava). Il Worker di un job in corso non si tocca mai.
  - al più MAX_JOBS runner con un job in corso (il runner di preparazione, leggero, è esente);
  - nessun job nuovo se il load a 1 minuto supera LOAD_CAP;
  - i posti liberi vanno a rotazione ai Listener fermi da più tempo (ROTATE_S), così nessun repo muore di fame;
  - rete di sicurezza: un runner senza job da REAP_GRACE secondi che ha ancora processi (browser,
    server di test) li uccide: sono orfani di un job cancellato o scaduto, dove l'hook di fine non gira.
Allo stop del servizio tutti i Listener ripartono (ExecStopPost), mai una CI lasciata ferma.

Annullare tutto, un comando: `systemctl disable --now ci-governor` (ExecStopPost riprende ogni Listener).
Tetto più largo/stretto a caldo: drop-in `Environment=CI_MAX_JOBS=N` (o CI_LOAD_CAP) su ci-governor.service, poi restart.
Limite noto (22/11): un solo job pesante può superare il load 24 da solo (un e2e con 4 worker
Playwright, con 4 Chromium pesanti, dà load 28-48): il tetto sul numero di job non lo riduce, serve ridurre i worker di quel job.
NON RIPROVARE `systemctl stop`/`start` al posto di SIGSTOP/SIGCONT (provato e scartato il 23/11, card d7c127ed). Misura su quadra:
workflow_dispatch di specflow-agenti.yml (label fisso-quadra), runner di prova fuori dal governatore, grilletto sul log del
Listener (_diag/Runner_*.log), un job alla volta, nessuna spesa. Dove si ferma il runner e cosa succede al job:

  momento dello stop                                 stop (systemctl)                       SIGSTOP (nello stesso istante)
  job appena ricevuto ("Acknowledging runner         torna in coda e finisce success su     resta in coda ~170 s, poi lo prende
  request", Worker e acquisizione ancora da fare)    un altro runner, tentativo 1           un altro runner, success
                                                     (run 45112218728, stop in 0,46 s)      (run 45112913638)
  job gia' acquisito ("Job request ... received",    PERSO: resta in_progress su un         non provato: il Listener si riprende
  2 s dopo la riga sopra, Worker non ancora vivo)    runner spento, nemmeno un riavvio lo   con SIGCONT e il job prosegue; il caso
                                                     riprende; chiuso solo dal limite di    reale di Zeno (run 45107953165) era
                                                     tempo (run 45113522164, 10 min)        questo, rimasto fermo 10 min

  Da `systemctl start` al job preso (stesso job gia' in coda): 69,0 s, 4,6 s, 65,9 s. Il Listener e' vivo in 0,15-0,19 s: il ritardo
  e' l'assegnazione di GitHub a un runner che torna online, quindi ogni ripartenza costa fino a ~70 s.
Conclusione: prima che il job sia acquisito nessuno dei due meccanismi lo perde; dopo, lo stop lo perde per sempre e SIGSTOP lo
tiene fermo ma recuperabile. Lo stop non toglie il rischio, costa fino a 70 s a ogni ripartenza e complica tutto (elenco delle
unit, stato delle pause, riavvio degli altri script). La cura giusta e' non congelare chi sta prendendo un job: pending_data() e
recent_log() prima della pausa, freeze() dopo (SIGCONT se nel frattempo e' arrivato qualcosa) e la ripresa subito di un Listener
fermo con byte non letti o con un Worker.
Conteggio dei job persi (barra): `~/.topics/agents/jarvis/bin/ci-lost-job-count <ISO UTC>` (API di GitHub, tutti i tentativi).
Prove: `ci-governor --selftest` (logica pura) · `--resume` (riprende tutti) · `--status` (cosa vede, senza toccare niente) · `--dry-run`.
"""
import json, os, re, signal, subprocess, sys, time

MAX_JOBS = int(os.environ.get("CI_MAX_JOBS", "2"))
LOAD_CAP = float(os.environ.get("CI_LOAD_CAP", "24"))
# un Listener ripreso resta sveglio almeno cosi' (o fino al job): GitHub puo' metterci minuti ad assegnargli un job appena ripartito
# (23/11: ripreso alle 02:03:07, rimesso in pausa alle 02:04:20 con il job in coda, load 15 e 2 posti liberi)
ROTATE_S = int(os.environ.get("CI_ROTATE_S", "600"))
REAP_GRACE = int(os.environ.get("CI_REAP_GRACE", "60"))
# un runner che non e' stato svegliato da tanto ha quasi certamente un job in coda su GitHub: passa avanti a tutto
STARVE_S = int(os.environ.get("CI_STARVE_S", "1200"))
STATE = os.environ.get("CI_GOV_STATE", "/var/lib/ci-governor-served.json")
TICK = float(os.environ.get("CI_TICK", "2"))
# Un Listener congelato con SIGSTOP puo' ricevere un job nel secondo in cui lo si ferma (23/11 03:53:48: zenocms-runner@1 aveva
# appena chiuso un job e riaperto la sessione, GitHub gli ha assegnato `cambi`, il governatore lo ha fermato: il job e' rimasto
# fermo 10 minuti e GitHub lo ha annullato per timeout). Il Worker non c'e' ancora, quindi "worker" non lo vede: lo vede
# il socket (byte arrivati e non letti) e il log del Listener (scrive appena prende un messaggio).
PROBE_WINDOW = int(os.environ.get("CI_PROBE_WINDOW", "90"))   # dopo una pausa, per quanto si cerca un dato arrivato nel socket
PROBE_MAX = int(os.environ.get("CI_PROBE_MAX", "1"))          # riprese per dato arrivato, per ogni pausa (poi resta fermo: dopo la prima e' quasi sempre una risposta vuota)
# The broker's empty long-poll answer is 236-244 bytes; a real message (a job, a label change) is 326 or more (measured
# on 1240 and 120 wakes, 22-25/11). A real one is never held to the probe budget: see wake_on_data().
REAL_MSG_MIN = int(os.environ.get("CI_REAL_MSG_MIN", "300"))
HOLD_S = int(os.environ.get("CI_HOLD_S", "12"))               # dopo una ripresa per dato in arrivo non si ferma per 12 s (il Worker parte in 1-3 s)
QUIET_S = int(os.environ.get("CI_QUIET_S", "8"))              # un Listener che ha scritto nel log meno di cosi' fa non si ferma
# esenti, nel formato <prefisso>:<n> (es. ci-runner:0 = il servizio del runner di preparazione, leggero)
EXEMPT = {x.strip().replace(":", chr(64)) + ".service" for x in os.environ.get("CI_EXEMPT", "ci-runner:0").split(",")}
LOG = os.environ.get("CI_GOV_LOG", "/var/log/ci-governor.log")
LOADLOG = os.environ.get("CI_LOAD_LOG", "/var/log/ci-load.log")
KEEP_COMM = ("Runner.", "run.sh", "run-helper.sh", "runsvc.sh")


def decide(runners, load1, now, last_awake, max_jobs=MAX_JOBS, load_cap=LOAD_CAP, rotate_s=ROTATE_S, extra=0, served=None,
           starve_s=STARVE_S, granted=None):
    """runners: {unit: {"worker": bool, "stopped": bool, "pending": bool, "hold": bool}} (solo i non esenti con un Listener;
    pending e hold facoltativi).
    extra: suite Playwright lanciate a mano sul server con systemd-run (agenti): non sono job di un runner e
    non si fermano, ma pesano come un job e occupano un posto.
    served: quando ogni runner e' stato ripreso l'ultima volta (resta anche dopo la pausa): il turno va a chi
    aspetta da piu' tempo, senza di lui gli stessi due runner prendevano sempre i posti (22/11, CI di topics-app in coda 1 h 30).
    FAME (22/11: i job di una PR di zenocms in coda 1 h 13 mentre il tetto, il load e le suite a mano degli agenti
    occupavano sempre i posti): un runner fermo da piu' di starve_s secondi senza essere servito ha quasi certamente un
    job in coda su GitHub (il server non lo vede: nessun token). Passa avanti: prende un posto anche con il load sopra
    la soglia e anche con le suite a mano, ma sempre entro max_jobs JOB DI RUNNER insieme, uno alla volta, il piu' vecchio
    per primo, fra tutti i repo. `granted` (insieme modificato qui) tiene a mente chi e' stato ammesso cosi': finche' non
    cede il turno per rotazione, il tetto normale non lo ferma.
    Ritorna (da_fermare, da_riprendere). Pura a parte `granted`: niente I/O, provata da --selftest."""
    granted = granted if granted is not None else set()
    # JOB IN MANO: un Listener fermo che ha un Worker, o che ha dati non letti (r["pending"]: il job gli e' arrivato mentre lo si
    # fermava), va ripreso subito e senza guardare i posti: il job e' gia' assegnato da GitHub e fermo il Listener lo perde.
    # Un Listener sveglio con dati in arrivo o riletto da poco (pending) o appena ripreso (hold) non si ferma in questo giro.
    stuck = [u for u, r in runners.items() if r["stopped"] and (r["worker"] or r.get("pending"))]
    pinned = [u for u, r in runners.items() if not r["stopped"] and not r["worker"] and (r.get("pending") or r.get("hold"))]
    active = [u for u, r in runners.items() if r["worker"]]
    idle = [u for u, r in runners.items() if not r["worker"]]
    busy = len(active) + extra
    slots = max_jobs if load1 <= load_cap else min(max_jobs, busy)
    free = max(slots - busy, 0)
    if not active:                  # almeno un job di runner alla volta passa sempre: le suite a mano non affamano la CI
        free = max(free, 1)
    awake = [u for u in idle if not runners[u]["stopped"] and u not in pinned]
    stopped = [u for u in idle if runners[u]["stopped"] and u not in stuck]
    free = max(free - len(pinned) - len([u for u in stuck if u in idle]), 0)   # occupano un posto: stanno per prendere un job
    # who took a job or was paused is no longer an admission; one pinned (writing its log right after the wake) still is
    granted &= set(awake) | set(pinned)
    free = max(free - len([u for u in awake if u in granted]), 0)
    # chi è sveglio da troppo e ha altri in attesa cede il posto
    stale = [u for u in awake if now - last_awake.get(u, now) >= rotate_s and stopped]
    keep_awake = [u for u in awake if u not in stale and u not in granted]
    stop = list(stale)
    if len(keep_awake) > free:                       # più svegli dei posti: fermo i più recenti
        keep_awake.sort(key=lambda u: last_awake.get(u, now))
        stop += keep_awake[free:]
        keep_awake = keep_awake[:free]
    cont = []
    room = free - len(keep_awake)
    if room > 0:                                    # i fermi da più tempo per primi (mai svegliati = 0)
        served = served or {}
        for u in sorted(stopped + [s for s in stale if s not in stopped], key=lambda u: (served.get(u, 0), u)):
            if u in stale:
                continue                            # appena ceduto: il turno è degli altri
            if room == 0:
                break
            cont.append(u); room -= 1
    # fame: il piu' vecchio fra i fermi da piu' di starve_s passa avanti, entro max_jobs job di runner
    served = served or {}
    starving = sorted([u for u in stopped if u not in cont and now - served.get(u, now) >= starve_s],
                      key=lambda u: (served.get(u, now), u))
    awake_now = len([u for u in awake if u not in stop]) + len(cont)
    if starving and not cont and len(active) + awake_now < max_jobs:
        cont.append(starving[0]); granted.add(starving[0])
    return stop, stuck + cont


def wake_on_data(nbytes, since_pause, probes, probe_window=PROBE_WINDOW, probe_max=PROBE_MAX, real_min=REAL_MSG_MIN):
    """Does data waiting in a paused Listener's socket wake it? A real message always does; the empty long-poll answer
    only once per pause and inside the probe window, or every paused Listener would wake each minute for nothing."""
    if not nbytes:
        return False
    return nbytes >= real_min or (since_pause <= probe_window and probes < probe_max)


def selftest():
    R = lambda w, s: {"worker": w, "stopped": s}
    D = lambda *a, **k: decide(*a, max_jobs=3, load_cap=20, rotate_s=20, **k)   # indipendenti dai default di ambiente
    # 3 job in corso, tetto 3: tutti i liberi fermi
    st, co = D({"a": R(1, 0), "b": R(1, 0), "c": R(1, 0), "d": R(0, 0), "e": R(0, 1)}, 5, 100, {"d": 100})
    assert st == ["d"] and co == [], (st, co)
    # 2 in corso: un posto, parte il fermo da più tempo
    st, co = D({"a": R(1, 0), "b": R(1, 0), "d": R(0, 1), "e": R(0, 1)}, 5, 100, {}, served={"d": 50, "e": 10})
    assert st == [] and co == ["e"], (st, co)
    # load sopra il tetto: nessuna ammissione anche con posti
    st, co = D({"a": R(1, 0), "d": R(0, 1)}, 30, 100, {})
    assert st == [] and co == [], (st, co)
    # sveglio da troppo con altri in coda: cede e il turno va a un altro
    st, co = D({"a": R(1, 0), "b": R(1, 0), "d": R(0, 0), "e": R(0, 1)}, 5, 100, {"d": 70, "e": 10})
    assert st == ["d"] and co == ["e"], (st, co)   # d cede, il posto passa subito a e
    # senza nessuno in coda, lo sveglio resta sveglio (nessuna rotazione a vuoto)
    st, co = D({"a": R(1, 0), "b": R(1, 0), "d": R(0, 0)}, 5, 100, {"d": 10})
    assert st == [] and co == [], (st, co)
    # una suite lanciata a mano occupa un posto: 2 posti liberi invece di 3
    st, co = D({k: R(0, 1) for k in "abcde"}, 1, 100, {}, extra=1)
    assert len(co) == 2, co
    # due suite a mano e nessun job di runner: ne passa comunque uno (22/11: 9 Listener fermi, run in coda da 45 minuti)
    st, co = D({k: R(0, 1) for k in "abcde"}, 40, 100, {}, extra=3)
    assert len(co) == 1, co
    # rotazione: con un solo posto il turno va a chi e' stato servito piu' tempo fa, non sempre agli stessi
    st, co = D({"a": R(0, 1), "b": R(0, 1), "c": R(0, 1)}, 1, 100, {}, extra=2, served={"a": 90, "b": 50, "c": 10})
    assert co == ["c"], co
    # FAME: un job in coda da 21 minuti (runner fermo da 21 min) con il load a 30 parte, anche con 1 job in corso
    N = 100000
    S = lambda **k: dict(max_jobs=2, load_cap=24, starve_s=1200, rotate_s=20, **k)
    g = set()
    st, co = decide({"a": R(1, 0), "z": R(0, 1), "y": R(0, 1)}, 30, N, {}, served={"z": N - 21 * 60, "y": N - 60}, granted=g, **S())
    assert co == ["z"] and g == {"z"} and st == [], (st, co, g)
    # lo stesso a 19 minuti: sopra soglia non parte niente
    g = set()
    st, co = decide({"a": R(1, 0), "z": R(0, 1)}, 30, N, {}, served={"z": N - 19 * 60}, granted=g, **S())
    assert co == [] and not g, (st, co)
    # le suite a mano da sole non lo bloccano (due stack di un agente, nessun job di runner)
    g = set()
    st, co = decide({"z": R(0, 1), "y": R(0, 1)}, 30, N, {}, served={"z": N - 25 * 60, "y": N - 30}, granted=g, extra=2, **S())
    assert co == ["z"], (st, co)
    # ma mai oltre max_jobs job di runner: con 2 in corso non parte
    g = set()
    st, co = decide({"a": R(1, 0), "b": R(1, 0), "z": R(0, 1)}, 5, N, {}, served={"z": N - 40 * 60}, granted=g, **S())
    assert co == [], (st, co)
    # il piu' vecchio per primo, uno alla volta, fra tutti i repo
    g = set()
    st, co = decide({"a": R(0, 1), "b": R(0, 1), "c": R(0, 1)}, 30, N, {}, served={"a": N - 30 * 60, "b": N - 50 * 60, "c": N - 40 * 60}, granted=g, **S())
    assert co == ["b"], (st, co)
    # un ammesso per fame non viene fermato dal tetto normale (load alto, suite a mano), finche' non scade il suo turno
    g = {"z"}
    st, co = decide({"z": R(0, 0), "y": R(0, 1)}, 30, N, {"z": N - 5}, served={"z": N - 5, "y": N - 60}, granted=g, extra=2, **S())
    assert st == [] and co == [], (st, co)
    # a turno scaduto cede (altri in attesa) e il posto passa
    g = {"z"}
    st, co = decide({"z": R(0, 0), "y": R(0, 1)}, 5, N, {"z": N - 25}, served={"z": N - 25, "y": N - 60}, granted=g, **S())
    assert st == ["z"], (st, co)
    # preso un job, non e' piu' un'ammissione
    g = {"z"}
    decide({"z": R(1, 0), "y": R(0, 1)}, 5, N, {}, served={}, granted=g, **S())
    assert g == set(), g
    # SVEGLIO ALMENO 10 MINUTI (default): ripreso 73 s fa, nessun job, altri in attesa, posti liberi -> non va in pausa
    N = 100000
    st, co = decide({"z": R(0, 0), "y": R(0, 1), "x": R(0, 1)}, 15, N, {"z": N - 73}, served={"z": N - 73, "y": N - 5000, "x": N - 900},
                    max_jobs=2, load_cap=24)
    assert st == [] and "z" not in st, (st, co)
    # lo stesso a 9 minuti e 59: ancora sveglio; a 10 minuti cede il turno
    st, co = decide({"z": R(0, 0), "y": R(0, 1)}, 15, N, {"z": N - 599}, served={"z": N - 599, "y": N - 5000}, max_jobs=2, load_cap=24)
    assert st == [], st
    st, co = decide({"z": R(0, 0), "y": R(0, 1)}, 15, N, {"z": N - 601}, served={"z": N - 601, "y": N - 5000}, max_jobs=2, load_cap=24)
    assert st == ["z"], st
    # con un job preso non e' piu' fermabile per rotazione (e' un job, non un runner libero)
    st, co = decide({"z": R(1, 0), "y": R(0, 1)}, 15, N, {}, served={}, max_jobs=2, load_cap=24)
    assert "z" not in st, st
    # nessun job: tre posti, tre svegli
    st, co = D({k: R(0, 1) for k in "abcde"}, 1, 100, {})
    assert st == [] and len(co) == 3, (st, co)
    # JOB IN MANO (23/11 03:53:48): il job arriva a un Listener nello stesso istante della pausa
    P = lambda w, s, p=False, h=False: {"worker": w, "stopped": s, "pending": p, "hold": h}
    big = dict(max_jobs=2, load_cap=24)
    # a) congelato mentre il job gli arrivava: ha dati non letti, load alto, 2 job in corso (nessun posto libero) -> ripreso subito
    st, co = decide({"a": P(1, 0), "b": P(1, 0), "z": P(0, 1, p=True)}, 30, 1000, {}, **big)
    assert co == ["z"] and st == [], (st, co)
    # b) lo stesso senza dati non letti resta fermo: la pausa normale non cambia
    st, co = decide({"a": P(1, 0), "b": P(1, 0), "z": P(0, 1)}, 30, 1000, {}, **big)
    assert co == [] and st == [], (st, co)
    # c) Worker vivo con il Listener congelato (il job e' partito e il Listener e' stato fermato dopo): ripreso subito
    st, co = decide({"a": P(1, 0), "z": P(1, 1)}, 30, 1000, {}, **big)
    assert co == ["z"], (st, co)
    # d) sveglio, senza job, tetto che lo vorrebbe fermare, ma ha dati in arrivo -> non si ferma
    st, co = decide({"a": P(1, 0), "b": P(1, 0), "z": P(0, 0, p=True)}, 30, 1000, {"z": 0}, **big)
    assert st == [], (st, co)
    # e) appena ripreso per un dato in arrivo (hold): non si ferma neanche dopo i 600 s di rotazione, e occupa un posto
    st, co = decide({"a": P(1, 0), "z": P(0, 0, h=True), "y": P(0, 1)}, 5, 1000, {"z": 0}, served={"y": 900}, **big)
    assert st == [] and co == [], (st, co)
    # f) un runner con dati in arrivo conta come un job: con 1 job in corso e 1 in arrivo il terzo non parte
    st, co = decide({"a": P(1, 0), "z": P(0, 0, p=True), "y": P(0, 1)}, 5, 1000, {}, served={"y": 900}, **big)
    assert co == [], (st, co)
    # g) dopo il job il Listener torna normale (niente pending/hold): la pausa di rotazione riparte
    st, co = decide({"a": P(1, 0), "z": P(0, 0), "y": P(0, 1)}, 5, 1000, {"z": 0}, served={"y": 900, "z": 990}, max_jobs=2, load_cap=24, rotate_s=600)
    assert st == ["z"], (st, co)
    # STARVATION SURVIVES THE PIN (25/11 11:54:58, run 45605471183): a runner woken "per fame" writes its log at once, so for
    # a few seconds it is pinned (pending), hence not in `awake`. Its grant must not be dropped there: it was, and once the
    # log went quiet it counted as a plain awake runner, the newest, and was paused 10 s after the wake with 0 jobs running.
    # 722 of 1274 starvation wakes on 22-25/11 ended in under 30 s; the e2e shard booked on it waited 21 minutes.
    g = {"z"}
    decide({"a": P(1, 0), "z": P(0, 0, p=True), "y": P(0, 0), "x": P(0, 1)}, 5, 1000, {"z": 994, "y": 900},
           served={"z": 994, "y": 900, "x": 100}, granted=g, max_jobs=2, load_cap=24, rotate_s=600)
    assert "z" in g, g
    st, co = decide({"a": P(1, 0), "z": P(0, 0), "y": P(0, 0), "x": P(0, 1)}, 5, 1002, {"z": 994, "y": 900},
                    served={"z": 994, "y": 900, "x": 100}, granted=g, max_jobs=2, load_cap=24, rotate_s=600)
    assert "z" not in st, (st, co)
    # A REAL MESSAGE ALWAYS WAKES (25/11 11:36:27): the broker's empty long-poll answer is 236-244 bytes (1240 of the
    # wakes logged on 22-25/11); a job or label message is 326 bytes or more. Only the empty answer is held to one probe
    # per pause inside the window; a real one wakes the Listener whenever it arrives, or a job waits in the socket.
    assert wake_on_data(242, 10, 0) and not wake_on_data(242, 10, 1) and not wake_on_data(242, 120, 0)
    assert wake_on_data(568, 10, 1), "a job message after the one probe must wake the Listener"
    assert wake_on_data(328, 600, 3), "a real message outside the probe window must wake the Listener"
    assert not wake_on_data(0, 10, 0)
    # lettura dei segnali su Linux: socket con byte non letti e log del Listener appena scritto
    if os.path.exists("/proc/net/tcp"):
        import socket, tempfile
        srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
        cli = socket.create_connection(srv.getsockname()); conn, _ = srv.accept()
        assert not pending_data(os.getpid()), "nessun dato ancora"
        conn.sendall(b"x" * 242); time.sleep(0.2)
        assert pending_data(os.getpid()), "242 byte non letti: pending_data deve dire True"
        cli.recv(242); time.sleep(0.2)
        assert not pending_data(os.getpid()), "letti: torna False"
        for x in (cli, conn, srv):
            x.close()
        # freeze(): il dato arriva tra il controllo e il congelamento -> il Listener torna in marcia (senza il controllo dopo, resta fermo)
        d2 = tempfile.mkdtemp(); os.makedirs(d2 + "/_diag"); lg = d2 + "/_diag/Runner_x.log"
        open(lg, "w").write("x"); os.utime(lg, (time.time() - 60,) * 2)
        state = lambda p: open(f"/proc/{p}/stat").read().rsplit(")", 1)[1].split()[0]
        a = subprocess.Popen(["sleep", "60"], cwd=d2); b = subprocess.Popen(["sleep", "60"], cwd=d2)
        try:
            time.sleep(0.2)
            assert freeze(a.pid) is True and state(a.pid) == "T", "log fermo da 60 s: resta congelato"
            os.kill(a.pid, signal.SIGCONT)
            assert freeze(b.pid, between=lambda: os.utime(lg, None)) is False, "ha scritto nel log mentre lo si fermava"
            time.sleep(0.1)
            assert state(b.pid) != "T", "Listener rimasto congelato con un job appena arrivato"
        finally:
            for p in (a, b):
                p.kill(); p.wait()
            import shutil; shutil.rmtree(d2, ignore_errors=True)
        old = os.getcwd(); d = tempfile.mkdtemp()
        try:
            os.makedirs(d + "/_diag"); open(d + "/_diag/Runner_x.log", "w").write("x"); os.chdir(d)
            assert recent_log(os.getpid(), 8), "log scritto adesso"
            os.utime(d + "/_diag/Runner_x.log", (time.time() - 60,) * 2)
            assert not recent_log(os.getpid(), 8), "log fermo da 60 s"
        finally:
            os.chdir(old); import shutil; shutil.rmtree(d, ignore_errors=True)
    print("selftest ok")


def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + msg
    print(line, flush=True)
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def unit_of(pid):
    try:
        cg = open(f"/proc/{pid}/cgroup").read()
    except OSError:
        return None
    m = re.search(r"/([^/\n]*runner@?[^/\n]*\.service)\s*$", cg, re.M)
    return m.group(1) if m else None


def scan():
    """Per ogni runner con un Listener: Listener, Worker, processi dentro il cgroup."""
    rs = {}
    for p in filter(str.isdigit, os.listdir("/proc")):
        try:
            comm = open(f"/proc/{p}/comm").read().strip()
        except OSError:
            continue
        if comm not in ("Runner.Listener", "Runner.Worker"):
            continue
        u = unit_of(p)
        if not u:
            continue
        r = rs.setdefault(u, {"worker": False, "stopped": False, "listener": None})
        if comm == "Runner.Worker":
            r["worker"] = True
        else:
            r["listener"] = int(p)
            try:
                r["stopped"] = open(f"/proc/{p}/stat").read().rsplit(")", 1)[1].split()[0] == "T"
            except (OSError, IndexError):
                pass
    return rs


def pending_data(pid):
    """Byte arrivati e non ancora letti nei socket TCP stabiliti del processo (rx_queue; 0 = niente, vale come False): per un
    Listener di GitHub e' la risposta del broker, quindi forse un job. Solo Linux (/proc/net/tcp); altrove 0."""
    tot = 0
    try:
        inodes = set()
        for fd in os.listdir(f"/proc/{pid}/fd"):
            try:
                link = os.readlink(f"/proc/{pid}/fd/{fd}")
            except OSError:
                continue
            if link.startswith("socket:["):
                inodes.add(link[8:-1])
        if not inodes:
            return 0
        for path in ("/proc/net/tcp", "/proc/net/tcp6"):
            try:
                rows = open(path).read().splitlines()[1:]
            except OSError:
                continue
            for line in rows:
                c = line.split()
                if len(c) > 9 and c[3] == "01" and c[9] in inodes:
                    tot += int(c[4].split(":")[1], 16)
    except OSError:
        pass
    return tot


def recent_log(pid, secs=None):
    """True se il Listener ha scritto nel suo _diag da meno di `secs`: sta lavorando (ha preso un messaggio, chiuso un job)."""
    secs = QUIET_S if secs is None else secs
    try:
        d = os.path.join(os.readlink(f"/proc/{pid}/cwd"), "_diag")
        newest = max(os.path.getmtime(os.path.join(d, f)) for f in os.listdir(d) if f.startswith("Runner_"))
        return time.time() - newest < secs
    except (OSError, ValueError):
        return False


def freeze(pid, between=None):
    """SIGSTOP al Listener e SUBITO dopo si rilegge: se tra l'ultimo controllo e il congelamento e' arrivato un dato nel socket o ha
    scritto nel log (sta prendendo un job: 23/11 03:53:48), SIGCONT al volo e ritorna False. Misurato il 23/11 su quadra: un Listener
    fermato dopo che ha acquisito il job lo tiene `in_progress` senza che nessuno lo esegua (con SIGSTOP si recupera riprendendolo,
    con systemctl stop il job e' perso: nemmeno un riavvio lo riprende). `between` serve solo al selftest per simulare l'arrivo."""
    os.kill(pid, signal.SIGSTOP)
    if between:
        between()
    if pending_data(pid) or recent_log(pid):
        os.kill(pid, signal.SIGCONT)
        return False
    return True


def manual_suites():
    """Suite Playwright lanciate con systemd-run (unit run-uNNN.service) da agenti sulla macchina."""
    n = set()
    for p in filter(str.isdigit, os.listdir("/proc")):
        try:
            cg = open(f"/proc/{p}/cgroup").read()
            if "/run-u" in cg and "playwright" in open(f"/proc/{p}/cmdline").read() and "test" in open(f"/proc/{p}/cmdline").read():
                n.add(re.search(r"(run-u\d+\.service)", cg).group(1))
        except (OSError, AttributeError):
            pass
    return len(n)


def cgroup_procs(unit):
    out = []
    for p in filter(str.isdigit, os.listdir("/proc")):
        if unit_of(p) == unit:
            try:
                out.append((int(p), open(f"/proc/{p}/comm").read().strip()))
            except OSError:
                pass
    return out


def main():
    if "--selftest" in sys.argv:
        return selftest()
    dry = "--dry-run" in sys.argv
    rs = scan()
    if "--resume" in sys.argv:                      # ExecStopPost: mai Listener lasciati in pausa
        for r in rs.values():
            if r["listener"] and r["stopped"]:
                os.kill(r["listener"], signal.SIGCONT)
        return
    if "--status" in sys.argv:
        for u, r in sorted(rs.items()):
            print(f"{u:34} worker={int(r['worker'])} listener_fermo={int(r['stopped'])}{' (esente)' if u in EXEMPT else ''}")
        print(f"load1={os.getloadavg()[0]:.1f} job in corso={sum(r['worker'] for u, r in rs.items() if u not in EXEMPT)}/{MAX_JOBS}")
        return
    last_awake, idle_since, last_load, served, granted = {}, {}, 0, {}, set()
    paused_at, probes, hold_until = {}, {}, {}
    try:                                            # un riavvio non azzera l'attesa di chi e' fermo da ore
        served = {k: float(v) for k, v in json.load(open(STATE)).items()}
    except (OSError, ValueError):
        pass
    for u in rs:
        served.setdefault(u, time.time())
    log(f"avvio: tetto {MAX_JOBS} job, load1 massimo per ammetterne di nuovi {LOAD_CAP}, sveglio almeno {ROTATE_S} s, fame dopo {STARVE_S} s, esenti {sorted(EXEMPT)}")

    def resume_all(*_):
        for r in scan().values():
            if r["listener"] and r["stopped"]:
                os.kill(r["listener"], signal.SIGCONT)
        log("fine: tutti i Listener ripresi")
        sys.exit(0)
    signal.signal(signal.SIGTERM, resume_all)
    # un riavvio non deve ereditare Listener rimasti in pausa dalla vita prima
    for r in rs.values():
        if r["listener"] and r["stopped"] and not dry:
            os.kill(r["listener"], signal.SIGCONT)
    while True:
        now = time.time()
        rs = scan()
        for u in list(last_awake):
            if u not in rs or rs[u]["stopped"]:
                last_awake.pop(u, None)
        load1 = os.getloadavg()[0]
        gov = {u: r for u, r in rs.items() if u not in EXEMPT and r["listener"]}
        for u, r in gov.items():
            if not r["stopped"] and not r["worker"]:
                last_awake.setdefault(u, now)
        # JOB IN MANO (23/11): chi ha un dato non letto o ha scritto nel log da pochi secondi sta prendendo un job
        for u, r in gov.items():
            r["pending"] = False
            r["hold"] = now < hold_until.get(u, 0)
            if r["worker"]:
                probes.pop(u, None)
            elif r["stopped"]:                      # congelato: un dato arrivato dopo la pausa e' la risposta del broker
                r["pending"] = wake_on_data(pending_data(r["listener"]), now - paused_at.get(u, 0), probes.get(u, 0))
            else:
                r["pending"] = pending_data(r["listener"]) or recent_log(r["listener"])
        extra = manual_suites()
        stop, cont = decide(gov, load1, now, last_awake, extra=extra, served=served, granted=granted)
        for u in stop:
            fresh = scan().get(u)                   # ultimo sguardo prima di congelare: il job puo' essere arrivato adesso
            if fresh and (fresh["worker"] or pending_data(fresh["listener"]) or recent_log(fresh["listener"])):
                log(f"non pauso {u}: sta prendendo un job (load1 {load1:.1f})")
                hold_until[u] = now + HOLD_S
                continue
            log(f"pausa {u} (job in corso {sum(r['worker'] for r in gov.values())}+{extra} a mano/{MAX_JOBS}, load1 {load1:.1f})")
            if not dry and not freeze(gov[u]["listener"]):
                log(f"pausa di {u} annullata subito: nel momento del congelamento e' arrivato un dato (sta prendendo un job)")
                hold_until[u] = now + HOLD_S
                continue
            paused_at[u] = now                      # i probes NON si azzerano qui: l'ultima ripresa per dato conta ancora
            last_awake.pop(u, None)
        for u in cont:
            r = gov[u]
            if r["stopped"] and r["worker"]:
                motivo = " con un job in corso: il Listener non va lasciato fermo"
            elif r["stopped"] and r["pending"]:
                n = pending_data(r['listener'])
                motivo = f" per {n} byte arrivati dopo la pausa (puo' essere un job)"
                hold_until[u] = now + HOLD_S
                if n < REAL_MSG_MIN:                # only the empty answer spends the probe budget
                    probes[u] = probes.get(u, 0) + 1
            elif u in granted:
                motivo = ' per fame (fermo da ' + str(int((now - served.get(u, now)) / 60)) + ' min)'
                probes[u] = 0
            else:
                motivo = ""
                probes[u] = 0                       # ripresa normale: una pausa futura ha di nuovo il suo giro di controllo
            log(f"riprendo {u}{motivo} (job in corso {sum(r['worker'] for r in gov.values())}+{extra} a mano/{MAX_JOBS}, load1 {load1:.1f})")
            if not dry:
                os.kill(gov[u]["listener"], signal.SIGCONT)
            last_awake[u] = now
            if not (r["stopped"] and (r["worker"] or r["pending"])):
                served[u] = now                     # un salvataggio al volo non e' un turno: non toglie il posto a chi aspetta
        if cont:
            try:
                tmp = STATE + ".tmp"
                json.dump(served, open(tmp, "w")); os.replace(tmp, STATE)
            except OSError:
                pass
        # rete: runner senza job da REAP_GRACE s ma con processi rimasti
        for u, r in gov.items():
            if r["worker"]:
                idle_since.pop(u, None)
                continue
            t0 = idle_since.setdefault(u, now)
            if now - t0 < REAP_GRACE:
                continue
            procs = [(p, c) for p, c in cgroup_procs(u) if not c.startswith(KEEP_COMM) and c not in ("bash", "sh", "sleep", "dash")]
            keep_pids = {r["listener"]}
            for p, c in procs:
                if p in keep_pids:
                    continue
                log(f"orfano di {u}: {c} pid {p}, runner senza job da {int(now - t0)} s: kill")
                if not dry:
                    try:
                        os.kill(p, signal.SIGKILL)
                    except OSError:
                        pass
            idle_since[u] = now - REAP_GRACE + 30      # riprova fra 30 s, non a ogni giro
        if now - last_load >= 60:                      # il campione che prova il tetto (barra: log di 2 ore)
            last_load = now
            la = open("/proc/loadavg").read().split()
            nb = sum(1 for p in filter(str.isdigit, os.listdir("/proc"))
                     if (lambda c: c in ("chrome-headless", "headless_shell", "chrome"))(_comm(p)))
            try:
                with open(LOADLOG, "a") as f:
                    f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} load1={la[0]} load5={la[1]} load15={la[2]} "
                            f"job={sum(r['worker'] for r in gov.values())} amano={extra} listener_fermi={sum(r['stopped'] for r in gov.values())} "
                            f"browser={nb}\n")
            except OSError:
                pass
        time.sleep(TICK)


def _comm(p):
    try:
        return open(f"/proc/{p}/comm").read().strip()
    except OSError:
        return ""


if __name__ == "__main__":
    main()
