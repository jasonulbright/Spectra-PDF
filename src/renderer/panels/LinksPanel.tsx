import React, { useEffect, useCallback } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { useLinkDrafts } from '../state/AppStateProvider';
import { runCommitGate } from '../lib/commit-gate';
import { dialog } from '../lib/tauri-bridge';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, type UiKey } from '../i18n';
import { getCanvasServices } from '../commands/context';
import {
  AUTHORED_KINDS,
  AUTHORED_STYLES,
  HIGHLIGHT_MODES,
  VIEW_MODES,
  VIEW_OPERANDS,
  appearanceProblem,
  colorToTriple,
  defaultAppearance,
  emptyTarget,
  isAuthored,
  targetProblem,
  tripleToColor,
  type AuthoredKind,
  type LinkAppearance,
  type LinkRecord,
  type LinkTarget,
  type LinkView,
  type LinkViewMode,
  type NamedDestination,
} from '../lib/links';

// The Links tool's panel. Three regions in the order the work happens: the
// rectangle just drawn on the page, the links the document already carries,
// and the bulk pass that derives links from addresses in the text. Drawing is
// a canvas gesture (`linkdraw`); everything a link IS — where it goes, how its
// border looks — is decided here, because a target is a decision rather than
// a drag.

const KIND_KEYS: Record<string, UiKey> = {
  uri: 'panel.links.kind.uri',
  goto: 'panel.links.kind.goto',
  named: 'panel.links.kind.named',
  file: 'panel.links.kind.file',
  launch: 'panel.links.kind.launch',
  other: 'panel.links.kind.other',
  none: 'panel.links.kind.none',
  internal: 'panel.links.kind.goto',
};

const VIEW_KEYS: Record<LinkViewMode, UiKey> = {
  inherit: 'panel.links.view.inherit',
  xyz: 'panel.links.view.xyz',
  fit: 'panel.links.view.fit',
  fith: 'panel.links.view.fith',
  fitv: 'panel.links.view.fitv',
  fitr: 'panel.links.view.fitr',
  fitb: 'panel.links.view.fitb',
  fitbh: 'panel.links.view.fitbh',
  fitbv: 'panel.links.view.fitbv',
};

const OPERAND_KEYS = {
  left: 'panel.links.view.left',
  top: 'panel.links.view.top',
  right: 'panel.links.view.right',
  bottom: 'panel.links.view.bottom',
  zoom: 'panel.links.view.zoom',
} as const satisfies Record<string, UiKey>;

const STYLE_KEYS = {
  solid: 'panel.links.appearance.solid',
  dashed: 'panel.links.appearance.dashed',
  underline: 'panel.links.appearance.underline',
  beveled: 'panel.links.appearance.beveled',
  inset: 'panel.links.appearance.inset',
} as const satisfies Record<string, UiKey>;

const HIGHLIGHT_KEYS = {
  none: 'panel.links.appearance.highlight.none',
  invert: 'panel.links.appearance.highlight.invert',
  outline: 'panel.links.appearance.highlight.outline',
  push: 'panel.links.appearance.highlight.push',
} as const satisfies Record<string, UiKey>;

const FIELD = 'w-full px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm';
const LABEL = 'flex flex-col gap-1 text-xs text-neutral-400';

/** A number typed into an optional field: blank means "not stated", which is
 * a different answer from zero. */
function optionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

interface EditorProps {
  /** Distinguishes the two editors' test ids and input names. */
  slug: string;
  target: LinkTarget;
  onTarget: (target: LinkTarget) => void;
  appearance: LinkAppearance;
  onAppearance: (appearance: LinkAppearance) => void;
  pageCount: number;
  names: readonly NamedDestination[];
  disabled: boolean;
}

/** The target and border editor, shared by Create and Edit so a link authored
 * either way is described by the same controls. */
function LinkEditor({
  slug,
  target,
  onTarget,
  appearance,
  onAppearance,
  pageCount,
  names,
  disabled,
}: EditorProps): React.ReactElement {
  const view: LinkView =
    target.kind === 'goto' || target.kind === 'file'
      ? (target.view ?? { mode: 'inherit' })
      : { mode: 'inherit' };
  const setView = (next: LinkView): void => {
    if (target.kind === 'goto' || target.kind === 'file') onTarget({ ...target, view: next });
  };
  const showView = target.kind === 'goto' || (target.kind === 'file' && target.page != null);

  return (
    <div className="flex flex-col gap-2">
      <label className={LABEL}>
        {tChrome('panel.links.kind')}
        <select
          data-testid={`${slug}-kind`}
          className={FIELD}
          value={target.kind}
          disabled={disabled}
          onChange={(e) => onTarget(emptyTarget(e.target.value as AuthoredKind))}
        >
          {AUTHORED_KINDS.map((k) => (
            <option key={k} value={k}>
              {tChrome(KIND_KEYS[k])}
            </option>
          ))}
        </select>
      </label>

      {target.kind === 'uri' && (
        <label className={LABEL}>
          {tChrome('panel.links.url')}
          <input
            data-testid={`${slug}-url`}
            type="text"
            className={`${FIELD} ltr-notation`}
            placeholder="https://…"
            spellCheck={false}
            value={target.url}
            disabled={disabled}
            onChange={(e) => onTarget({ kind: 'uri', url: e.target.value })}
          />
        </label>
      )}

      {target.kind === 'goto' && (
        <label className={LABEL}>
          {tChrome('panel.links.page')}
          <input
            data-testid={`${slug}-page`}
            type="number"
            min={1}
            max={pageCount || undefined}
            className={FIELD}
            value={target.page ?? ''}
            disabled={disabled}
            onChange={(e) => onTarget({ ...target, page: optionalNumber(e.target.value) })}
          />
        </label>
      )}

      {target.kind === 'named' && (
        <label className={LABEL}>
          {tChrome('panel.links.name')}
          {names.length === 0 ? (
            <span className="text-neutral-500" data-testid={`${slug}-name-empty`}>
              {tChrome('panel.links.name.none')}
            </span>
          ) : (
            <select
              data-testid={`${slug}-name`}
              className={FIELD}
              value={target.name}
              disabled={disabled}
              onChange={(e) => onTarget({ kind: 'named', name: e.target.value })}
            >
              <option value="">—</option>
              {names.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.page == null ? d.name : `${d.name} (${d.page})`}
                </option>
              ))}
            </select>
          )}
        </label>
      )}

      {target.kind === 'file' && (
        <>
          <label className={LABEL}>
            {tChrome('panel.links.file')}
            <div className="flex items-center gap-2">
              <input
                data-testid={`${slug}-file`}
                type="text"
                className={`${FIELD} ltr-notation`}
                spellCheck={false}
                value={target.path}
                disabled={disabled}
                onChange={(e) => onTarget({ ...target, path: e.target.value })}
              />
              <button
                type="button"
                data-testid={`${slug}-file-browse`}
                className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded whitespace-nowrap"
                disabled={disabled}
                onClick={() => {
                  void (async () => {
                    const picked = await dialog.openFiles();
                    if (picked.length > 0) onTarget({ ...target, path: picked[0] });
                  })();
                }}
              >
                {tChrome('panel.links.file.browse')}
              </button>
            </div>
          </label>
          <p className="text-xs text-neutral-500">{tChrome('panel.links.file.hint')}</p>
          <label className={LABEL}>
            {tChrome('panel.links.file.page')}
            <input
              data-testid={`${slug}-file-page`}
              type="number"
              min={1}
              className={FIELD}
              value={target.page ?? ''}
              disabled={disabled}
              onChange={(e) => onTarget({ ...target, page: optionalNumber(e.target.value) })}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <input
              data-testid={`${slug}-file-newwindow`}
              type="checkbox"
              checked={target.new_window === true}
              disabled={disabled}
              onChange={(e) => onTarget({ ...target, new_window: e.target.checked })}
            />
            {tChrome('panel.links.file.newWindow')}
          </label>
        </>
      )}

      {showView && (
        <>
          <label className={LABEL}>
            {tChrome('panel.links.view')}
            <select
              data-testid={`${slug}-view`}
              className={FIELD}
              value={view.mode}
              disabled={disabled}
              onChange={(e) => setView({ mode: e.target.value as LinkViewMode })}
            >
              {VIEW_MODES.map((m) => (
                <option key={m} value={m}>
                  {tChrome(VIEW_KEYS[m])}
                </option>
              ))}
            </select>
          </label>
          {VIEW_OPERANDS[view.mode].map((operand) => (
            <label key={operand} className={LABEL}>
              {tChrome(OPERAND_KEYS[operand])}
              <input
                data-testid={`${slug}-view-${operand}`}
                type="number"
                className={FIELD}
                value={view[operand] ?? ''}
                disabled={disabled}
                onChange={(e) => setView({ ...view, [operand]: optionalNumber(e.target.value) })}
              />
            </label>
          ))}
        </>
      )}

      <div className="text-xs text-neutral-300 pt-1">{tChrome('panel.links.appearance')}</div>
      <label className={LABEL}>
        {tChrome('panel.links.appearance.width')}
        <input
          data-testid={`${slug}-width`}
          type="number"
          min={0}
          step={0.5}
          className={FIELD}
          value={appearance.width}
          disabled={disabled}
          onChange={(e) => onAppearance({ ...appearance, width: Number(e.target.value) })}
        />
        {/* N17: a DERIVED status of the width beside it, not a field of its
            own. Standing alone above empty space in the label's own type and
            colour, it read as a control that had failed to render. Inside the
            width label it reads as what it is: what width 0 means. */}
        {appearance.width === 0 && (
          <span className="text-xs text-neutral-500 italic" data-testid={`${slug}-invisible`}>
            {tChrome('panel.links.appearance.invisible')}
          </span>
        )}
      </label>
      {appearance.width === 0 ? null : (
        <>
          <label className={LABEL}>
            {tChrome('panel.links.appearance.style')}
            <select
              data-testid={`${slug}-style`}
              className={FIELD}
              value={appearance.style}
              disabled={disabled}
              onChange={(e) =>
                onAppearance({ ...appearance, style: e.target.value as LinkAppearance['style'] })
              }
            >
              {AUTHORED_STYLES.map((s) => (
                <option key={s} value={s}>
                  {tChrome(STYLE_KEYS[s])}
                </option>
              ))}
              {/* A style the document carries that this app does not author is
                  still named, so the border it has is not silently relabelled. */}
              {!(AUTHORED_STYLES as readonly string[]).includes(appearance.style) && (
                <option value={appearance.style}>{tChrome(STYLE_KEYS[appearance.style])}</option>
              )}
            </select>
          </label>
          <label className={LABEL}>
            {tChrome('panel.links.appearance.color')}
            <input
              data-testid={`${slug}-color`}
              type="color"
              className="w-16 h-7 bg-neutral-900 border border-neutral-700 rounded"
              value={tripleToColor(appearance.color)}
              disabled={disabled}
              onChange={(e) =>
                onAppearance({ ...appearance, color: colorToTriple(e.target.value) })
              }
            />
          </label>
        </>
      )}
      <label className={LABEL}>
        {tChrome('panel.links.appearance.highlight')}
        <select
          data-testid={`${slug}-highlight`}
          className={FIELD}
          value={appearance.highlight}
          disabled={disabled}
          onChange={(e) =>
            onAppearance({ ...appearance, highlight: e.target.value as LinkAppearance['highlight'] })
          }
        >
          {HIGHLIGHT_MODES.map((h) => (
            <option key={h} value={h}>
              {tChrome(HIGHLIGHT_KEYS[h])}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function LinksPanel(): React.ReactElement {
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();
  const drafts = useLinkDrafts();
  const session = drafts.get(activeFile);
  const draft = session?.draft ?? null;
  const pending = draft?.kind === 'create' ? draft : null;
  const editing = draft?.kind === 'edit' ? draft : null;
  const links = session?.links ?? [];
  const names = session?.names ?? [];
  const busy = session?.busy ?? false;
  const ready = !!session && drafts.ready(session);
  const conflict = !!session && drafts.conflict(session);
  const pageCount = activeFile?.pageCount ?? 0;
  const derivePages = session?.query.pages ?? 'all';
  const deriveEmails = session?.query.emails ?? true;
  const found = session?.found?.buffer === activeFile?.buffer
    && session?.found?.query === session?.query ? session?.found ?? null : null;
  const status = conflict && !busy ? tChrome('panel.links.sourceChanged')
    : session?.error ? tChrome('panel.common.error', { message: session.error })
    : session?.loading ? tChrome('dialog.common.loading') : session?.status ?? '';
  const newTarget = pending?.target ?? emptyTarget('uri');
  const newAppearance = pending?.appearance ?? defaultAppearance();
  const editTarget = editing?.target ?? emptyTarget('uri');
  const editAppearance = editing?.appearance ?? defaultAppearance();
  const destinationNames = names.map(d => d.name);
  const newProblem = targetProblem(newTarget, { pageCount, names: destinationNames }) ?? appearanceProblem(newAppearance);
  const editProblem = targetProblem(editTarget, { pageCount, names: destinationNames }) ?? appearanceProblem(editAppearance);

  useEffect(() => { if (session) void drafts.load(session, call); });
  useEffect(() => () => { if (session) drafts.cancelLoad(session); }, [session, drafts]);
  const setNewTarget = (target: LinkTarget) => { if (session && pending) drafts.patchDraft(session, pending, { target }); };
  const setNewAppearance = (appearance: LinkAppearance) => { if (session && pending) drafts.patchDraft(session, pending, { appearance }); };
  const setEditTarget = (target: LinkTarget) => { if (session && editing) drafts.patchDraft(session, editing, { target }); };
  const setEditAppearance = (appearance: LinkAppearance) => { if (session && editing) drafts.patchDraft(session, editing, { appearance }); };
  const discard = () => { if (session) drafts.discard(session); };
  const beginEdit = (link: LinkRecord) => { if (session) drafts.beginEdit(session, link); };
  const setDerivePages = (pages: string) => { if (session) drafts.setQuery(session, { pages }); };
  const setDeriveEmails = (emails: boolean) => { if (session) drafts.setQuery(session, { emails }); };
  const findAddresses = useCallback(async () => { if (session) await drafts.find(session, call); }, [session, drafts, call]);
  const createDerivedLinks = useCallback(async () => { if (session) await drafts.derive(session, performOperation); }, [session, drafts, performOperation]);
  const createLink = useCallback(async () => { if (session) await drafts.save(session, performOperation); }, [session, drafts, performOperation]);
  const applyEdit = useCallback(async () => { if (session) await drafts.save(session, performOperation); }, [session, drafts, performOperation]);
  const deleteLink = useCallback(async (link: LinkRecord) => {
    if (session) await drafts.remove(session, link, performOperation);
  }, [session, drafts, performOperation]);


  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.links.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span>
      </div>

      <div className="flex flex-col gap-2 p-3 bg-neutral-800/40 border border-neutral-800 rounded" data-testid="links-draw">
        <div className="text-sm text-neutral-200">{tChrome('panel.links.draw.title')}</div>
        {pending === null ? (
          <p className="text-xs text-neutral-500" data-testid="links-draw-hint">
            {tChrome('panel.links.draw.hint')}
          </p>
        ) : (
          <>
            <div className="text-xs text-neutral-400" data-testid="links-draw-pending">
              {tChrome('panel.links.draw.pending', { page: pending.page })}
            </div>
            <LinkEditor
              slug="link-new"
              target={newTarget}
              onTarget={setNewTarget}
              appearance={newAppearance}
              onAppearance={setNewAppearance}
              pageCount={pageCount}
              names={names}
              disabled={!ready || conflict}
            />
            {newProblem && (
              <span className="text-xs text-amber-400" data-testid="link-new-problem" role="alert">
                {tChrome(newProblem as UiKey)}
              </span>
            )}
            <div className="flex items-center gap-2">
              <button
                data-testid="link-new-create"
                onClick={() => void createLink()}
                disabled={busy || !ready || conflict || newProblem !== null}
                className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded"
              >
                {tChrome('panel.links.draw.create')}
              </button>
              <button
                data-testid="link-new-discard"
                onClick={discard}
                disabled={busy}
                className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded"
              >
                {tChrome('panel.links.draw.discard')}
              </button>
            </div>
          </>
        )}
      </div>

      {session && (conflict || session.error || !ready && !session.loading) && <div role="alert" data-testid="links-revision-notice">
        <p>{conflict ? tChrome('panel.links.sourceChanged') : tChrome('app.history.changed')}</p>
        <button data-testid="links-reload" disabled={busy} onClick={() => void drafts.reload(session, runCommitGate)}>
          {draft ? tChrome('panel.links.discardReload') : tChrome('app.commit.retry')}
        </button>
      </div>}
      {links.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid={ready ? "links-empty" : "links-loading"}>{ready ? tChrome('panel.links.empty') : tChrome('dialog.common.loading')}</p>
      ) : (
        <div className="flex flex-col gap-1" data-testid="links-list">
          <div className="text-sm text-neutral-300" data-testid="links-summary">
            {tChromeCount('panel.links.summary', links.length)}
          </div>
          {links.map((l) => {
            const isEditing = editing?.page === l.page && editing?.index === l.index;
            return (
              <div
                key={`${l.page}:${l.index}`}
                data-testid="link-item"
                data-link-kind={l.kind}
                className="flex flex-col gap-2 px-3 py-2 bg-neutral-800/60 border border-neutral-800 rounded"
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-neutral-500">
                      {tChrome('panel.links.pageKind', {
                        page: l.page,
                        kind: tChrome(KIND_KEYS[l.kind] ?? 'panel.links.kind.other'),
                      })}
                    </div>
                    <div className="text-sm text-neutral-200 truncate" title={l.target}>
                      {l.target || tChrome('panel.links.noTarget')}
                    </div>
                  </div>
                  <button
                    data-testid={`link-jump-${l.page}-${l.index}`}
                    onClick={() => getCanvasServices()?.jumpToFilePage(activeFile.path, l.page)}
                    disabled={busy || !ready || conflict}
                    className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded"
                  >
                    {tChrome('panel.links.jump')}
                  </button>
                  <button
                    data-testid={`link-edit-${l.page}-${l.index}`}
                    onClick={() => (isEditing ? discard() : beginEdit(l))}
                    disabled={busy || !ready || conflict}
                    className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded"
                  >
                    {tChrome('panel.links.edit.open')}
                  </button>
                  <button
                    data-testid={`link-delete-${l.page}-${l.index}`}
                    onClick={() => void deleteLink(l)}
                    disabled={busy || !ready || conflict}
                    className="text-xs danger-action is-quiet"
                  >
                    {tChrome('panel.links.delete')}
                  </button>
                </div>
                {isEditing && (
                  <div className="flex flex-col gap-2 pt-1 border-t border-neutral-800">
                    <div className="text-xs text-neutral-400">
                      {tChrome('panel.links.edit.title', { page: l.page })}
                    </div>
                    {!isAuthored(l.target_spec.kind) && (
                      <p className="text-xs text-amber-400" data-testid={`link-readonly-${l.page}-${l.index}`}>
                        {tChrome('panel.links.edit.readOnly', {
                          action: tChrome(KIND_KEYS[l.target_spec.kind] ?? 'panel.links.kind.other'),
                        })}
                      </p>
                    )}
                    <LinkEditor
                      slug={`link-edit-${l.page}-${l.index}`}
                      target={editTarget}
                      onTarget={setEditTarget}
                      appearance={editAppearance}
                      onAppearance={setEditAppearance}
                      pageCount={pageCount}
                      names={names}
                      disabled={!ready || conflict}
                    />
                    {editProblem && (
                      <span
                        className="text-xs text-amber-400"
                        data-testid={`link-problem-${l.page}-${l.index}`}
                        role="alert"
                      >
                        {tChrome(editProblem as UiKey)}
                      </span>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        data-testid={`link-save-${l.page}-${l.index}`}
                        onClick={() => void applyEdit()}
                        disabled={busy || !ready || conflict || editProblem !== null}
                        className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded"
                      >
                        {tChrome('panel.links.edit.apply')}
                      </button>
                      <button
                        data-testid={`link-cancel-${l.page}-${l.index}`}
                        onClick={discard}
                        disabled={busy}
                        className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded"
                      >
                        {tChrome('panel.links.edit.cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-2 p-3 bg-neutral-800/40 border border-neutral-800 rounded" data-testid="links-derive">
        <div className="text-sm text-neutral-200">{tChrome('panel.links.derive.title')}</div>
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          {tChrome('panel.links.derive.pages')}
          <input
            data-testid="links-derive-pages"
            type="text"
            value={derivePages}
            onChange={(e) => {
              setDerivePages(e.target.value);
            }}
            className="flex-1 px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <input
            data-testid="links-derive-emails"
            type="checkbox"
            checked={deriveEmails}
            onChange={(e) => {
              setDeriveEmails(e.target.checked);
            }}
          />
          {tChrome('panel.links.derive.emails')}
        </label>
        <div className="flex items-center gap-2">
          <button
            data-testid="links-derive-find"
            onClick={() => void findAddresses()}
            disabled={busy || !ready || conflict}
            className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded"
          >
            {tChrome('panel.links.derive.find')}
          </button>
          <button
            data-testid="links-derive-create"
            onClick={() => void createDerivedLinks()}
            disabled={busy || found === null || found.count - found.already === 0}
            className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded"
          >
            {tChrome('panel.links.derive.create')}
          </button>
        </div>
        {found && (
          <div className="text-xs text-neutral-400" data-testid="links-derive-count">
            {tChrome('panel.links.derive.found', {
              count: found.count,
              existing: found.already,
            })}
          </div>
        )}
      </div>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
