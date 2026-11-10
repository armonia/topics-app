import { CircleCheck } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Dialog } from '../primitives/Dialog';
import type { ReceiptModel } from './model';

/**
 * The receipt of something that left the system (a filing, a PEC, a payment):
 * what it says, line by line, as the other side returned it.
 */
export function ReceiptDialog({ receipt, copy, onClose, onOpenSheet }: {
  receipt: ReceiptModel;
  copy: UiCopy;
  onClose: () => void;
  onOpenSheet?: () => void;
}) {
  return (
    <Dialog
      title={receipt.title}
      onClose={onClose}
      closeLabel={copy.common.close}
      footer={
        <>
          {onOpenSheet && <Button onClick={onOpenSheet}>{copy.work.record.openSheet}</Button>}
          <Button variant="primary" onClick={onClose}>{copy.work.record.receiptClose}</Button>
        </>
      }
    >
      <p className="mb-3 flex items-center gap-2 text-prose font-medium text-emerald-700 dark:text-emerald-400">
        <CircleCheck size={16} aria-hidden="true" />{receipt.at}
      </p>
      <ul className="space-y-1.5 rounded-lg border border-app-border bg-app-inset px-3.5 py-3 font-mono text-compact leading-5 text-app-text">
        {receipt.lines.map((l) => <li key={l}>{l}</li>)}
      </ul>
    </Dialog>
  );
}
