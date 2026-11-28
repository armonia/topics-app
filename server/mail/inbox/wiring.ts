/** Builds the receiving round on the app's own settings and starts it. With no mailbox declared nothing runs. */
import type { Database } from "bun:sqlite";
import { readMailConfig, type MailAccount } from "../../lib/outbound-config";
import type { OwnerAlert } from "../../schedule/deliver/owner-alert";
import { getAppSettings } from "../../services/app-settings";
import { commandListAdapter } from "./contract";
import { createInbox } from "./inbox";
import { mergeMailboxes, parseMailboxes, type Mailbox } from "./mailboxes";

/** The send-side environment still declares mailboxes; a broken or absent environment is no mailbox. */
function envAccounts(): MailAccount[] {
  try { return readMailConfig(process.env).accounts; } catch { return []; }
}

/** The list as it is now: the setting wins over the environment entry of the same name. */
export function currentMailboxes(): Mailbox[] {
  return mergeMailboxes(parseMailboxes(getAppSettings().mailboxes), envAccounts());
}

export function startMailInbox(db: Database, alert: OwnerAlert, now: () => Date) {
  const inbox = createInbox({
    db, now, mailboxes: currentMailboxes, adapterFor: (box) => commandListAdapter(box),
    alert: (request) => { alert({ subject: request.subject, scope: request.scope, title: request.title, body: request.body }); },
  });
  inbox.start();
  return inbox;
}
