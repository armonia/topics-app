/**
 * The PC and the Hetzner server in the devices level: the row says the state,
 * the spend on the cap and the dot's colour; "switch off all" asks first and
 * only the confirmation runs it. The list is a function of its props, so it is
 * called and rendered with `renderToStaticMarkup` (no DOM here).
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { t } from '../../lib/i18n';
import type { HubMachine, HubMachineAction } from '../../lib/hubMachines';
import { HubMachineList, hubMachineDetail, hubMachineDot } from './HubMachineRows';

const tr = (key: string, vars?: Record<string, string | number>) => t(key, 'it', vars);
const switchOff: HubMachineAction = { id: 'spegni', label: 'Spegni tutti', method: 'POST', url: '/api/hetzner/spegni', confirm: 'Cancellare il server acceso?' };
const pc: HubMachine = { id: 'pc', name: 'PC', local: false, on: false, state: 'dorme', level: 0, caption: 'si sveglia da sola con offload' };
const hzOn: HubMachine = { id: 'hetzner', name: 'Server Hetzner', local: false, on: true, kind: 'cloud', state: '1 acceso', level: 0,
  lines: ['cx43 acceso da 12 min · 0,03 €/h'], spend: { eur: 3.83, cap: 20, warn: 15, over: false }, actions: [switchOff] };
const hzOver: HubMachine = { ...hzOn, on: false, state: 'spento', level: 2, lines: ['Oltre il tetto: si torna su GitHub/PC'], spend: { eur: 20.4, cap: 20, warn: 15, over: true }, actions: [] };

const render = (over: Partial<Parameters<typeof HubMachineList>[0]> = {}) => {
  const calls: string[] = [];
  const props = { machines: [pc, hzOn], confirming: null, busy: false, error: null, tr, locale: 'en',
    onAsk: (k: string) => calls.push('ask ' + k), onCancel: () => calls.push('cancel'), onRun: (a: HubMachineAction) => calls.push('run ' + a.id), ...over };
  return { html: renderToStaticMarkup(<HubMachineList {...props} />), calls, props };
};

describe('HubMachineList', () => {
  test('one row per machine, with the state, the spend on the cap and the action', () => {
    const { html } = render();
    expect(html.match(/data-testid="hub-machine-row"/g)?.length).toBe(2);
    expect(html).toContain('3.83 € su 20 € questo mese · cx43 acceso da 12 min');
    expect(html).toContain('1 acceso');
    expect(html.match(/data-testid="hub-machine-action"/g)?.length).toBe(1);
    expect(html).not.toContain('hub-machine-confirm');
  });

  test('the first press only asks: the row becomes the hub sentence, red button and Cancel', () => {
    const { html } = render({ confirming: 'hetzner:spegni' });
    expect(html).toContain('Cancellare il server acceso?');
    expect(html).toContain('data-testid="hub-machine-confirm"');
    expect(html).toContain('data-testid="hub-machine-cancel"');
    expect(html.match(/data-testid="hub-machine-row"/g)?.length).toBe(2);
  });

  test('only the confirmation runs the action', () => {
    const { props, calls } = render({ confirming: 'hetzner:spegni' });
    const tree = HubMachineList(props) as unknown as { props: { children: unknown[] } };
    const rows = (tree.props.children[0] as { props: { children: unknown } }[]);
    const confirmRow = rows[1] as { props: { children: { props: { onClick: () => void; 'data-testid': string } }[] } };
    const confirm = confirmRow.props.children.find((c) => c?.props?.['data-testid'] === 'hub-machine-confirm');
    confirm!.props.onClick();
    expect(calls).toEqual(['run spegni']);
  });

  test('over the cap: red dot, red state, no switch-off when nothing is on', () => {
    expect(hubMachineDot(hzOver)).toContain('bg-red');
    const { html } = render({ machines: [hzOver] });
    expect(html).toContain('Oltre il tetto: si torna su GitHub/PC');
    expect(html).not.toContain('hub-machine-action');
  });

  test('the dot: grey off, green on, amber busy', () => {
    expect(hubMachineDot(pc)).toContain('muted');
    expect(hubMachineDot(hzOn)).toContain('emerald');
    expect(hubMachineDot({ ...hzOn, level: 1 })).toContain('amber');
  });

  test('a refused action says why', () => {
    expect(render({ error: 'hub answered 502' }).html).toContain('Non riuscito: hub answered 502');
    expect(hubMachineDetail(pc, tr, 'en')).toBe('si sveglia da sola con offload');
  });
});
