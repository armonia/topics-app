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
Prove: `ci-governor --selftest` (logica pura) · `--resume` (riprende tutti) · `--status` (cosa vede, senza toccare niente) · `--dry-run`.
"""
import os, re, signal, subprocess, sys, time

MAX_JOBS = int(os.environ.get("CI_MAX_JOBS", "2"))
LOAD_CAP = float(os.environ.get("CI_LOAD_CAP", "24"))
ROTATE_S = int(os.environ.get("CI_ROTATE_S", "20"))
REAP_GRACE = int(os.environ.get("CI_REAP_GRACE", "60"))
TICK = float(os.environ.get("CI_TICK", "2"))
# esenti, nel formato <prefisso>:<n> (es. ci-runner:0 = il servizio del runner di preparazione, leggero)
EXEMPT = {x.strip().replace(":", chr(64)) + ".service" for x in os.environ.get("CI_EXEMPT", "ci-runner:0").split(",")}
LOG = os.environ.get("CI_GOV_LOG", "/var/log/ci-governor.log")
LOADLOG = os.environ.get("CI_LOAD_LOG", "/var/log/ci-load.log")
KEEP_COMM = ("Runner.", "run.sh", "run-helper.sh", "runsvc.sh")


def decide(runners, load1, now, last_awake, max_jobs=MAX_JOBS, load_cap=LOAD_CAP, rotate_s=ROTATE_S, extra=0, served=None):
    """runners: {unit: {"worker": bool, "stopped": bool}} (solo i non esenti con un Listener).
    extra: suite Playwright lanciate a mano sul server con systemd-run (agenti): non sono job di un runner e
    non si fermano, ma pesano come un job e occupano un posto.
    served: quando ogni runner e' stato ripreso l'ultima volta (resta anche dopo la pausa): il turno va a chi
    aspetta da piu' tempo, senza di lui gli stessi due runner prendevano sempre i posti (22/11, CI di topics-app in coda 1 h 30).
    Ritorna (da_fermare, da_riprendere). Pura: niente I/O, provata da --selftest."""
    active = [u for u, r in runners.items() if r["worker"]]
    idle = [u for u, r in runners.items() if not r["worker"]]
    busy = len(active) + extra
    slots = max_jobs if load1 <= load_cap else min(max_jobs, busy)
    free = max(slots - busy, 0)
    if not active:                  # almeno un job di runner alla volta passa sempre: le suite a mano non affamano la CI
        free = max(free, 1)
    awake = [u for u in idle if not runners[u]["stopped"]]
    stopped = [u for u in idle if runners[u]["stopped"]]
    # chi è sveglio da troppo e ha altri in attesa cede il posto
    stale = [u for u in awake if now - last_awake.get(u, now) >= rotate_s and stopped]
    keep_awake = [u for u in awake if u not in stale]
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
    return stop, cont


def selftest():
    R = lambda w, s: {"worker": w, "stopped": s}
    D = lambda *a, **k: decide(*a, max_jobs=3, load_cap=20, **k)   # indipendenti dai default di ambiente
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
    # nessun job: tre posti, tre svegli
    st, co = D({k: R(0, 1) for k in "abcde"}, 1, 100, {})
    assert st == [] and len(co) == 3, (st, co)
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
    last_awake, idle_since, last_load, served = {}, {}, 0, {}
    log(f"avvio: tetto {MAX_JOBS} job, load1 massimo per ammetterne di nuovi {LOAD_CAP}, esenti {sorted(EXEMPT)}")

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
        extra = manual_suites()
        stop, cont = decide(gov, load1, now, last_awake, extra=extra, served=served)
        for u in stop:
            log(f"pausa {u} (job in corso {sum(r['worker'] for r in gov.values())}+{extra} a mano/{MAX_JOBS}, load1 {load1:.1f})")
            if not dry:
                os.kill(gov[u]["listener"], signal.SIGSTOP)
            last_awake.pop(u, None)
        for u in cont:
            log(f"riprendo {u} (job in corso {sum(r['worker'] for r in gov.values())}+{extra} a mano/{MAX_JOBS}, load1 {load1:.1f})")
            if not dry:
                os.kill(gov[u]["listener"], signal.SIGCONT)
            last_awake[u] = now
            served[u] = now
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
