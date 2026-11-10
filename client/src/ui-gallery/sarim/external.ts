/**
 * Opening a public page from the SARIM edition (a law on normattiva.it, a
 * page of sarimambiente.it, a town on the ARERA portal): first a confirm that
 * says where it goes, then a new window. One function for every area, so a
 * source link behaves the same in «Dati», «Conoscenza», «Programmi» and (allow-italian: quotes the Italian interface)
 * «Impostazioni». (allow-italian: quotes the Italian interface)
 */
import type { ScreenCtx } from '../app/kit';

export function openExternal(ctx: Pick<ScreenCtx, 'confirm' | 'copy'>, url: string) {
  const e = ctx.copy.sarimData.common.external;
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  ctx.confirm({ title: e.title(host), body: e.body(url), confirmLabel: e.confirm, onConfirm: () => { window.open(url, '_blank', 'noopener'); } });
}
