# Sul transcript della sessione TERMINALE di Attilio (73f11438, CLI interattiva, entrypoint "cli"):
# quante fini turno (assistant stop_reason=end_turn, la riga che precede lo Stop hook) avvengono
# con lavoro in background ancora vivo.
#  - lancio: tool_use Workflow (sempre background), Monitor, Agent/Bash con run_in_background=true;
#    il task id si legge dal tool_result ("Task ID: x", "agentId: x", "with ID: x", "task x").
#  - chiusura: <task-notification> di quel task-id con <status>, o un evento Monitor di fine
#    ("Monitor expired", "stream ended", "stopped"), o TaskStop {task_id}; oppure 2 h senza notizie
#    (lo stesso tetto di BACKGROUND_WORK_CAP_MS, cosi' un task perso non gonfia il conto).
import json, re, sys
from datetime import datetime
F = sys.argv[1]
CAP = 2 * 3600
def ts(o):
    t = o.get('timestamp')
    return datetime.fromisoformat(t.replace('Z', '+00:00')).timestamp() if t else None
launch_by_tool = {}          # tool_use_id -> name
live = {}                    # task_id -> {name, last}
ends = {"no_bg": 0, "bg_non_monitor": 0, "bg_monitor_only": 0}
seen_msg = set()
mapped = {'ok': 0}
examples = []
ID_RE = re.compile(r'(?:Task ID:|agentId:|with ID:|task(?: id)?[: ])\s*([A-Za-z0-9_-]{6,})')
for l in open(F):
    try: o = json.loads(l)
    except Exception: continue
    if o.get('isSidechain'): continue
    now = ts(o)
    m = o.get('message') or {}
    c = m.get('content')
    if now is not None:
        for k in [k for k, v in live.items() if now - v['last'] > CAP]: live.pop(k)
    if o.get('type') == 'assistant' and isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get('type') == 'tool_use':
                n = b.get('name'); i = b.get('input') or {}
                if n in ('Workflow', 'Monitor') or (n in ('Agent', 'Task', 'Bash') and i.get('run_in_background') is True):
                    launch_by_tool[b['id']] = n
                if n == 'TaskStop' and isinstance(i.get('task_id'), str): live.pop(i['task_id'], None)
        if m.get('stop_reason') == 'end_turn' and m.get('id') not in seen_msg:
            seen_msg.add(m.get('id'))
            names = [v['name'] for v in live.values()]
            if not names: ends['no_bg'] += 1
            elif any(x != 'Monitor' for x in names): ends['bg_non_monitor'] += 1
            else: ends['bg_monitor_only'] += 1
            if names and len(examples) < 4: examples.append((o.get('timestamp'), sorted(set(names)), len(names)))
    if o.get('type') == 'user':
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get('type') == 'tool_result' and b.get('tool_use_id') in launch_by_tool:
                    txt = json.dumps(b.get('content'))
                    mm = ID_RE.search(txt)
                    if mm:
                        live[mm.group(1)] = {'name': launch_by_tool.pop(b['tool_use_id']), 'last': now or 0}; mapped['ok'] += 1
        txt = c if isinstance(c, str) else ''.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text') if isinstance(c, list) else ''
        for n in re.finditer(r'<task-notification>(.*?)</task-notification>', txt, re.S):
            body = n.group(1)
            tid = re.search(r'<task-id>(.*?)</task-id>', body)
            if not tid: continue
            tid = tid.group(1)
            if re.search(r'<status>', body) or re.search(r'Monitor expired|stream ended|\bstopped\b', body): live.pop(tid, None)
            elif tid in live: live[tid]['last'] = now or live[tid]['last']
total = sum(ends.values())
print('launches mapped to a task id:', mapped['ok'], 'unmapped:', len(launch_by_tool))
print(json.dumps({"turn_ends": total, **ends, "share_with_non_monitor_bg": round(ends['bg_non_monitor'] / total, 3) if total else None}, indent=1))
for e in examples: print('example turn end with live bg:', e)
