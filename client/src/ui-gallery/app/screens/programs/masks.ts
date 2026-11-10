/**
 * The windows the agent and the remote session draw: the accounting mask the
 * agent fills step by step, the Halley user form of the remote session, and
 * the small windows of the other PCs.
 */
import type { UiCopy } from '../../../../ui/copy/types';
import type { MaskFieldModel, MaskModel } from '../../../../ui/programs/model';
import {
  AGENT_MASK_FIELDS, AGENT_STEPS, AGENT_TASK, HALLEY_ROBOT_USER, INVOICES, type InvoiceExample,
} from '../../../../ui/fixtures/programs';

type Values = Record<string, string>;

function valuesOf(inv: InvoiceExample): Values {
  return {
    supplier: inv.supplier, vatProtocol: inv.vatProtocol, documentNumber: inv.documentNumber, documentDate: inv.documentDate,
    taxable: inv.taxable, vat: inv.vat, total: inv.total, vatCode: inv.vatCode, costCentre: inv.costCentre, due: inv.due,
    example: AGENT_TASK.exampleValue, vatNumber: '',
  };
}

export const invoiceAt = (i: number): InvoiceExample => INVOICES[i % INVOICES.length];

/**
 * The accounting window after `cursor` steps are done. The step in progress
 * has its fields typed and lit; the ones after it are still empty.
 */
export function accountingMask(cursor: number, invoice: InvoiceExample, registeredNumber?: string): MaskModel {
  const values = valuesOf(invoice);
  const done = new Set(AGENT_STEPS.slice(0, cursor).flatMap((s) => s.fields));
  const current = new Set(AGENT_STEPS[cursor]?.fields ?? []);
  const fields: MaskFieldModel[] = AGENT_MASK_FIELDS.map((f) => {
    const shown = done.has(f.id) || current.has(f.id) || f.id === 'vatNumber';
    return {
      id: f.id,
      label: f.label,
      value: shown ? values[f.id] ?? '' : '',
      column: f.column,
      active: current.has(f.id) && f.id === (AGENT_STEPS[cursor]?.fields.slice(-1)[0]),
      muted: f.id === 'example',
    };
  });
  return {
    program: AGENT_TASK.taskbar[0],
    title: cursor === 0 ? AGENT_TASK.menu[0] : AGENT_TASK.windowTitle,
    fields,
    menu: cursor === 0 ? { items: AGENT_TASK.menu, highlight: AGENT_TASK.menuHighlight } : undefined,
    result: registeredNumber,
    buttons: [{ id: 'cancel', label: AGENT_TASK.buttons[0] }, { id: 'save', label: AGENT_TASK.buttons[1], primary: true }],
    taskbarLeft: AGENT_TASK.taskbar,
  };
}

/** The Halley user form of the remote session; the password is typed by whoever holds the keyboard. */
export function halleyMask(copy: UiCopy, password: string, typing: ((v: string) => void) | undefined, buttons: MaskModel['buttons']): MaskModel {
  const m = copy.programs.remote.maskHalley;
  return {
    program: 'HALLEY',
    title: m.title,
    fields: [
      { id: 'user', label: m.user, value: HALLEY_ROBOT_USER },
      { id: 'password', label: m.password, value: password, secret: true, active: true, onChange: typing, placeholder: '' },
      { id: 'expiry', label: m.expiry, value: m.expiryValue },
    ],
    buttons,
    taskbarLeft: ['Halley'],
  };
}

/** A small window for the PCs that have no mask of their own here. */
export function plainMask(copy: UiCopy, program: string, rows: Array<[string, string]>): MaskModel {
  return {
    program,
    title: copy.programs.masks.explorer,
    fields: rows.map(([label, value], i) => ({ id: `r${i}`, label, value })),
    buttons: [],
    taskbarLeft: [program],
  };
}
