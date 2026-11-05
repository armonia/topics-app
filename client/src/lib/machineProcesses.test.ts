/**
 * The machine's Processes as pure reads of the hub: GPU and network per
 * process, a dash where the hub did not measure, CPU only where it did, and
 * «Ferma» only on a running Topics script. Inputs are the hub's own shapes,
 * trimmed, with placeholder names.
 * @covers HUBBR-08
 * @covers HUBBR-09
 */
import { describe, expect, test } from 'bun:test';
import {
  NOT_MEASURED, cpuByPid, formatMem, formatPct, formatRate, logTone, macGauges, parseLogEvent, pcView, processRows, pushLogLine, serviceRows,
} from './machineProcesses';
import type { ScriptProcessInfo } from './api';

const census = {
  at: 1_000,
  summary: { netInBps: 2_400_000, netOutBps: 57_000 },
  units: [
    { id: 'app:/Applications/Browser.app', name: 'Browser', type: 'app', memMB: 2900, gpuPct: 21, netInBps: 1_900_000, netOutBps: 30_000, pids: [10, 11], use: { text: 'usata 3,4 h in 14 giorni' } },
    { id: 'devserver:42', name: 'Server di sviluppo · vite :5173 · acme-web', type: 'devserver', memMB: 1600, gpuPct: 0, netInBps: 8000, netOutBps: 2000, pids: [42, 43], use: { text: 'nessun client collegato' } },
    { id: 'altro:7', name: 'WebKit · GPU', type: 'altro', memMB: 510, gpuPct: null, netInBps: null, netOutBps: null, pids: [7], owner: { label: 'nessun padrone' } },
    { id: 'x', name: 'Strano', type: 'qualcosa', memMB: 20, pids: [] },
  ],
};
const mac = {
  cores: 12, swapUsedGB: 1.2, swapTotalGB: 8, mem: { totalGB: 32, usedGB: 26.8 },
  hogs: [{ pid: 10, cpu: 0.04 }],
  trees: [{ pid: 42, cpu: 0.09 }, { pid: 10, cpu: 0.02 }],
};
const machines = [
  { id: 'local', local: true, state: 'tranquillo', metrics: [{ key: 'cpu', pct: 31 }, { key: 'gpu', pct: 38 }] },
  { id: 'pc', local: false, state: 'lavora', caption: 'dorme dopo 20 min senza lavoro', lines: ['Collegato dal Mac'], metrics: [{ key: 'cpu', name: 'CPU', pct: 25, note: 'adesso' }], procs: [{ name: 'chrome-headless-shell', cores: 1.2 }], offload: 2 },
];
const script = (over: Partial<ScriptProcessInfo>): ScriptProcessInfo => ({
  processId: 'p-1', scriptName: 'dev', command: 'vite', projectPath: '/work/acme-web', status: 'running', pid: 43, startedAt: '', ports: [5173], ...over,
});

describe('per process: GPU and network, a dash where not measured', () => {
  test('GPU and network come from the census, null stays null', () => {
    const rows = processRows(census, mac, []);
    expect(rows[0]).toMatchObject({ name: 'Browser', gpuPct: 21, netInBps: 1_900_000, netOutBps: 30_000, memWarn: true, memShare: 1 });
    expect(rows[2]).toMatchObject({ gpuPct: null, netInBps: null, netOutBps: null, detail: 'nessun padrone' });
    expect(formatPct(rows[2]!.gpuPct)).toBe(NOT_MEASURED);
    expect(formatPct(rows[1]!.gpuPct)).toBe('0%');
  });

  test('CPU only on pids the hub measured, the larger reading when a pid is both a hog and a tree', () => {
    expect(cpuByPid(mac).get(10)).toBe(0.04);
    const rows = processRows(census, mac, []);
    expect(rows[0]!.cpuPct).toBe(4);
    expect(rows[1]!.cpuPct).toBe(9);
    expect(rows[2]!.cpuPct).toBeNull();
  });

  test('an unknown kind is drawn as a plain process', () => {
    expect(processRows(census, mac, [])[3]!.kind).toBe('altro');
  });
});

describe('«Ferma» only on a running Topics script', () => {
  test('matched by pid, with project, script and port', () => {
    const rows = processRows(census, mac, [script({})]);
    expect(rows[1]!.script).toEqual({ processId: 'p-1', scriptName: 'dev', projectPath: '/work/acme-web', project: 'acme-web', port: 5173 });
    expect(rows.filter((r) => r.script).length).toBe(1);
  });

  test('the project is the last folder on Windows too', () => {
    expect(processRows(census, mac, [script({ projectPath: 'C:\\Temp\\x\\acme-web' })])[1]!.script?.project).toBe('acme-web');
  });

  test('a finished script or a foreign pid gives no stop', () => {
    expect(processRows(census, mac, [script({ status: 'done' })]).some((r) => r.script)).toBe(false);
    expect(processRows(census, mac, [script({ pid: 999 })]).some((r) => r.script)).toBe(false);
  });

  test('matched by the census process id when the pid is gone', () => {
    const c = { units: [{ id: 'lavoro:1', type: 'lavoro', name: 'Comando di Topics · test', memMB: 30, processId: 'p-2', pids: [] }] };
    expect(processRows(c, null, [script({ processId: 'p-2', pid: null, ports: [] })])[0]!.script?.port).toBeNull();
  });
});

describe('the Mac, the PC and the services', () => {
  test('gauges: memory in GB from /api/mac, CPU and GPU from the machine list, network from the census', () => {
    expect(macGauges(mac, machines, census)).toEqual({
      cores: 12, totalGB: 32, state: 'tranquillo', cpuPct: 31, memUsedGB: 26.8, swapUsedGB: 1.2, swapTotalGB: 8, gpuPct: 38, netInBps: 2_400_000, netOutBps: 57_000,
    });
    expect(macGauges(null, null, null).cpuPct).toBeNull();
  });

  test('the PC with its state, sentences, heavy programs and the jobs from the Mac', () => {
    expect(pcView(machines)).toMatchObject({ state: 'lavora', offload: 2, heavy: [{ name: 'chrome-headless-shell', cores: 1.2 }], lines: ['Collegato dal Mac'] });
    expect(pcView([{ local: true }])).toBeNull();
    expect(pcView([{ local: false, state: 'boh' }])!.state).toBe('unknown');
  });

  test('services: stopped first, then a problem, then up, then waiting, off last', () => {
    const rows = serviceRows({ services: [
      { id: 'a', name: 'A', state: 'spento' },
      { id: 'b', name: 'B', state: 'vivo' },
      { id: 'c', name: 'C', state: 'in attesa' },
      { id: 'd', name: 'D', state: 'vivo', problem: 'non ascolta su :3342' },
      { id: 'e', name: 'E', state: 'fermo', port: 18791 },
    ] });
    expect(rows.map((r) => r.id)).toEqual(['e', 'd', 'b', 'c', 'a']);
    expect(rows[0]!.port).toBe(18791);
  });
});

describe('the proxy log', () => {
  test('one SSE line, its tone, newest first and capped', () => {
    const l = parseLogEvent('{"ts":"14:05:41","tag":"refresh","msg":"prof-c: refresh failed after retries"}');
    expect(l).toEqual({ ts: '14:05:41', tag: 'refresh', msg: 'prof-c: refresh failed after retries', tone: 'error' });
    expect(parseLogEvent('not json')).toBeNull();
    expect(parseLogEvent('{"tag":"system"}')).toBeNull();
    expect(logTone('auto-switch', 'prof-a -> prof-b')).toBe('warn');
    expect(logTone('proxy', '200 claude · acme-web')).toBe('ok');
    expect(logTone('info', 'API proxy on :3336')).toBe('plain');
    let lines = [l!];
    for (let i = 0; i < 5; i++) lines = pushLogLine(lines, { ...l!, ts: String(i) }, 3);
    expect(lines.map((x) => x.ts)).toEqual(['4', '3', '2']);
  });

  test('the figures read as the mockup writes them', () => {
    expect(formatMem(2969)).toBe('2,9 GB');
    expect(formatMem(980)).toBe('980 MB');
    expect(formatRate(14_336)).toBe('14 KB/s');
    expect(formatRate(1_887_437)).toBe('1,8 MB/s');
    expect(formatRate(208)).toBe('208 B/s');
  });
});
