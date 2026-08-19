import { test, expect, describe, beforeEach } from 'bun:test';
import {
  computeTopicsFootprint,
  serverMetricLabel,
  _resetTopicsFootprintSmoothing,
  type TopicsUsageInput,
} from './topicsFootprint';

beforeEach(() => {
  _resetTopicsFootprintSmoothing();
});

/** Letture "tutto misurato", da variare caso per caso. */
function letture(over: Partial<TopicsUsageInput> = {}): TopicsUsageInput {
  return {
    deviceMB: 300,
    deviceProcessCount: 10,
    devicePartial: false,
    deviceCpu: 12,
    serverMB: 200,
    serverProcessCount: 5,
    serverMetric: 'footprint',
    serverCpu: 8,
    scriptsMB: 0,
    scriptsProcessCount: 0,
    ...over,
  };
}

describe('computeTopicsFootprint · memoria', () => {
  test('device + server si sommano nel totale', () => {
    const fp = computeTopicsFootprint(letture());
    expect(fp.deviceMB).toBe(300);
    expect(fp.totalMB).toBe(500);
    expect(fp.totalProcessCount).toBe(15);
    expect(fp.memPartial).toBe(false);
  });

  test('sul telefono (deviceMB null) il totale e il solo lato server, dichiarato parziale', () => {
    const fp = computeTopicsFootprint(letture({ deviceMB: null, deviceProcessCount: 0, deviceCpu: null }));
    expect(fp.deviceMB).toBeNull();
    expect(fp.serverMB).toBe(200);
    expect(fp.totalMB).toBe(200);
    expect(fp.totalProcessCount).toBe(5);
    expect(fp.memPartial).toBe(true);
  });

  test('lettura della sola shell (Windows/Linux): totale dichiarato parziale', () => {
    const fp = computeTopicsFootprint(letture({ devicePartial: true }));
    expect(fp.totalMB).toBe(500);
    expect(fp.memPartial).toBe(true);
  });

  test('nessuna delle due meta misurata: nessun numero, non 0 MB', () => {
    const fp = computeTopicsFootprint(letture({
      deviceMB: null, deviceProcessCount: 0, deviceCpu: null,
      serverMB: null, serverProcessCount: 0, serverCpu: null,
    }));
    expect(fp.totalMB).toBeNull();
    expect(fp.totalProcessCount).toBe(0);
    expect(fp.memPartial).toBe(false);
  });

  test('scripts e escluso dal totale', () => {
    const fp = computeTopicsFootprint(letture({ scriptsMB: 477, scriptsProcessCount: 8 }));
    expect(fp.scriptsMB).toBe(477);
    expect(fp.scriptsProcessCount).toBe(8);
    expect(fp.totalMB).toBe(500);
  });
});

describe('computeTopicsFootprint · percentuale', () => {
  test('entrambe misurate: il totale e la somma', () => {
    const fp = computeTopicsFootprint(letture());
    expect(fp.totalCpu).toBe(20);
    expect(fp.cpuPartial).toBe(false);
  });

  test('solo il server: totale dichiarato parziale', () => {
    const fp = computeTopicsFootprint(letture({ deviceCpu: null }));
    expect(fp.totalCpu).toBe(8);
    expect(fp.cpuPartial).toBe(true);
  });

  test('nessuna delle due: nessun numero, non 0%', () => {
    const fp = computeTopicsFootprint(letture({ deviceCpu: null, serverCpu: null }));
    expect(fp.totalCpu).toBeNull();
    expect(fp.cpuPartial).toBe(false);
  });

  test('app ferma: zero e una misura e resta zero, non sparisce', () => {
    const fp = computeTopicsFootprint(letture({ deviceCpu: 0, serverCpu: 0 }));
    expect(fp.totalCpu).toBe(0);
    expect(fp.cpuPartial).toBe(false);
  });
});

describe('computeTopicsFootprint · smorzamento', () => {
  test('EMA smorza la oscillazione del lato server', () => {
    // Primo campione: il server vale 1000 MB
    const fp1 = computeTopicsFootprint(letture({ serverMB: 1000 }));
    expect(fp1.serverMB).toBe(1000); // primo valore = raw

    // Secondo campione: il server crolla a 200 MB (come dopo un pnpm install)
    const fp2 = computeTopicsFootprint(letture({ serverMB: 200 }));
    // Con EMA alpha=0.25: smoothed = 0.25*200 + 0.75*1000 = 800
    expect(fp2.serverMB).toBe(800);
    // Il totale e' smorzato, non crolla di botto
    expect(fp2.totalMB!).toBeGreaterThan(fp2.deviceMB!);

    // Al terzo campione continua a scendere gradualmente
    const fp3 = computeTopicsFootprint(letture({ serverMB: 200 }));
    expect(fp3.serverMB!).toBeLessThan(fp2.serverMB!);
  });

  test('un campione mancante non entra nell EMA come zero', () => {
    computeTopicsFootprint(letture({ serverMB: 1000 }));
    const mancante = computeTopicsFootprint(letture({ serverMB: null, serverProcessCount: 0 }));
    expect(mancante.serverMB).toBeNull();
    // Tornato il campione, l'EMA riparte dal valore di prima e non da zero.
    const ripreso = computeTopicsFootprint(letture({ serverMB: 1000 }));
    expect(ripreso.serverMB).toBe(1000);
  });

  test('lo stesso campione letto due volte non fa avanzare l EMA', () => {
    computeTopicsFootprint(letture({ serverMB: 1000, sampleKey: 'a' }));
    // Stesso `sampleKey`: due superfici aperte insieme, o un re-render.
    const primo = computeTopicsFootprint(letture({ serverMB: 200, sampleKey: 'b' }));
    const stesso = computeTopicsFootprint(letture({ serverMB: 200, sampleKey: 'b' }));
    expect(stesso.serverMB).toBe(primo.serverMB!);
    // Un campione davvero nuovo invece avanza.
    const dopo = computeTopicsFootprint(letture({ serverMB: 200, sampleKey: 'c' }));
    expect(dopo.serverMB!).toBeLessThan(primo.serverMB!);
  });

  test('_resetTopicsFootprintSmoothing azzera lo stato EMA', () => {
    computeTopicsFootprint(letture({ serverMB: 1000 }));
    _resetTopicsFootprintSmoothing();
    // Dopo reset il primo valore e raw, non smorzato
    const fp = computeTopicsFootprint(letture({ serverMB: 100 }));
    expect(fp.serverMB).toBe(100);
  });
});

describe('serverMetricLabel', () => {
  test('footprint', () => {
    expect(serverMetricLabel('footprint')).toBe('footprint');
  });
  test('rss', () => {
    expect(serverMetricLabel('rss')).toBe('RSS (stima alta)');
  });
  test('mixed', () => {
    expect(serverMetricLabel('mixed')).toBe('footprint parziale');
  });
});
