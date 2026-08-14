import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { FieldLockControl } from '../components/FieldLockControl';
import {
  FieldActionsControl,
  actionsToDraft,
  draftToActions,
  type FieldActionsDraft,
} from '../components/FieldActionsControl';
import { DATE_FORMATS, TIME_FORMATS } from '../lib/af-calc';
import { actionsFromScripts } from '../lib/af-emit';
import { getCanvasServices, getCommandContext, invokeCommand } from '../commands/context';
import { ghostscriptPath, tesseractPath } from '../lib/ocr-recognize';
import { DEFAULT_OCR_LANGUAGE } from '../ocr/languages';
import { readFormFields, type FormField } from '../lib/forms';
import {
  lockNeedsFields,
  DEFAULT_LOCK,
  LOCK_ACTION_LABEL,
  type LockOptions,
} from '../lib/signatures';
import { tChrome, tChromeCount } from '../i18n';
import {
  candidateKind,
  checkedCandidates,
  pageSelectionState,
  removeCandidate,
  renameCandidate,
  retypeCandidate,
  selectionState,
  effectiveActions,
  setCandidateActions,
  setCandidateLock,
  setCandidateMultiline,
  setCheckedAll,
  setCheckedOnPage,
  toggleCandidate,
  type CandidateKind,
  type DetectionResult,
  type FieldCandidate,
} from '../lib/form-candidates';

// The review surface for automatic field detection.
//
// **Detection produces CANDIDATES, and nothing reaches the file until the user
// accepts one.** The panel lists what was found, the canvas draws it as a
// provisional overlay in a treatment no widget uses, and "Create checked
// fields" is the only control here that changes a document — through the same
// batch authoring operation the hand-drawn placement card uses, so there is one
// field-creation path rather than two.
//
// The detection call goes through the GATED `call`, not `callRaw`: a
// candidate's page is a position IN THE FILE and the field it becomes is
// authored against the committed page order, and those agree only after pending
// page edits are flushed.

const KIND_KEYS: Record<CandidateKind, 'panel.prepareForm.kindText' | 'panel.prepareForm.kindCheckbox' | 'panel.prepareForm.kindRadio' | 'panel.prepareForm.kindSignature'> = {
  text: 'panel.prepareForm.kindText',
  checkbox: 'panel.prepareForm.kindCheckbox',
  radio: 'panel.prepareForm.kindRadio',
  signature: 'panel.prepareForm.kindSignature',
};

const REASON_KEYS: Record<string, 'panel.prepareForm.reasonRuleWithoutLabel' | 'panel.prepareForm.reasonCovered' | 'panel.prepareForm.reasonRadioDemoted'> = {
  rule_without_label: 'panel.prepareForm.reasonRuleWithoutLabel',
  covered_by_existing_field: 'panel.prepareForm.reasonCovered',
  radio_demoted: 'panel.prepareForm.reasonRadioDemoted',
};

type Scope = { kind: 'document' | 'page' | 'pages'; pages: string };

function parsePages(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let p = Math.min(from, to); p <= Math.max(from, to); p += 1) out.add(p);
      continue;
    }
    const single = Number(part.trim());
    if (Number.isInteger(single) && single > 0) out.add(single);
  }
  return [...out].sort((a, b) => a - b);
}

export function PrepareFormPanel(): React.ReactElement {
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();

  const [candidates, setCandidates] = useState<FieldCandidate[]>([]);
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [scope, setScope] = useState<Scope>({ kind: 'document', pages: '' });
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  // The document's own fields: the names a lock can choose from, and the
  // signature fields whose seed the properties section below edits.
  const [fields, setFields] = useState<FormField[]>([]);
  // Per-field pending lock edits, keyed by field name — an edit is applied
  // deliberately, never on every keystroke of a checkbox list.
  const [lockDrafts, setLockDrafts] = useState<Record<string, LockOptions>>({});
  const [applyingLock, setApplyingLock] = useState<string | null>(null);
  // Per-field pending property edits, keyed by field name. Like the lock
  // drafts, an edit is applied deliberately — writing a property rewrites the
  // file, so it is not a per-keystroke act.
  const [actionDrafts, setActionDrafts] = useState<Record<string, FieldActionsDraft>>({});
  const [applyingActions, setApplyingActions] = useState<string | null>(null);

  const path = activeFile?.path ?? null;
  const workingPath = activeFile?.workingPath ?? null;
  const buffer = activeFile?.buffer ?? null;

  // The canvas owns the candidate set; this mirrors it so an overlay the user
  // drags, or a buffer change that invalidates the whole list, shows here too.
  const sync = useCallback(() => {
    const services = getCanvasServices();
    setCandidates(services ? services.formCandidates.list() : []);
  }, []);

  useEffect(() => {
    sync();
    const services = getCanvasServices();
    if (!services) return;
    return services.formCandidates.subscribe(sync);
  }, [sync]);

  useEffect(() => {
    // A different document is a different form; the previous document's
    // candidates name regions that are not on screen.
    setCandidates([]);
    setResult(null);
    setStatus('');
    setError(null);
    getCanvasServices()?.formCandidates.clear();
  }, [path]);

  // Re-read whenever the file's bytes change identity — a create, an applied
  // lock, an undo. `read_form_fields` is an INTERNAL method, so this never
  // gates a commit of the user's pending page edits.
  useEffect(() => {
    let cancelled = false;
    if (!buffer || !workingPath) {
      setFields([]);
      setLockDrafts({});
      return;
    }
    readFormFields(call, workingPath)
      .then((read) => {
        if (cancelled) return;
        setFields(read.fields);
        // The file is the baseline: a draft that survived the write would show
        // the document as carrying something it does not.
        setLockDrafts({});
        setActionDrafts({});
      })
      .catch(() => {
        if (!cancelled) setFields([]);
      });
    return () => {
      cancelled = true;
    };
  }, [buffer, workingPath, call]);

  const publish = useCallback(
    (next: FieldCandidate[]) => {
      setCandidates(next);
      getCanvasServices()?.formCandidates.update(next);
    },
    [],
  );

  const detect = useCallback(async () => {
    if (!workingPath || !path) return;
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      const pages =
        scope.kind === 'document'
          ? 'all'
          : scope.kind === 'page'
            ? parsePages(scope.pages || '1')
            : parsePages(scope.pages);
      if (scope.kind !== 'document' && (pages as number[]).length === 0) {
        setError(tChrome('panel.prepareForm.noPages'));
        return;
      }
      // A page with nothing readable on it is a scan, and its rules and
      // labels come back through the recogniser — so the vendored binaries
      // travel with every call, not only when the user knows to ask.
      const [tesseract, gs] = await Promise.all([tesseractPath(), ghostscriptPath()]);
      const detection = (await call('detect_form_fields', {
        file: workingPath,
        pages,
        scan: 'auto',
        lang: DEFAULT_OCR_LANGUAGE,
        tesseract_path: tesseract,
        gs_path: gs,
      })) as unknown as DetectionResult;
      setResult(detection);
      const services = getCanvasServices();
      if (!services) {
        setError(tChrome('panel.prepareForm.noCanvas'));
        return;
      }
      const { shown } = await services.formCandidates.publish(path, detection);
      setStatus(
        shown === 0
          ? tChrome('panel.prepareForm.foundNone')
          : tChromeCount('panel.prepareForm.found', shown),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [call, path, scope, workingPath]);

  const create = useCallback(async () => {
    const chosen = checkedCandidates(candidates);
    if (chosen.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const services = getCanvasServices();
      if (!services) {
        setError(tChrome('panel.prepareForm.noCanvas'));
        return;
      }
      const { created } = await services.formCandidates.accept(chosen.map((c) => c.id));
      setStatus(tChromeCount('panel.prepareForm.created', created));
      setResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [candidates]);

  // What a candidate's lock can name: the document's own fillable fields plus
  // the fields this batch is about to create. A lock governs form fields, so
  // signature fields are not offered as targets.
  const lockableNames = useMemo(() => {
    const names = fields.filter((f) => f.type !== 'signature').map((f) => f.name);
    for (const candidate of candidates) {
      if (candidate.kind !== 'signature' && candidate.name && !names.includes(candidate.name)) {
        names.push(candidate.name);
      }
    }
    return names;
  }, [fields, candidates]);

  const signatureFields = useMemo(() => fields.filter((f) => f.type === 'signature'), [fields]);

  /** The fields whose Format / Accepted range / Calculate can be edited. A
   * calculation writes a value, which only a text field holds; a format shows
   * one, which a dropdown does too. */
  const propertyFields = useMemo(
    () => fields.filter((f) => f.type === 'text' || f.type === 'dropdown'),
    [fields],
  );

  /** What a calculation on `field` may read: every other field of the
   * document. A field cannot read itself, and the write refuses if it tries. */
  const calculableNames = useCallback(
    (field: string) => propertyFields.filter((f) => f.name !== field).map((f) => f.name),
    [propertyFields],
  );

  /** The draft for a field: the pending edit when there is one, and otherwise
   * what the document itself carries, read back through the emitter's own
   * inverse so the editor shows the choice that wrote the scripts. */
  const actionsOf = useCallback(
    (field: FormField): FieldActionsDraft => {
      const pending = actionDrafts[field.name];
      if (pending) return pending;
      const read = actionsFromScripts(field.actions ?? {}, DATE_FORMATS, TIME_FORMATS);
      return actionsToDraft(Object.keys(read).length > 0 ? read : null);
    },
    [actionDrafts],
  );

  const applyActions = useCallback(
    async (field: FormField) => {
      const draft = actionDrafts[field.name];
      if (!path || !draft) return;
      setApplyingActions(field.name);
      setError(null);
      try {
        // Through the app handler, not the engine directly: writing a property
        // rewrites the file, and the signed-document decision belongs to the
        // one place every other edit takes it.
        const handlers = getCommandContext()?.app;
        if (!handlers) return;
        const written = await handlers.setFieldActions(
          path,
          field.name,
          draftToActions(draft),
        );
        setStatus(
          written
            ? tChrome('panel.prepareForm.propsApplied', { field: field.name })
            : tChrome('panel.prepareForm.lockDeclined'),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setApplyingActions(null);
      }
    },
    [actionDrafts, path],
  );

  const lockOf = useCallback(
    (field: FormField): LockOptions =>
      lockDrafts[field.name] ??
      (field.lock ? { action: field.lock.action, fields: [...field.lock.fields] } : DEFAULT_LOCK),
    [lockDrafts],
  );

  const applyLock = useCallback(
    async (field: FormField) => {
      const draft = lockDrafts[field.name];
      if (!path || !draft) return;
      setApplyingLock(field.name);
      setError(null);
      try {
        // Through the app handler, not the engine directly: writing a seed
        // rewrites the file, and the signed-document decision belongs to the
        // one place every other edit takes it.
        const handlers = getCommandContext()?.app;
        if (!handlers) return;
        const written = await handlers.setFieldLock(
          path,
          field.name,
          draft.action === null
            ? null
            : {
                action: draft.action,
                // `all` ignores names; sending them would discard the choice.
                fields: lockNeedsFields(draft.action) ? draft.fields : [],
              },
        );
        setStatus(
          written
            ? tChrome('panel.prepareForm.lockApplied', { field: field.name })
            : tChrome('panel.prepareForm.lockDeclined'),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setApplyingLock(null);
      }
    },
    [lockDrafts, path],
  );

  const pages = useMemo(
    () => [...new Set(candidates.map((c) => c.page))].sort((a, b) => a - b),
    [candidates],
  );
  const allState = selectionState(candidates);
  const checkedCount = candidates.filter((c) => c.checked).length;
  const truncated = result?.truncated ?? false;

  if (!activeFile) {
    return <NoFileOpen message={tChrome('panel.prepareForm.open')} onOpen={openNewFiles} />;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="prepare-form-panel">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')}{' '}
        <span className="text-neutral-200">{activeFile.name}</span>
      </div>

      <p className="text-xs text-neutral-400">{tChrome('panel.prepareForm.blurb')}</p>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-neutral-400" htmlFor="prepare-form-scope">
          {tChrome('panel.prepareForm.scope')}
        </label>
        <select
          id="prepare-form-scope"
          data-testid="prepare-form-scope"
          className="bg-neutral-800 text-sm rounded px-2 py-1"
          value={scope.kind}
          onChange={(e) => setScope({ ...scope, kind: e.target.value as Scope['kind'] })}
        >
          <option value="document">{tChrome('panel.prepareForm.scopeDocument')}</option>
          <option value="pages">{tChrome('panel.prepareForm.scopePages')}</option>
        </select>
        {scope.kind === 'pages' && (
          <input
            className="bg-neutral-800 text-sm rounded px-2 py-1"
            data-testid="prepare-form-pages"
            aria-label={tChrome('panel.prepareForm.pagesAria')}
            placeholder={tChrome('panel.prepareForm.pagesPlaceholder')}
            value={scope.pages}
            onChange={(e) => setScope({ ...scope, pages: e.target.value })}
          />
        )}
      </div>

      <button
        className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded px-3 py-1.5 text-sm"
        data-testid="prepare-form-detect"
        disabled={busy || creating}
        onClick={() => void detect()}
      >
        {busy ? tChrome('panel.prepareForm.detecting') : tChrome('panel.prepareForm.detect')}
      </button>

      <button
        type="button"
        onClick={() => invokeCommand('tools.formPrepFolder')}
        data-testid="prepare-form-folder"
        className="self-start text-xs text-neutral-400 hover:text-neutral-200 underline"
      >
        {tChrome('dialog.formPrep.openPanel')}
      </button>

      {error && <div className="text-sm text-red-400">{tChrome('panel.common.error', { message: error })}</div>}
      {status && <div className="text-sm text-neutral-300" data-testid="prepare-form-status">{status}</div>}

      {result && candidates.length === 0 && (
        <div className="text-xs text-neutral-400" data-testid="prepare-form-empty">
          {tChrome('panel.prepareForm.nothingOffered')}
        </div>
      )}

      {result && result.unoffered.length > 0 && (
        <ul className="text-xs text-neutral-400 list-disc ps-4" data-testid="prepare-form-unoffered">
          {result.unoffered.map((row) => (
            <li key={`${row.page}-${row.reason}`}>
              {tChrome(REASON_KEYS[row.reason] ?? 'panel.prepareForm.reasonOther', {
                page: row.page,
                count: row.count,
              })}
            </li>
          ))}
        </ul>
      )}

      {truncated && (
        <div className="text-xs text-amber-400" data-testid="prepare-form-truncated">
          {tChrome('panel.prepareForm.truncated')}
        </div>
      )}

      {candidates.length > 0 && (
        <div className="flex items-center gap-2 text-xs">
          <button
            className="underline"
            data-testid="prepare-form-select-all"
            disabled={truncated}
            onClick={() => publish(setCheckedAll(candidates, allState !== 'all'))}
          >
            {allState === 'all'
              ? tChrome('panel.prepareForm.selectNone')
              : tChrome('panel.prepareForm.selectAll')}
          </button>
          <span className="text-neutral-400">
            {tChromeCount('panel.prepareForm.checked', checkedCount)}
          </span>
        </div>
      )}

      {pages.map((page) => {
        const onPage = candidates.filter((c) => c.page === page);
        const state = pageSelectionState(candidates, page);
        return (
          <div key={page} className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input
                type="checkbox"
                data-testid={`prepare-form-page-${page}`}
                checked={state === 'all'}
                ref={(el) => {
                  if (el) el.indeterminate = state === 'some';
                }}
                onChange={() => publish(setCheckedOnPage(candidates, page, state !== 'all'))}
              />
              {tChrome('panel.prepareForm.pageHeading', { page })}
            </label>
            {onPage.map((candidate) => (
              <div
                key={candidate.id}
                className="flex flex-col gap-1 rounded border border-neutral-700 p-2"
                data-testid={`prepare-form-row-${candidate.name}`}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid={`prepare-form-check-${candidate.name}`}
                    checked={candidate.checked}
                    onChange={() => publish(toggleCandidate(candidates, candidate.id))}
                  />
                  <input
                    className="flex-1 bg-neutral-800 text-sm rounded px-2 py-1"
                    aria-label={tChrome('panel.prepareForm.nameAria')}
                    value={candidate.name}
                    onChange={(e) => publish(renameCandidate(candidates, candidate.id, e.target.value))}
                  />
                  <button
                    className="text-xs underline"
                    title={tChrome('panel.prepareForm.reveal')}
                    onClick={() => getCanvasServices()?.formCandidates.focus(candidate.id)}
                  >
                    {tChrome('panel.prepareForm.reveal')}
                  </button>
                  <button
                    className="text-xs underline"
                    title={tChrome('panel.prepareForm.discard')}
                    onClick={() => publish(removeCandidate(candidates, candidate.id))}
                  >
                    ×
                  </button>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <select
                    className="bg-neutral-800 rounded px-1 py-0.5"
                    aria-label={tChrome('panel.prepareForm.kindAria')}
                    value={candidate.kind}
                    onChange={(e) =>
                      publish(
                        retypeCandidate(candidates, candidate.id, candidateKind(e.target.value)),
                      )
                    }
                  >
                    {(Object.keys(KIND_KEYS) as CandidateKind[]).map((kind) => (
                      <option key={kind} value={kind}>
                        {tChrome(KIND_KEYS[kind])}
                      </option>
                    ))}
                  </select>
                  {candidate.kind === 'text' && (
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={candidate.multiline}
                        onChange={(e) =>
                          publish(
                            setCandidateMultiline(candidates, candidate.id, e.target.checked),
                          )
                        }
                      />
                      {tChrome('panel.prepareForm.multiline')}
                    </label>
                  )}
                  {candidate.label && (
                    <span className="text-neutral-500 truncate">
                      {tChrome('panel.prepareForm.fromLabel', { label: candidate.label })}
                    </span>
                  )}
                  {candidate.format === 'date' && (
                    <span className="text-neutral-500">{tChrome('panel.prepareForm.looksLikeDate')}</span>
                  )}
                  {candidate.exportValue && (
                    <span className="text-neutral-500">
                      {tChrome('panel.prepareForm.optionValue', { value: candidate.exportValue })}
                    </span>
                  )}
                </div>
                {candidate.kind === 'text' && (
                  <FieldActionsControl
                    value={actionsToDraft(effectiveActions(candidate))}
                    onChange={(next) =>
                      publish(setCandidateActions(candidates, candidate.id, draftToActions(next)))
                    }
                    fieldNames={calculableNames(candidate.name)}
                    idPrefix={`prepare-form-candidate-${candidate.name}`}
                  />
                )}
                {candidate.kind === 'signature' && (
                  <FieldLockControl
                    value={
                      candidate.lock
                        ? { action: candidate.lock.action, fields: [...candidate.lock.fields] }
                        : DEFAULT_LOCK
                    }
                    onChange={(next) =>
                      publish(
                        setCandidateLock(
                          candidates,
                          candidate.id,
                          next.action === null
                            ? null
                            : {
                                action: next.action,
                                // `all` ignores names, so carrying them would
                                // send a pair the write refuses.
                                fields: lockNeedsFields(next.action) ? next.fields : [],
                              },
                        ),
                      )
                    }
                    fieldNames={lockableNames}
                    idPrefix={`prepare-form-candidate-${candidate.name}`}
                  />
                )}
              </div>
            ))}
          </div>
        );
      })}

      {candidates.length > 0 && (
        <button
          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded px-3 py-1.5 text-sm"
          data-testid="prepare-form-create"
          disabled={creating || checkedCount === 0}
          onClick={() => void create()}
        >
          {creating
            ? tChrome('panel.prepareForm.creating')
            : tChromeCount('panel.prepareForm.create', checkedCount)}
        </button>
      )}

      <div className="flex flex-col gap-2 border-t border-neutral-700 pt-3" data-testid="prepare-form-sigfields">
        <div className="text-sm text-neutral-300">{tChrome('panel.prepareForm.sigFields')}</div>
        <p className="text-xs text-neutral-400">{tChrome('panel.prepareForm.sigFieldsBlurb')}</p>
        {signatureFields.length === 0 && (
          <div className="text-xs text-neutral-500" data-testid="prepare-form-sigfields-none">
            {tChrome('panel.prepareForm.sigFieldsNone')}
          </div>
        )}
        {signatureFields.map((field) => (
          <div
            key={field.name}
            className="flex flex-col gap-1.5 rounded border border-neutral-700 p-2"
            data-testid={`prepare-form-sigfield-${field.name}`}
          >
            <div className="text-xs text-neutral-200 truncate">{field.name}</div>
            {field.filled ? (
              <>
                <div
                  className="text-[11px] text-neutral-400"
                  data-testid={`prepare-form-sigfield-locked-${field.name}`}
                >
                  {field.lock
                    ? tChrome(LOCK_ACTION_LABEL[field.lock.action], {
                        fields: field.lock.fields.join(', '),
                      })
                    : tChrome('panel.prepareForm.lockNone')}
                </div>
                <div className="text-[11px] text-amber-300">
                  {tChrome('panel.prepareForm.sigFieldSigned')}
                </div>
              </>
            ) : (
              <>
                <FieldLockControl
                  value={lockOf(field)}
                  onChange={(next) =>
                    setLockDrafts((prev) => ({ ...prev, [field.name]: next }))
                  }
                  fieldNames={lockableNames}
                  idPrefix={`prepare-form-sigfield-${field.name}`}
                />
                <button
                  className="self-start bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded px-2 py-1 text-xs"
                  data-testid={`prepare-form-sigfield-apply-${field.name}`}
                  disabled={!lockDrafts[field.name] || applyingLock !== null}
                  onClick={() => void applyLock(field)}
                >
                  {applyingLock === field.name
                    ? tChrome('panel.prepareForm.lockApplying')
                    : tChrome('panel.prepareForm.lockApply')}
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 border-t border-neutral-700 pt-3" data-testid="prepare-form-fieldprops">
        <div className="text-sm text-neutral-300">{tChrome('panel.prepareForm.fieldProps')}</div>
        <p className="text-xs text-neutral-400">{tChrome('panel.prepareForm.fieldPropsBlurb')}</p>
        {propertyFields.length === 0 && (
          <div className="text-xs text-neutral-500" data-testid="prepare-form-fieldprops-none">
            {tChrome('panel.prepareForm.fieldPropsNone')}
          </div>
        )}
        {propertyFields.map((field) => (
          <div
            key={field.name}
            className="flex flex-col gap-1.5 rounded border border-neutral-700 p-2"
            data-testid={`prepare-form-fieldprop-${field.name}`}
          >
            <div className="text-xs text-neutral-200 truncate">{field.name}</div>
            <FieldActionsControl
              value={actionsOf(field)}
              onChange={(next) => setActionDrafts((prev) => ({ ...prev, [field.name]: next }))}
              fieldNames={calculableNames(field.name)}
              idPrefix={`prepare-form-fieldprop-${field.name}`}
              showCalculate={field.type === 'text'}
            />
            <button
              className="self-start bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded px-2 py-1 text-xs"
              data-testid={`prepare-form-fieldprop-apply-${field.name}`}
              disabled={!actionDrafts[field.name] || applyingActions !== null}
              onClick={() => void applyActions(field)}
            >
              {applyingActions === field.name
                ? tChrome('panel.prepareForm.propsApplying')
                : tChrome('panel.prepareForm.propsApply')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
