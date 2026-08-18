import { test, expect, describe, beforeEach } from 'bun:test';
import {
  computeTopicsFootprint,
  serverMetricLabel,
  _resetTopicsFootprintSmoothing,
} from './topicsFootprint';

beforeEach(() => {
  _resetTopicsFootprintSmoothing();
});

describe('computeTopicsFootprint', () => {
  test('sul telefono (deviceMB null) il totale e il solo lato server', () => {
    const fp = computeTopicsFootprint(null, 0, false, 200, 5, 'rss', 0, 0);
    expect(fp.deviceMB).toBeNull();
    expect(fp.serverMB).toBe(200);
    expect(fp.totalMB).toBe(200);
    expect(fp.partial).toBe(false);
  });

  test('device + server si sommano nel totale', () => {
    const fp = computeTopicsFootprint(300, 10, false, 200, 5, 'footprint', 0, 0);
    expect(fp.deviceMB).toBe(300);
    expect(fp.totalMB).toBe(500);
  });

  test('scripts e escluso dal totale', () => {
    const fp = computeTopicsFootprint(300, 10, false, 200, 5, 'footprint', 477, 8);
    expect(fp.scriptsMB).toBe(477);
    expect(fp.scriptsProcessCount).toBe(8);
    // totale non include scripts
    expect(fp.totalMB).toBe(500);
  });

  test('partial propagato correttamente', () => {
    const fp = computeTopicsFootprint(300, 10, true, 200, 5, 'mixed', 0, 0);
    expect(fp.partial).toBe(true);
    expect(fp.serverMetric).toBe('mixed');
  });

  test('EMA smorza la oscillazione del lato server', () => {
    // Primo campione: il server vale 1000 MB
    const fp1 = computeTopicsFootprint(300, 10, false, 1000, 5, 'footprint', 0, 0);
    expect(fp1.serverMB).toBe(1000); // primo valore = raw

    // Secondo campione: il server crolla a 200 MB (come dopo un pnpm install)
    const fp2 = computeTopicsFootprint(300, 10, false, 200, 5, 'footprint', 0, 0);
    // Con EMA alpha=0.25: smoothed = 0.25*200 + 0.75*1000 = 800
    expect(fp2.serverMB).toBe(800);
    // Il totale e' smorzato, non crolla di botto
    expect(fp2.totalMB).toBeGreaterThan(fp2.deviceMB!);

    // Al terzo campione continua a scendere gradualmente
    const fp3 = computeTopicsFootprint(300, 10, false, 200, 5, 'footprint', 0, 0);
    expect(fp3.serverMB).toBeLessThan(fp2.serverMB);
  });

  test('_resetTopicsFootprintSmoothing azzera lo stato EMA', () => {
    computeTopicsFootprint(null, 0, false, 1000, 5, 'footprint', 0, 0);
    _resetTopicsFootprintSmoothing();
    // Dopo reset il primo valore e raw, non smorzato
    const fp = computeTopicsFootprint(null, 0, false, 100, 5, 'footprint', 0, 0);
    expect(fp.serverMB).toBe(100);
  });

  test('la somma dei tre assi e uguale al totale piu scripts', () => {
    const deviceMB = 400;
    const serverFleetMB = 300;
    const scriptsMB = 150;
    const fp = computeTopicsFootprint(deviceMB, 10, false, serverFleetMB, 5, 'footprint', scriptsMB, 3);
    // totale = device + server (smorzato)
    expect(fp.totalMB).toBe(deviceMB + fp.serverMB);
    // scripts e fuori dal totale
    expect(fp.scriptsMB).toBe(scriptsMB);
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
