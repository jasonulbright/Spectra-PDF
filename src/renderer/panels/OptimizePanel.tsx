import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, tNumber } from '../i18n';
import { byteColumnUnit, byteColumnPlaces, formatBytes, formatBytesIn } from '../lib/format-bytes';
import {
  accountsForFile,
  knobOf,
  overheadParts,
  percentOf,
  ranked,
  type SpaceCategory,
  type SpaceDetail,
  type SpaceReport,
} from '../lib/space-audit';
import { suffixedOutputName } from '../lib/output-names';
import { FolderRouteHint } from '../components/FolderRouteHint';

// The panel opens on the AUDIT, not on the knobs: which setting is worth
// changing is a property of the document, and a checkbox list with nothing
// behind it makes the choice a guess.
//
// The audit is a pure read that re-runs on every buffer change, so it goes
// through the ungated path — an annotation is a pending page edit, and gating
// a read that refetches would flush the user's just-drawn markup to disk
// merely for looking. `optimize` replaces the file's bytes and stays gated.

const CATEGORY_LABELS: Record<string, string> = {
  images: 'panel.optimize.audit.category.images',
  fonts: 'panel.optimize.audit.category.fonts',
  content_streams: 'panel.optimize.audit.category.content_streams',
  annotations: 'panel.optimize.audit.category.annotations',
  forms: 'panel.optimize.audit.category.forms',
  embedded_files: 'panel.optimize.audit.category.embedded_files',
  bookmarks: 'panel.optimize.audit.category.bookmarks',
  named_destinations: 'panel.optimize.audit.category.named_destinations',
  tagged_structure: 'panel.optimize.audit.category.tagged_structure',
  document_structure: 'panel.optimize.audit.category.document_structure',
  metadata: 'panel.optimize.audit.category.metadata',
  javascript: 'panel.optimize.audit.category.javascript',
  other_objects: 'panel.optimize.audit.category.other_objects',
  overhead: 'panel.optimize.audit.category.overhead',
};

const KNOB_LABELS: Record<string, string> = {
  compress: 'panel.optimize.audit.knob.compress',
  compress_streams: 'panel.optimize.audit.knob.compress_streams',
  strip_metadata: 'panel.optimize.audit.knob.strip_metadata',
  sanitize_comments: 'panel.optimize.audit.knob.sanitize_comments',
  sanitize_forms: 'panel.optimize.audit.knob.sanitize_forms',
  sanitize_embedded_files: 'panel.optimize.audit.knob.sanitize_embedded_files',
  sanitize_bookmarks: 'panel.optimize.audit.knob.sanitize_bookmarks',
  sanitize_javascript: 'panel.optimize.audit.knob.sanitize_javascript',
  sanitize_structure: 'panel.optimize.audit.knob.sanitize_structure',
  rewrite: 'panel.optimize.audit.knob.rewrite',
};

const PART_LABELS: Record<string, string> = {
  cross_reference: 'panel.optimize.audit.part.cross_reference',
  superseded: 'panel.optimize.audit.part.superseded',
  unreferenced: 'panel.optimize.audit.part.unreferenced',
  structural: 'panel.optimize.audit.part.structural',
};

function labelOf(table: Record<string, string>, id: string, fallback: string): string {
  const key = table[id];
  return key ? tChrome(key as Parameters<typeof tChrome>[0]) : fallback;
}

/** Shares go through Intl: the percent sign's placement and spacing are
 * locale properties, not a suffix. */
function sharePercent(row: SpaceCategory): string {
  return tNumber(percentOf(row) / 100, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** One finding, as one line. Which fields exist differs per category, so the
 * ones present are shown and the rest are skipped. */
function detailLine(detail: SpaceDetail): string {
  const parts: string[] = [];
  parts.push(
    detail.page != null
      ? tChrome('panel.optimize.audit.detailPage', { page: detail.page })
      : tChrome('panel.optimize.audit.detailDocument'),
  );
  if (detail.name) parts.push(detail.name);
  if (detail.type) parts.push(detail.type);
  parts.push(formatBytes(detail.bytes));
  return parts.join(' · ');
}

export function OptimizePanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [linearize, setLinearize] = useState(true);
  const [stripMeta, setStripMeta] = useState(false);
  const [compressStreams, setCompressStreams] = useState(true);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const [report, setReport] = useState<SpaceReport | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>());

  const workingPath = activeFile?.workingPath ?? null;
  const buffer = activeFile?.buffer ?? null;

  const refresh = useCallback(async () => {
    if (!workingPath) return;
    setAuditing(true);
    setAuditError(null);
    try {
      const next = (await call('audit_space_usage', {
        file: workingPath,
      })) as unknown as SpaceReport;
      setReport(next);
    } catch (e: unknown) {
      setReport(null);
      setAuditError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuditing(false);
    }
  }, [call, workingPath]);

  useEffect(() => {
    // A buffer change means the report describes bytes the document no longer
    // has, so it is replaced rather than shown beside a different file.
    if (!buffer || !workingPath) {
      setReport(null);
      return;
    }
    void refresh();
  }, [buffer, workingPath, refresh]);

  const rows = useMemo(() => (report ? ranked(report) : []), [report]);
  const consistent = accountsForFile(report);
  // The size column is written in ONE unit AND at one precision — see
  // `byteColumnUnit` / `byteColumnPlaces`. The total is part of the column, so
  // it votes on both.
  const sizeValues = useMemo(
    () => [...rows.map((r) => r.bytes), report?.file_size ?? null],
    [rows, report],
  );
  const sizeUnit = useMemo(() => byteColumnUnit(sizeValues), [sizeValues]);
  const sizePlaces = useMemo(
    () => byteColumnPlaces(sizeValues, sizeUnit),
    [sizeValues, sizeUnit],
  );

  const handleOptimize = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile(suffixedOutputName(activeFile.name, "optimized"));
    if (!output) return;
    setBusy(true); setStatus(tChrome('panel.optimize.optimizing'));
    try {
      const r = await call('optimize', {
        file: activeFile.workingPath, output,
        linearize, strip_metadata: stripMeta, compress_streams: compressStreams,
      });
      const orig = (r.original_size / 1024).toFixed(0);
      const out = (r.output_size / 1024).toFixed(0);
      const ratio = ((1 - r.output_size / r.original_size) * 100).toFixed(1);
      setStatus(tChrome('panel.optimize.result', { from: orig, to: out, ratio }));
    } catch (e: unknown) { setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  }, [activeFile, linearize, stripMeta, compressStreams, call, saveFile]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.optimize.open')} />;

  const checks = [
    { label: tChrome('panel.optimize.linearize'), checked: linearize, set: setLinearize, hint: tChrome('panel.optimize.linearizeHint') },
    { label: tChrome('panel.optimize.stripMeta'), checked: stripMeta, set: setStripMeta, hint: tChrome('panel.optimize.stripMetaHint') },
    { label: tChrome('panel.optimize.compressStreams'), checked: compressStreams, set: setCompressStreams, hint: tChrome('panel.optimize.compressStreamsHint') },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})</div>

      <div className="flex flex-col gap-2" data-testid="space-audit">
        <div className="flex items-center gap-3">
          <span className="text-sm text-neutral-200">{tChrome('panel.optimize.audit.title')}</span>
          <button
            className="text-xs quiet-action"
            data-testid="space-audit-rerun"
            disabled={auditing}
            onClick={() => void refresh()}
          >
            {auditing ? tChrome('panel.optimize.audit.running') : tChrome('panel.optimize.audit.rerun')}
          </button>
        </div>
        <p className="text-xs text-neutral-500">{tChrome('panel.optimize.audit.blurb')}</p>

        {auditError && (
          <div className="text-sm text-red-400" data-testid="space-audit-error">
            {tChrome('panel.common.error', { message: auditError })}
          </div>
        )}
        {report && !consistent && (
          <div className="text-sm text-amber-400" data-testid="space-audit-inconsistent">
            {tChrome('panel.optimize.audit.inconsistent')}
          </div>
        )}

        {report && consistent && (
          <>
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5 text-xs" data-testid="space-audit-table">
              <span className="text-neutral-500">{tChrome('panel.optimize.audit.headerCategory')}</span>
              <span className="text-end text-neutral-500">{tChrome('panel.optimize.audit.headerBytes')}</span>
              <span className="text-end text-neutral-500">{tChrome('panel.optimize.audit.headerShare')}</span>
              {rows.map((row: SpaceCategory) => (
                <React.Fragment key={row.id}>
                  <span className="text-neutral-200" data-testid={`space-audit-name-${row.id}`}>
                    {labelOf(CATEGORY_LABELS, row.id, row.id)}
                  </span>
                  <span
                    className="text-end tabular-nums text-neutral-300"
                    data-testid={`space-audit-bytes-${row.id}`}
                    data-bytes={row.bytes}
                  >
                    {formatBytesIn(row.bytes, sizeUnit, sizePlaces)}
                  </span>
                  <span
                    className="text-end tabular-nums text-neutral-400"
                    data-testid={`space-audit-share-${row.id}`}
                  >
                    {sharePercent(row)}
                  </span>
                  {/* N16: the sub-line ran knob · objects · Details as inline
                      text, so the buttons followed variable-length prose and
                      landed at eleven different x positions, one of them
                      wrapped onto a second line. The row is a flex line with
                      the prose taking the slack and the button pinned to the
                      table's own trailing edge, which is what makes the
                      buttons a column. */}
                  <div className="col-span-3 pb-1 ps-3 text-neutral-500 flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      <span data-testid={`space-audit-knob-${row.id}`}>
                        {labelOf(
                          KNOB_LABELS,
                          knobOf(row) ?? '',
                          tChrome('panel.optimize.audit.knob.none'),
                        )}
                      </span>
                      {row.objects > 0 && (
                        <span className="ps-2 text-neutral-600">
                          {tChromeCount('panel.optimize.audit.objects', row.objects)}
                        </span>
                      )}
                    </span>
                    {row.detail.length > 0 && (
                      <button
                        className="flex-none quiet-action"
                        data-testid={`space-audit-details-${row.id}`}
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(row.id)) next.delete(row.id);
                            else next.add(row.id);
                            return next;
                          })
                        }
                      >
                        {tChrome('panel.optimize.audit.details')}
                      </button>
                    )}
                  </div>
                  {expanded.has(row.id) && (
                    <div className="col-span-3 pb-1 ps-3 text-neutral-500">
                      <ul
                        className="pt-0.5 text-neutral-400"
                        data-testid={`space-audit-detail-${row.id}`}
                      >
                        {(row.residual ? overheadParts(row) : row.detail).map((detail, i) => (
                          <li key={i} className="truncate">
                            {row.residual
                              ? `${labelOf(PART_LABELS, detail.kind ?? '', detail.kind ?? '')} · ${formatBytes(detail.bytes)}`
                              : detailLine(detail)}
                          </li>
                        ))}
                        {row.detail_truncated && (
                          <li className="text-neutral-600">
                            {tChrome('panel.optimize.audit.moreRows')}
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                </React.Fragment>
              ))}
              {/* ONE rule across the table, not a top border per cell. Three
                  bordered cells inside a `gap-x-3` grid draw three disconnected
                  segments with a gap at each column boundary, and the trailing
                  one hangs over an empty cell — a broken rule rather than a
                  total's separator. A full-width row owns the line instead. */}
              <span
                className="col-span-3 mt-1 border-t border-neutral-700"
                data-testid="space-audit-total-rule"
              />
              <span className="text-neutral-300">{tChrome('panel.optimize.audit.total')}</span>
              <span
                className="text-end tabular-nums text-neutral-200"
                data-testid="space-audit-total"
                data-bytes={report.file_size}
              >
                {formatBytesIn(report.file_size, sizeUnit, sizePlaces)}
              </span>
              <span />
            </div>
            <p className="text-xs text-neutral-500" data-testid="space-audit-revisions">
              {tChromeCount('panel.optimize.audit.revisions', report.revisions)}
            </p>
            {report.unmeasured_objects > 0 && (
              <p className="text-xs text-amber-400" data-testid="space-audit-unmeasured">
                {tChromeCount('panel.optimize.audit.unmeasured', report.unmeasured_objects)}
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {checks.map((c) => (
          <label key={c.label} className="flex items-start gap-2 cursor-pointer group">
            <input type="checkbox" checked={c.checked} onChange={(e) => c.set(e.target.checked)}
              className="mt-0.5 accent-blue-600" />
            <div>
              <span className="text-sm text-neutral-300 group-hover:text-neutral-200">{c.label}</span>
              <p className="text-xs text-neutral-500">{c.hint}</p>
            </div>
          </label>
        ))}
      </div>
      <button onClick={handleOptimize} disabled={busy || (!linearize && !stripMeta && !compressStreams)}
        className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded text-sm font-medium">
        {busy ? tChrome('panel.optimize.optimizing') : tChrome('panel.optimize.optimize')}
      </button>
      <StatusBar message={status} busy={busy} />
      <FolderRouteHint />
    </div>
  );
}
