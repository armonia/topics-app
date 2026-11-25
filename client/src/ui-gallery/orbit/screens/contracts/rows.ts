import type { Contract } from '../../../../ui/fixtures/orbit-org/types';
import type { ContractRowModel } from '../../../../ui/contracts/model';
import type { Tone } from '../../../../ui/types';
import type { ScreenCtx } from '../../../app/kit';
import { liveCards } from '../../model/live';
import { contractAlerts, currentValue, daysTo, formatMoney, formatShare, kindLabel, noticeDate, statusLabel, variantShare } from '../../model/contracts';
import { relDay } from './actions';
import { today } from './view';
import { longDay, STATUS_TONE } from './model';

const ALERT_RANK: Record<'error' | 'warn' | 'info', number> = { error: 0, warn: 1, info: 2 };
const ALERT_TONE: Record<'error' | 'warn' | 'info', Tone> = { error: 'red', warn: 'amber', info: 'blue' };

/** One contract as the list draws it; the table of contracts in «Dati» reuses it for the phone. */
export function row(ctx: ScreenCtx, c: Contract): ContractRowModel {
  const t = ctx.copy.contracts;
  const day = today(ctx);
  const notice = noticeDate(c);
  const alerts = contractAlerts(c, day, liveCards(ctx.state)).sort((a, b) => ALERT_RANK[a.tone] - ALERT_RANK[b.tone]);
  const value = currentValue(c);
  const lastSigned = c.versions.filter((v) => v.signed).reduce((n, v) => Math.max(n, v.n), 1);
  const noticeIn = notice ? daysTo(notice, day) : undefined;
  const noticeLive = noticeIn !== undefined && noticeIn >= 0;
  return {
    id: c.id,
    kindText: kindLabel[c.kind],
    title: c.title,
    counterparty: c.counterparty,
    counterpartyKind: c.counterpartyKind,
    statusText: statusLabel[c.status],
    statusTone: STATUS_TONE[c.status],
    valueText: t.common.euro(formatMoney(value)),
    valueDetail: value !== c.value
      ? `${formatShare(variantShare(c, lastSigned))} · ${t.page.facts.valueChanged(t.common.version(lastSigned))}`
      : c.valuePeriod === 'anno' ? t.common.perYear : t.common.vatExcluded, // allow-italian: data code compared by value
    startText: t.list.since(longDay(c.start)),
    endText: c.end ? longDay(c.end) : t.list.noEnd,
    endMissing: !c.end,
    noticeText: notice ? longDay(notice) : t.list.noNotice,
    noticeMissing: !notice,
    noticeDetail: notice && noticeLive
      ? c.renewal.kind === 'tacito' ? t.list.noticeDetail.tacit(relDay(ctx, notice, day)) : t.list.noticeDetail.option(relDay(ctx, notice, day)) // allow-italian: data code compared by value
      : undefined,
    noticeTone: noticeLive ? (noticeIn <= 30 ? 'red' : noticeIn <= 180 ? 'amber' : undefined) : undefined,
    renewalText: c.renewal.kind === 'tacito' ? t.list.renewal.tacit(c.renewal.months) : c.renewal.kind === 'opzione' ? t.list.renewal.option(c.renewal.months) : t.list.renewal.none, // allow-italian: data codes compared by value
    renewalMissing: c.renewal.kind !== 'tacito' && c.renewal.kind !== 'opzione', // allow-italian: data codes compared by value
    alerts: alerts.length,
    alertTone: alerts.length ? ALERT_TONE[alerts[0].tone] : 'neutral',
    alertTitle: alerts[0]?.title,
  };
}
