/**
 * An attachment of a contract (`/conoscenza/contratti/:id/allegati/:doc`) as paper, like (allow-italian: address segments)
 * the original: its kind and version, its lines, and for a signed copy the
 * block of the digital signatures with the time and the fingerprint. The other
 * attachments of the contract sit beside it.
 */
import { FileX } from 'lucide-react';
import clsx from 'clsx';
import type { Contract } from '../../../../ui/fixtures/orbit-org/types';
import { personaById, world } from '../../world';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { PaperDocument } from '../../../../ui/contracts/Signatures';
import { AttachmentList } from '../../../../ui/contracts/SidePanels';
import type { AttachmentModel, PaperModel } from '../../../../ui/contracts/model';
import type { ScreenCtx } from '../../../app/kit';
import { contractsSlice, liveContractById } from '../../model/live';
import { formatMoney, latestVersion, versionOf, versionValue } from '../../model/contracts';
import { SP } from '../../paths';
import { ContractFrame, NotFound } from './frame';
import { attachmentKind, attachmentsOf } from './view';
import { fingerprint, stamp } from './model';

/**
 * The signers of a signed version: who signed for ORBIT and the other side.
 * The chain on file is the one of the latest version: only that version takes
 * its signer and its dates; an older signed copy keeps the date it carries.
 */
function signatureOf(ctx: ScreenCtx, c: Contract, version: number, at: string, text: string): PaperModel['signature'] {
  const t = ctx.copy.contracts.attachment;
  const receipt = contractsSlice(ctx.state).receipts?.[`${c.id}:v${version}`];
  const chain = version === latestVersion(c).n ? c.approvals : [];
  const sign = chain.find((s) => s.action === 'firma'); // allow-italian: data code compared by value
  const counter = chain.find((s) => s.action === 'controfirma'); // allow-italian: data code compared by value
  const ours = receipt ? { who: receipt.by, at: receipt.at } : { who: sign?.who ?? world().people.directorId, at: sign?.at && sign.state === 'fatto' ? sign.at : at }; // allow-italian: data code compared by value
  const theirs = counter?.state === 'fatto' && counter.at ? counter.at : at; // allow-italian: data code compared by value
  // A copy signed here shows the other side only once its countersignature is on file; a copy from the fixtures is signed by both.
  const countersigned = counter ? counter.state === 'fatto' : !receipt; // allow-italian: data code compared by value
  return {
    lines: [
      t.signedBy(personaById(ours.who)?.name ?? ours.who, world().words.legalName, stamp(ours.at)),
      ...(!countersigned ? [] : [t.signedBy(c.counterparty, ctx.copy.contracts.page.facts.counterparty.toLowerCase(), stamp(theirs))]),
      ...(receipt ? [t.register(receipt.register)] : []),
    ],
    hash: receipt?.hash ?? fingerprint(`${c.id}:${version}:${text}:${at}`),
  };
}

export function AttachmentPlace({ ctx, id, doc }: { ctx: ScreenCtx; id: string; doc: string }) {
  const c = liveContractById(ctx.state, id);
  if (!c) return <NotFound ctx={ctx} />;
  const t = ctx.copy.contracts;
  const all = attachmentsOf(ctx, c);
  const a = all.find((x) => x.id === doc);
  const list: AttachmentModel[] = all.map((x) => {
    const k = attachmentKind(ctx, x.kind);
    return { id: x.id, name: x.name, kindText: k.text, kindTone: k.tone, detail: t.side.attachments.detail(x.version ? t.common.version(x.version) : '', stamp(x.at).slice(0, 10)) };
  });
  let paper: PaperModel | undefined;
  if (a) {
    const k = attachmentKind(ctx, a.kind);
    const v = a.version !== undefined ? versionOf(c, a.version) : undefined;
    const sl = t.attachment.signedLines;
    // A copy signed in the preview has no lines of its own: it prints the head of the contract and its clauses.
    const lines = a.lines.length ? a.lines : [
      sl.contract(c.title),
      sl.counterparty(c.counterparty),
      sl.value(t.common.euro(formatMoney(versionValue(c, a.version ?? 1)))),
      sl.clauses(v?.clauses.length ?? 0),
      ...(v?.clauses.map((x) => `${t.page.clauseHeading(x.n, x.title)}. ${x.text}`) ?? []),
    ];
    paper = {
      title: a.name,
      kindText: k.text,
      versionText: a.version ? t.attachment.version(a.version) : undefined,
      at: stamp(a.at),
      lines,
      signature: a.kind === 'firmato' ? signatureOf(ctx, c, a.version ?? 1, a.at, lines.join('\n')) : undefined, // allow-italian: data code compared by value
    };
  }
  return (
    <ContractFrame ctx={ctx} c={c} page="attachments" crumb={a?.name ?? t.attachment.crumb}>
      <div className={clsx('grid gap-4 px-4 py-4', !ctx.phone && 'lg:grid-cols-[minmax(0,1fr)_320px]')}>
        <div className="min-w-0">
          {paper ? (
            <PaperDocument paper={paper} copy={ctx.copy} />
          ) : (
            <EmptyState icon={FileX} title={t.attachment.notFoundTitle} className="min-h-0 rounded-lg border border-app-border bg-surface py-10" action={<Button onClick={() => ctx.go(SP.contract(c.id))}>{t.page.back}</Button>}>
              {t.attachment.notFoundBody}
            </EmptyState>
          )}
        </div>
        <aside className="min-w-0 space-y-2">
          <h2 className="text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">{t.attachment.others}</h2>
          <AttachmentList items={list.filter((x) => x.id !== doc)} onOpen={(aid) => ctx.go(SP.attachment(c.id, aid))} copy={ctx.copy} />
        </aside>
      </div>
    </ContractFrame>
  );
}
