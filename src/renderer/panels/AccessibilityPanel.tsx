import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveFile } from '../hooks/useActiveFile';
import { useAppDispatch } from '../state/AppStateProvider';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { getCanvasServices } from '../commands/context';
import { dialog, report as reportFile } from '../lib/tauri-bridge';
import { parkStructSelection } from '../lib/a11y-jump';
import { TEST_HARNESS_ENABLED, registerAccessibility } from '../testHarness';
import { tChrome } from '../i18n';
import type { PlaceableFinding } from '../lib/a11y-findings';
import {
  categoryCount,
  categoryName,
  checkExplanation,
  checkName,
  findingDetail,
  findingWhere,
  formatAccessibilityHtml,
  formatAccessibilityText,
  orderedCategories,
  reportFileName,
  summaryLine,
  verdictLabel,
  type AccessibilityReport,
  type Check,
  type Finding,
  type Verdict,
} from '../lib/accessibility-report';

// The accessibility report surface: the 32 checks as a categorized tree, each
// failure carrying the findings that produced it and a jump to the thing it
// names.
//
// The panel renders the report and NOTHING ELSE — every jump lands on the
// surface that owns the edit, and no control here writes to the document. That
// is what keeps the claim honest: a report that also repaired what it measured
// would be reporting on its own work.
//
// The report is re-run on every buffer change, because a structure path never
// outlives the tree it was read from. A finding therefore never carries an
// address older than the report on screen.

// A needs-review row shows neither a tick nor a cross: it has not been
// decided, and borrowing either glyph is the claim the checker refuses to
// make. A not-applicable row is muted — it is excluded from the pass tally,
// so showing it as a pass would earn a score the document did not.
const ICON: Record<Verdict, { glyph: string; color: string }> = {
  pass: { glyph: '✓', color: '#2fbf71' },
  warn: { glyph: '!', color: '#fbbf24' },
  fail: { glyph: '✕', color: '#f87171' },
  needs_review: { glyph: '?', color: '#a78bfa' },
  not_applicable: { glyph: '–', color: '#6b7280' },
};

/** Where an `object` finding is edited. A check with no entry lists its
 * findings and jumps nowhere: inventing a destination that does not hold the
 * item is worse than leaving the row where the reader can read it. */
const OWNING_OP: Record<string, string> = {
  image_only: 'scanenhance',
  tagged_annotations: 'comments',
  tagged_multimedia: 'comments',
  tagged_form_fields: 'forms',
  field_descriptions: 'forms',
  navigation_links: 'links',
  screen_flicker: 'document_js',
  scripts: 'document_js',
  timed_responses: 'document_js',
};

// A check can name thousands of runs (contrast on a long document). The panel
// lists a bounded prefix and says how many it did not draw; the exported
// report carries every one of them, which is what the export is for.
const MAX_LISTED_FINDINGS = 200;

function findingKey(check: Check, index: number): string {
  return `${check.id}:${index}`;
}

/** The findings of `check` that have a place on a page. */
function placeable(check: Check): PlaceableFinding[] {
  const out: PlaceableFinding[] = [];
  for (const finding of check.findings) {
    if (finding.address.kind !== 'content') continue;
    const page = finding.address.page;
    if (typeof page !== 'number' || !finding.rect) continue;
    out.push({
      page,
      rect: finding.rect,
      checkId: check.id,
      detailKey: finding.detail_key,
      preview: finding.preview,
    });
  }
  return out;
}

export function AccessibilityPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const dispatch = useAppDispatch();
  const [report, setReport] = useState<AccessibilityReport | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const [shownCheck, setShownCheck] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;
  const path = activeFile?.path ?? null;
  const name = activeFile?.name ?? '';
  // Which document the expansion was seeded for. Every edit swaps the buffer,
  // so buffer identity cannot key it — the Tags panel's rule, same reason.
  const seededFor = useRef<string | null>(null);

  const run = useCallback(async () => {
    if (!workingPath) return;
    setBusy(true);
    setStatus(tChrome('panel.a11y.checking'));
    try {
      const res = (await call('check_accessibility', {
        file: workingPath,
      })) as unknown as AccessibilityReport;
      setReport(res);
      // The addresses in the previous run's findings were read from a tree
      // this run has replaced, so what is drawn on the page goes with them.
      getCanvasServices()?.a11yFindings.clear();
      setShownCheck(null);
      if (seededFor.current !== workingPath) {
        seededFor.current = workingPath;
        setExpanded(
          new Set(
            res.categories
              .filter((c) => c.checks.some((k) => k.status === 'fail' || k.status === 'warn'))
              .map((c) => c.id),
          ),
        );
        setOpenCheck(null);
      }
      setStatus('');
    } catch (e: unknown) {
      setStatus(
        tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }),
      );
    } finally {
      setBusy(false);
    }
  }, [workingPath, call]);

  useEffect(() => {
    if (!buffer || !workingPath) {
      setReport(null);
      return;
    }
    void run();
  }, [buffer, workingPath, run]);

  // The findings on the page belong to the document that produced them.
  useEffect(() => {
    return () => {
      getCanvasServices()?.a11yFindings.clear();
    };
  }, [path]);

  const categories = useMemo(() => (report ? orderedCategories(report) : []), [report]);

  const toggleCategory = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Draw one check's page findings on the document, or take them off. */
  const showOnPage = useCallback(
    async (check: Check) => {
      const services = getCanvasServices();
      if (!services || !path) {
        setStatus(tChrome('panel.a11y.noCanvas'));
        return;
      }
      if (shownCheck === check.id) {
        services.a11yFindings.clear();
        setShownCheck(null);
        return;
      }
      const { shown } = await services.a11yFindings.publish(path, placeable(check));
      setShownCheck(shown > 0 ? check.id : null);
      if (shown === 0) setStatus(tChrome('panel.a11y.nothingToShow'));
    },
    [path, shownCheck],
  );

  /** One finding's jump — one of the three address kinds, each landing on the
   * surface that owns the thing named. */
  const jump = useCallback(
    async (check: Check, finding: Finding, index: number) => {
      const address = finding.address;
      if (address.kind === 'struct' && address.path && path) {
        parkStructSelection(path, address.path);
        dispatch({ type: 'UI_SET_ACTIVE_OP', op: 'tags' });
        return;
      }
      if (address.kind === 'content') {
        const services = getCanvasServices();
        if (!services || !path) {
          setStatus(tChrome('panel.a11y.noCanvas'));
          return;
        }
        const findings = placeable(check);
        if (shownCheck !== check.id) {
          const { shown } = await services.a11yFindings.publish(path, findings);
          setShownCheck(shown > 0 ? check.id : null);
        }
        // The published set is this check's content findings in order, so the
        // clicked row's position within THAT list is what addresses it.
        const at = check.findings.slice(0, index + 1).filter((f) => f.address.kind === 'content')
          .length - 1;
        const live = services.a11yFindings.list();
        const target = live[at];
        if (target) services.a11yFindings.focus(target.id);
        return;
      }
      const op = OWNING_OP[check.id];
      if (op) dispatch({ type: 'UI_SET_ACTIVE_OP', op });
    },
    [dispatch, path, shownCheck],
  );

  /** Emit the report to `target`. The extension the user landed on picks the
   * format — one dialog, two emitters, one model. */
  const writeReport = useCallback(
    async (target: string, current: AccessibilityReport): Promise<string> => {
      const run = { documentName: name, runAt: new Date(), report: current };
      return reportFile.write(
        target,
        /\.html$/i.test(target) ? formatAccessibilityHtml(run) : formatAccessibilityText(run),
      );
    },
    [name],
  );

  const exportReport = useCallback(async () => {
    if (!report) return;
    const target = await dialog.saveReportFile(reportFileName(name, new Date(), 'html'));
    if (!target) return;
    setBusy(true);
    setStatus(tChrome('panel.a11y.exporting'));
    try {
      setStatus(tChrome('panel.a11y.exported', { path: await writeReport(target, report) }));
    } catch (e: unknown) {
      setStatus(
        tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }),
      );
    } finally {
      setBusy(false);
    }
  }, [report, name, writeReport]);

  // The dialogs the panel drives are native, so e2e injects the destination
  // into the SAME emit-and-write the button runs, and reaches the row
  // handlers by check id (a finding row has no id of its own).
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerAccessibility({
      snapshot: () =>
        report
          ? {
              summary: report.summary,
              checks: orderedCategories(report).flatMap((category) =>
                category.checks.map((check) => ({
                  id: check.id,
                  category: category.id,
                  status: check.status,
                  counted: check.counted,
                  findings: check.findings.length,
                  addressKinds: [...new Set(check.findings.map((f) => f.address.kind))],
                })),
              ),
              expandedCategories: [...expanded],
              shownCheck,
            }
          : null,
      recheck: run,
      jump: async (checkId, index) => {
        const check = categories.flatMap((c) => c.checks).find((c) => c.id === checkId);
        const finding = check?.findings[index];
        if (!check || !finding) throw new Error(`no finding ${checkId}[${index}]`);
        setOpenCheck(checkId);
        await jump(check, finding, index);
      },
      show: async (checkId) => {
        const check = categories.flatMap((c) => c.checks).find((c) => c.id === checkId);
        if (!check) throw new Error(`no check ${checkId}`);
        await showOnPage(check);
      },
      exportTo: async (destPath) => {
        if (!report) throw new Error('a11yExport: the report has not run yet');
        return writeReport(destPath, report);
      },
    });
    return () => registerAccessibility(null);
  }, [report, categories, expanded, shownCheck, run, jump, showOnPage, writeReport]);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.a11y.open')} />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-neutral-400">
          {tChrome('panel.common.workingOn')}{' '}
          <span className="text-neutral-200">{activeFile.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            data-testid="a11y-recheck"
            onClick={() => void run()}
            disabled={busy}
            className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
          >
            {tChrome('panel.a11y.recheck')}
          </button>
          <button
            data-testid="a11y-export"
            onClick={() => void exportReport()}
            disabled={busy || !report}
            className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
          >
            {tChrome('panel.a11y.export')}
          </button>
        </div>
      </div>

      {report && (
        <div className="text-sm text-neutral-300" data-testid="a11y-summary">
          {summaryLine(report.summary)}
        </div>
      )}

      <div className="flex flex-col gap-2" data-testid="a11y-tree">
        {categories.map((category) => {
          const open = expanded.has(category.id);
          return (
            <div key={category.id} data-testid={`a11y-category-${category.id}`}>
              <button
                className="flex w-full items-center justify-between px-2 py-1 text-xs uppercase tracking-wide text-neutral-400 hover:text-neutral-200"
                aria-expanded={open}
                data-testid={`a11y-category-toggle-${category.id}`}
                onClick={() => toggleCategory(category.id)}
              >
                <span>
                  <span aria-hidden className="me-1">
                    {open ? '▾' : '▸'}
                  </span>
                  {categoryName(category.id)}
                </span>
                <span data-testid={`a11y-category-count-${category.id}`}>
                  {categoryCount(category)}
                </span>
              </button>
              {open && (
                <div className="flex flex-col gap-1">
                  {category.checks.map((check) => {
                    const listed = check.findings.slice(0, MAX_LISTED_FINDINGS);
                    const hidden = check.findings.length - listed.length;
                    const onPage = placeable(check).length > 0;
                    const isOpen = openCheck === check.id;
                    return (
                      <div
                        key={check.id}
                        data-testid={`a11y-check-${check.id}`}
                        data-a11y-status={check.status}
                        // A not-applicable row is marked by its BORDER, never
                        // by a fade or a recessed fill: it is excluded from the
                        // pass tally and has to read as a different kind of
                        // row, but every treatment that changes what the text
                        // sits on changes its contrast — and does so
                        // differently per theme — an opacity fade and a
                        // recessed fill each fall below the WCAG AA ratio, in
                        // opposite themes. The glyph and the verdict label
                        // carry the state; the dashes carry the grouping.
                        className={`rounded border bg-neutral-800/60 ${
                          check.status === 'not_applicable'
                            ? 'border-dashed border-neutral-700'
                            : 'border-neutral-800'
                        }`}
                      >
                        <div className="flex items-start gap-2 px-3 py-2">
                          <span
                            aria-hidden
                            style={{ color: ICON[check.status].color }}
                            className="font-bold w-4 text-center shrink-0"
                          >
                            {ICON[check.status].glyph}
                          </span>
                          <button
                            className="min-w-0 flex-1 text-start"
                            data-testid={`a11y-check-open-${check.id}`}
                            onClick={() => setOpenCheck(isOpen ? null : check.id)}
                          >
                            <div className="text-sm text-neutral-200">
                              {checkName(check.id)}{' '}
                              <span className="text-[10px] text-neutral-500">{check.id}</span>
                            </div>
                            <div className="text-xs text-neutral-500">
                              {verdictLabel(check.status)}
                            </div>
                          </button>
                          {check.findings.length > 0 && (
                            <span className="text-xs text-neutral-400 shrink-0">
                              {tChrome('panel.a11y.findingCount', {
                                count: check.findings.length,
                                counted: check.counted,
                              })}
                            </span>
                          )}
                          {onPage && (
                            <button
                              data-testid={`a11y-show-${check.id}`}
                              onClick={() => void showOnPage(check)}
                              className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 shrink-0"
                            >
                              {shownCheck === check.id
                                ? tChrome('panel.a11y.hide')
                                : tChrome('panel.a11y.show')}
                            </button>
                          )}
                        </div>
                        {isOpen && (
                          <div className="px-3 pb-2">
                            <div className="text-xs text-neutral-400">
                              {checkExplanation(check.id)}
                            </div>
                            {listed.length > 0 && (
                              <ul className="mt-1 flex flex-col gap-0.5">
                                {listed.map((finding, index) => (
                                  <li key={findingKey(check, index)}>
                                    <button
                                      className="w-full text-start text-xs text-neutral-300 hover:text-neutral-100"
                                      title={tChrome('panel.a11y.jumpTitle')}
                                      data-testid={`a11y-finding-${check.id}-${index}`}
                                      onClick={() => void jump(check, finding, index)}
                                    >
                                      <span className="text-neutral-500">
                                        {findingWhere(finding)}
                                      </span>{' '}
                                      {findingDetail(finding)}
                                      {finding.preview && (
                                        <span className="italic text-neutral-500">
                                          {' '}
                                          {finding.preview}
                                        </span>
                                      )}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {hidden > 0 && (
                              <div className="mt-1 text-xs text-neutral-500">
                                {tChrome('panel.a11y.moreFindings', { count: hidden })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {report && report.unreadable.length > 0 && (
        <div className="text-xs text-amber-400" data-testid="a11y-unreadable">
          <div>{tChrome('panel.a11y.unreadableHeading')}</div>
          {report.unreadable.map((page) => (
            <div key={page.page}>
              {tChrome('panel.a11y.unreadablePage', { page: String(page.page) })}
            </div>
          ))}
        </div>
      )}

      <StatusBar message={status} busy={busy} />
    </div>
  );
}
