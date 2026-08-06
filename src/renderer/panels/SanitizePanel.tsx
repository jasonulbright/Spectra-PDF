import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { getCommandContext } from '../commands/context';
import { tChrome, tChromeCount } from '../i18n';
import {
  COSTLY_CATEGORIES,
  allRemovable,
  blockedReason,
  buildRequest,
  categoryOf,
  compare,
  emptySelection,
  isSelectable,
  residues,
  selectedCategories,
  textKindCount,
  toggle,
  type AuditCategory,
  type AuditDetail,
  type AuditReport,
  type ComparisonRow,
  type Selection,
} from '../lib/sanitize-report';

// The report IS the feature: a user sending a document out is entitled to be
// told what is in it before anything is removed, and to check what the removal
// actually achieved afterwards.
//
// The audit goes through the UNGATED read — it runs on open and re-runs on
// every buffer change, and an annotation is a pending page edit, so gating it
// would flush the user's just-drawn markup to disk merely for looking. The
// APPLY goes through the App handler, which routes it into the standard
// snapshot → gated call → reload flow, so one pass is one undo entry.
//
// Nothing is checked by default, and the automatic re-audit after an apply is
// what makes a residue visible instead of a success message over a file that
// still carries the payload.

const CATEGORY_LABELS: Record<string, string> = {
  metadata: 'panel.sanitize.category.metadata',
  embedded_files: 'panel.sanitize.category.embedded_files',
  bookmarks: 'panel.sanitize.category.bookmarks',
  comments: 'panel.sanitize.category.comments',
  form_fields: 'panel.sanitize.category.form_fields',
  javascript: 'panel.sanitize.category.javascript',
  hidden_layers: 'panel.sanitize.category.hidden_layers',
  hidden_text: 'panel.sanitize.category.hidden_text',
  prior_revisions: 'panel.sanitize.category.prior_revisions',
  unreferenced_objects: 'panel.sanitize.category.unreferenced_objects',
  links_and_actions: 'panel.sanitize.category.links_and_actions',
  thumbnails: 'panel.sanitize.category.thumbnails',
  attached_structure: 'panel.sanitize.category.attached_structure',
  signatures: 'panel.sanitize.category.signatures',
};

function label(id: string): string {
  const key = CATEGORY_LABELS[id];
  return key ? tChrome(key as Parameters<typeof tChrome>[0]) : id;
}

/** One finding, as one line. The engine's detail rows differ per category, so
 * the fields that exist are shown and the rest are skipped. */
function detailLine(detail: AuditDetail): string {
  const parts: string[] = [];
  if (detail.where) parts.push(detail.where);
  if (detail.page !== undefined && !detail.where) parts.push(`p${detail.page}`);
  if (detail.name) parts.push(detail.name);
  if (detail.title) parts.push(detail.title);
  if (detail.subtype) parts.push(detail.subtype);
  if (detail.kind) parts.push(detail.kind);
  if (detail.author) parts.push(detail.author);
  if (detail.via) parts.push(detail.via);
  if (detail.bytes !== undefined) parts.push(`${detail.bytes}`);
  if (detail.type) parts.push(detail.type);
  if (detail.value) parts.push(detail.value);
  if (detail.target) parts.push(detail.target);
  if (detail.text) parts.push(detail.text);
  if (detail.contents) parts.push(detail.contents);
  if (detail.keys?.length) parts.push(detail.keys.join(', '));
  if (detail.objects !== undefined) parts.push(`${detail.objects}`);
  return parts.join(' · ');
}

export function SanitizePanel(): React.ReactElement {
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { callRaw } = useEngine();

  const [report, setReport] = useState<AuditReport | null>(null);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [fieldMode, setFieldMode] = useState<'remove' | 'flatten'>('remove');
  const [includeOcr, setIncludeOcr] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>());
  const [comparison, setComparison] = useState<ComparisonRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  const path = activeFile?.path ?? null;
  const workingPath = activeFile?.workingPath ?? null;
  const buffer = activeFile?.buffer ?? null;

  const audit = useCallback(
    async (target: string): Promise<AuditReport> =>
      // The read is deliberately ungated: it re-runs on every buffer change,
      // and gating it would commit pending page edits merely for looking.
      (await callRaw('audit_hidden_information', { file: target })) as unknown as AuditReport,
    [callRaw],
  );

  // The report an apply was measured against, held until the re-audit that
  // follows it can be compared to it. The apply changes the buffer, and the
  // buffer change is what re-audits — so the comparison is published by that
  // ONE audit rather than by a second one racing it.
  const pendingRef = useRef<{ report: AuditReport; categories: string[] } | null>(null);

  const refresh = useCallback(async () => {
    if (!workingPath) return;
    setBusy(true);
    setError(null);
    try {
      const next = await audit(workingPath);
      setReport(next);
      const pending = pendingRef.current;
      if (pending) {
        pendingRef.current = null;
        setComparison(compare(pending.report, next, pending.categories));
        setSelection(emptySelection());
        setStatus(tChromeCount('panel.sanitize.done', pending.categories.length));
      } else {
        setComparison(null);
        setStatus('');
      }
    } catch (e: unknown) {
      pendingRef.current = null;
      setReport(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [audit, workingPath]);

  useEffect(() => {
    // A buffer change means the report describes bytes the document no longer
    // has, so it is replaced rather than shown beside a different file.
    if (!buffer || !workingPath) {
      pendingRef.current = null;
      setReport(null);
      setComparison(null);
      setStatus('');
      return;
    }
    void refresh();
  }, [buffer, workingPath, refresh]);

  useEffect(() => {
    setSelection(emptySelection());
    setIncludeOcr(false);
    setFieldMode('remove');
  }, [path]);

  const blocked = report ? blockedReason(report) : null;
  const chosen = report ? selectedCategories(report, selection) : [];
  const ocrCount = report ? textKindCount(report, 'ocr_layer') : 0;
  const partialCount = report ? textKindCount(report, 'partially_covered') : 0;
  const revisions = report ? categoryOf(report, 'prior_revisions')?.detail?.[0] : undefined;

  const rows = useMemo(() => report?.categories ?? [], [report]);

  const apply = useCallback(async () => {
    if (!report || !path || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      const request = buildRequest(report, selection, fieldMode, includeOcr);
      const handlers = getCommandContext()?.app;
      if (!handlers) return;
      // The re-audit is automatic on purpose: a category the remover could not
      // fully clear shows a non-zero count instead of a success message.
      pendingRef.current = { report, categories: request.categories };
      const applied = await handlers.sanitizeDocument(path, request);
      if (!applied) {
        pendingRef.current = null;
        setStatus(tChrome('panel.sanitize.declined'));
      }
    } catch (e: unknown) {
      pendingRef.current = null;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [chosen.length, fieldMode, includeOcr, path, report, selection]);

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.sanitize.open')} />;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="sanitize-panel">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')}{' '}
        <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      <p className="text-xs text-neutral-400">{tChrome('panel.sanitize.blurb')}</p>

      <div className="flex items-center gap-3 text-xs">
        <button
          className="underline"
          data-testid="sanitize-refresh"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {tChrome('panel.sanitize.rerun')}
        </button>
        {report && (
          <span className="text-neutral-500" data-testid="sanitize-pages">
            {tChromeCount('panel.sanitize.pagesAnalyzed', report.pages_analyzed)}
          </span>
        )}
      </div>

      {error && (
        <div className="text-sm text-red-400" data-testid="sanitize-error">
          {tChrome('panel.common.error', { message: error })}
        </div>
      )}

      {blocked && (
        <div className="text-sm text-amber-400" data-testid="sanitize-blocked">
          {blocked.page
            ? tChrome('panel.sanitize.blockedPage', {
                page: blocked.page,
                category: label(blocked.category),
                reason: blocked.reason,
              })
            : tChrome('panel.sanitize.blocked', {
                category: label(blocked.category),
                reason: blocked.reason,
              })}
        </div>
      )}

      {report && report.signatures.count > 0 && (
        <div className="text-xs text-amber-400" data-testid="sanitize-signed">
          {tChromeCount('panel.sanitize.signed', report.signatures.count)}
          {report.signatures.certification && ` ${tChrome('panel.sanitize.certified')}`}
        </div>
      )}

      {report && (
        <div className="flex items-center gap-3 text-xs">
          <button
            className="underline"
            data-testid="sanitize-select-all"
            disabled={busy || blocked !== null}
            onClick={() =>
              setSelection(chosen.length > 0 ? emptySelection() : allRemovable(report))
            }
          >
            {chosen.length > 0
              ? tChrome('panel.sanitize.selectNone')
              : tChrome('panel.sanitize.selectAll')}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-1" data-testid="sanitize-list">
        {rows.map((category: AuditCategory) => {
          const selectable = isSelectable(category) && blocked === null;
          const checked = selection.has(category.id);
          const open = expanded.has(category.id);
          return (
            <div
              key={category.id}
              className="rounded border border-neutral-800 bg-neutral-800/40 px-2 py-1.5"
              data-testid={`sanitize-row-${category.id}`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid={`sanitize-check-${category.id}`}
                  aria-label={label(category.id)}
                  disabled={!selectable || busy}
                  checked={checked}
                  onChange={() => setSelection(toggle(selection, category.id))}
                />
                <span className="flex-1 text-sm text-neutral-200">{label(category.id)}</span>
                <span
                  className="text-sm tabular-nums text-neutral-300"
                  data-testid={`sanitize-count-${category.id}`}
                >
                  {category.count}
                </span>
                {category.detail.length > 0 && (
                  <button
                    className="text-xs underline text-neutral-400"
                    data-testid={`sanitize-details-${category.id}`}
                    onClick={() => setExpanded(toggle(expanded, category.id))}
                  >
                    {tChrome('panel.sanitize.details')}
                  </button>
                )}
              </div>

              {category.count === 0 && !category.unreadable && (
                <p className="ps-6 text-xs text-neutral-500">
                  {tChrome('panel.sanitize.clean')}
                </p>
              )}
              {category.unreadable && (
                <p className="ps-6 text-xs text-amber-400">
                  {tChrome('panel.sanitize.unreadableRow')}
                </p>
              )}
              {!category.removable && (
                <p className="ps-6 text-xs text-neutral-500">
                  {tChrome('panel.sanitize.reportedOnly')}
                </p>
              )}
              {(COSTLY_CATEGORIES as readonly string[]).includes(category.id) && (
                <p className="ps-6 text-xs text-amber-400">
                  {tChrome(
                    category.id === 'form_fields'
                      ? 'panel.sanitize.cost.form_fields'
                      : 'panel.sanitize.cost.attached_structure',
                  )}
                </p>
              )}
              {category.id === 'form_fields' && category.xfa && (
                <p className="ps-6 text-xs text-amber-400" data-testid="sanitize-xfa">
                  {tChrome('panel.sanitize.xfa')}
                </p>
              )}
              {category.id === 'form_fields' && checked && !category.xfa && (
                <div className="ps-6 pt-1">
                  <label className="text-xs text-neutral-400" htmlFor="sanitize-field-mode">
                    {tChrome('panel.sanitize.fieldMode')}
                  </label>
                  <select
                    id="sanitize-field-mode"
                    data-testid="sanitize-field-mode"
                    className="ms-2 rounded bg-neutral-800 px-2 py-0.5 text-xs"
                    value={fieldMode}
                    onChange={(e) => setFieldMode(e.target.value === 'flatten' ? 'flatten' : 'remove')}
                  >
                    <option value="remove">{tChrome('panel.sanitize.fieldModeRemove')}</option>
                    <option value="flatten">{tChrome('panel.sanitize.fieldModeFlatten')}</option>
                  </select>
                </div>
              )}
              {category.id === 'hidden_text' && partialCount > 0 && (
                <p className="ps-6 text-xs text-neutral-500" data-testid="sanitize-partial">
                  {tChromeCount('panel.sanitize.partialKept', partialCount)}
                </p>
              )}
              {category.id === 'hidden_text' && ocrCount > 0 && (
                <div className="ps-6 pt-1">
                  <label className="flex items-center gap-2 text-xs text-neutral-300">
                    <input
                      type="checkbox"
                      data-testid="sanitize-include-ocr"
                      disabled={!checked || busy}
                      checked={includeOcr}
                      onChange={(e) => setIncludeOcr(e.target.checked)}
                    />
                    {tChromeCount('panel.sanitize.includeOcr', ocrCount)}
                  </label>
                  <p className="text-xs text-amber-400">{tChrome('panel.sanitize.cost.ocr_layer')}</p>
                </div>
              )}
              {category.id === 'prior_revisions' && revisions && category.count > 0 && (
                <p className="ps-6 text-xs text-neutral-400" data-testid="sanitize-revisions">
                  {tChromeCount('panel.sanitize.revisions', category.count, {
                    bytes: revisions.recoverable_bytes ?? 0,
                  })}
                </p>
              )}

              {open && (
                <ul
                  className="ps-6 pt-1 text-xs text-neutral-400"
                  data-testid={`sanitize-detail-${category.id}`}
                >
                  {category.detail.map((detail, i) => (
                    <li key={i} className="truncate">
                      {detailLine(detail)}
                    </li>
                  ))}
                  {category.detail_truncated && (
                    <li className="text-neutral-500">{tChrome('panel.sanitize.moreRows')}</li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {comparison && (
        <div className="flex flex-col gap-1" data-testid="sanitize-comparison">
          <span className="text-xs text-neutral-400">{tChrome('panel.sanitize.resultTitle')}</span>
          {comparison
            .filter((r) => r.selected)
            .map((r) => (
              <span
                key={r.id}
                className="text-xs text-neutral-300"
                data-testid={`sanitize-after-${r.id}`}
              >
                {tChrome('panel.sanitize.resultRow', {
                  category: label(r.id),
                  before: r.before,
                  after: r.after,
                })}
              </span>
            ))}
          {residues(comparison).map((r) => (
            <span
              key={`residue-${r.id}`}
              className="text-xs text-amber-400"
              data-testid={`sanitize-residue-${r.id}`}
            >
              {tChrome('panel.sanitize.residue', { category: label(r.id), after: r.after })}
            </span>
          ))}
        </div>
      )}

      <button
        className="rounded bg-red-700 px-3 py-1.5 text-sm hover:bg-red-600 disabled:opacity-50"
        data-testid="sanitize-apply"
        disabled={busy || chosen.length === 0 || blocked !== null}
        onClick={() => void apply()}
      >
        {busy
          ? tChrome('panel.sanitize.applying')
          : tChromeCount('panel.sanitize.apply', chosen.length)}
      </button>
      {chosen.length === 0 && (
        <p className="text-xs text-neutral-500">{tChrome('panel.sanitize.nothingChecked')}</p>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
