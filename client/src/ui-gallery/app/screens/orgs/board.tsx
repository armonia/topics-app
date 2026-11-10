/**
 * n17 «Una Board per tutte le organizzazioni»: one Board for every (allow-italian: quotes the Italian interface)
 * organization the person belongs to. `/board/<org>` opens it filtered on one
 * organization. Case cards follow the status of their case (moving one changes
 * the case); tasks of the Board alone are kept in `ctx.slice('board')`.
 */
import { Button } from '../../../../ui/primitives/Button';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { BoardScreen } from '../../../../ui/board/BoardScreen';
import { NewCardForm, type NewCardValues } from '../../../../ui/board/NewCardForm';
import type { BoardColumnId, BoardColumnModel } from '../../../../ui/board/model';
import { BOARD_COLUMNS, BOARD_NEW_AREA, type BoardTaskSeed } from '../../../../ui/fixtures/board';
import { ORGS } from '../../../../ui/fixtures/org/people';
import type { OrgKey } from '../../../../ui/fixtures/org/types';
import type { Params, ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { BOARD_INITIAL, COLUMN_CASE_STATUS, ORG_TONE, boardItems, matches, toCardModel, type BoardSlice } from './board-model';

interface DialogState {
  mode: 'new' | 'edit';
  id?: string;
  values: NewCardValues;
  /** Set after a try to save with no title. */
  invalid?: boolean;
}

export function renderBoard(params: Params, ctx: ScreenCtx) {
  const b = ctx.copy.orgs.board;
  const [query, setQuery] = ctx.ui<string>('board.q', '');
  const [slice, setSlice] = ctx.slice<BoardSlice>('board', BOARD_INITIAL);
  const [dialog, setDialog] = ctx.ui<DialogState | null>('board.dialog', null);

  const persona = ctx.persona;
  const myOrgs = ORGS.filter((o) => persona.orgs.includes(o.id));
  const activeOrg = params.org && myOrgs.some((o) => o.id === params.org) ? params.org : 'all';
  const items = boardItems(ctx.state, persona, slice, ctx.copy);
  const searched = items.filter((i) => matches(i, query));
  const shown = searched.filter((i) => activeOrg === 'all' || i.org === activeOrg);
  const labels = b.columns;

  const columns: BoardColumnModel[] = BOARD_COLUMNS.map((id) => ({
    id,
    label: labels[id],
    cards: shown.filter((i) => i.column === id).map(toCardModel),
  }));
  const orgChips = myOrgs.map((o) => ({ id: o.id, label: o.name, count: searched.filter((i) => i.org === o.id).length, tone: ORG_TONE[o.id] }));

  const touch = (prev: BoardSlice, id: string): string[] => [id, ...prev.touched.filter((x) => x !== id)];

  const move = (id: string, to: BoardColumnId) => {
    const item = items.find((i) => i.id === id);
    if (!item || item.column === to) return;
    const title = item.title;
    const done = () => {
      ctx.toast({ tone: 'ok', title: b.toastMoved(labels[to]), body: title });
    };
    if (item.kind === 'case') {
      const status = COLUMN_CASE_STATUS[to];
      if (!status) {
        ctx.toast({ tone: 'info', title: b.caseNoBacklog, body: b.caseNoBacklogBody });
        return;
      }
      const apply = () => {
        ctx.updateCase(id, (live) => ({ ...live, status }), b.logMoved(title, labels[to]));
        setSlice((prev) => ({ ...prev, touched: touch(prev, id) }));
        done();
      };
      if (to === 'done') {
        ctx.confirm({ title: b.confirmCloseTitle, body: b.confirmCloseBody(title), confirmLabel: b.confirmClose, onConfirm: apply });
      } else {
        apply();
      }
      return;
    }
    setSlice((prev) => ({ ...prev, moved: { ...prev.moved, [id]: to }, touched: touch(prev, id) }));
    ctx.log(b.logMoved(title, labels[to]), 'case', P.board());
    done();
  };

  const open = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    if (item.path) {
      ctx.go(item.path);
      return;
    }
    // A card the reader added opens its own editor.
    const own = slice.added.find((t) => t.id === id);
    if (own) setDialog({ mode: 'edit', id, values: { title: own.title, org: own.org, column: slice.moved[id] ?? own.column, due: own.due ?? '' } });
  };

  const openNew = () => {
    const org = activeOrg !== 'all' ? activeOrg : (myOrgs[0]?.id ?? 'nocera');
    setDialog({ mode: 'new', values: { title: '', org, column: 'backlog', due: '' } });
  };

  const save = () => {
    if (!dialog) return;
    const v = dialog.values;
    if (!v.title.trim()) {
      setDialog({ ...dialog, invalid: true });
      return;
    }
    const title = v.title.trim();
    if (dialog.mode === 'new') {
      const id = `bt-n${slice.next}`;
      const task: BoardTaskSeed = {
        id, org: v.org as OrgKey, area: BOARD_NEW_AREA[v.org as OrgKey], title, column: v.column, due: v.due || undefined, target: { kind: 'org', org: v.org as OrgKey },
      };
      setSlice((prev) => ({ ...prev, added: [...prev.added, task], next: prev.next + 1, touched: touch(prev, id) }));
      ctx.log(b.logCreated(title, ORGS.find((o) => o.id === v.org)?.name ?? v.org), 'case', P.board(v.org));
      ctx.toast({ tone: 'ok', title: b.toastCreated, body: title });
    } else if (dialog.id) {
      const id = dialog.id;
      setSlice((prev) => ({
        ...prev,
        added: prev.added.map((t) => (t.id === id ? { ...t, title, org: v.org as OrgKey, due: v.due || undefined, area: BOARD_NEW_AREA[v.org as OrgKey] } : t)),
        moved: { ...prev.moved, [id]: v.column },
        touched: touch(prev, id),
      }));
      ctx.log(b.logEdited(title), 'case', P.board());
      ctx.toast({ tone: 'ok', title: b.toastSaved, body: title });
    }
    setDialog(null);
  };

  const remove = () => {
    if (!dialog?.id) return;
    const id = dialog.id;
    const title = dialog.values.title;
    ctx.confirm({
      title: b.confirmDeleteTitle,
      body: b.confirmDeleteBody(title),
      confirmLabel: b.confirmDelete,
      tone: 'danger',
      onConfirm: () => {
        setSlice((prev) => ({ ...prev, added: prev.added.filter((t) => t.id !== id), touched: prev.touched.filter((x) => x !== id) }));
        ctx.log(b.logDeleted(title), 'case', P.board());
        ctx.toast({ tone: 'ok', title: b.toastDeleted, body: title });
        setDialog(null);
      },
    });
  };

  const canMove = ctx.can('edit:data');
  return (
    <>
      <BoardScreen
        columns={columns}
        orgChips={orgChips}
        activeOrg={activeOrg}
        onOrg={(id) => ctx.go(id === 'all' ? P.board() : P.board(id))}
        query={query}
        onQuery={setQuery}
        totalVisible={shown.length}
        onOpen={open}
        onMove={move}
        onNew={ctx.allow('edit:data', openNew)}
        newTitle={ctx.deniedTitle('edit:data')}
        canMove={canMove}
        moveDeniedTitle={ctx.deniedTitle('edit:data')}
        onClear={() => { setQuery(''); if (activeOrg !== 'all') ctx.go(P.board()); }}
        copy={ctx.copy}
        phone={ctx.phone}
      />
      {dialog && (
        <Dialog
          title={dialog.mode === 'new' ? b.newCardTitle : b.editCardTitle}
          closeLabel={b.close}
          onClose={() => setDialog(null)}
          footer={(
            <>
              {dialog.mode === 'edit' && <Button variant="danger" onClick={remove}>{b.delete}</Button>}
              <span className="flex-1" />
              <Button onClick={() => setDialog(null)}>{b.cancel}</Button>
              <Button variant="primary" onClick={save}>{dialog.mode === 'new' ? b.create : b.save}</Button>
            </>
          )}
        >
          <NewCardForm
            values={dialog.values}
            onChange={(patch) => setDialog({ ...dialog, values: { ...dialog.values, ...patch }, invalid: false })}
            orgOptions={myOrgs.map((o) => ({ value: o.id, label: o.name }))}
            columnOptions={BOARD_COLUMNS.map((c) => ({ value: c, label: labels[c] }))}
            titleError={dialog.invalid ? b.form.titleRequired : undefined}
            copy={ctx.copy}
            onEnter={save}
          />
        </Dialog>
      )}
    </>
  );
}

