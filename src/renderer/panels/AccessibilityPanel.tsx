import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveFile } from '../hooks/useActiveFile';
import { useAppDispatch } from '../state/AppStateProvider';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { useOperations } from '../hooks/useOperations';
import { EDIT_DECLINED } from '../lib/edit-text';
import { getCanvasServices } from '../commands/context';
import { dialog, report as reportFile } from '../lib/tauri-bridge';
import { parkStructSelection } from '../lib/a11y-jump';
import { mergeUntouched } from '../lib/late-read';
import { TEST_HARNESS_ENABLED, registerAccessibility } from '../testHarness';
import { LOCALE_NATIVE_NAMES, SHIPPED_LOCALES, tChrome } from '../i18n';
import {
  CONTENT_ROLES,
  artifactCalls,
  authoredCall,
  draftKey,
  fixFor,
  suggestionFor,
  type AuthoredFix,
  type FixOffer,
} from '../lib/a11y-fixes';
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
// failure carrying the findings that produced it, a jump to the thing it
// names, and — where the repair is one the app can actually perform — the fix
// itself.
//
// Two gestures, two outcomes, and they never trade places: clicking a finding
// JUMPS to the surface that owns it, and a fix control REPAIRS without moving.
// Fifteen of the checks have no fix here at all; a jump is what they get,
// because inventing a repair the app cannot perform is worse than naming the
// place a person can.
//
// A fix takes one of two shapes. An AUTOMATIC one is a button: the result is
// decided by the document (the level that closes a heading gap, the first row
// of a table), so one call repairs every finding of that check as one undoable
// act. An AUTHORED one is a field and an Apply: alt text, a title, a table
// summary, a language, a field description — the values a machine must never
// invent, one finding at a time.
//
// The report is re-run on every buffer change, because a structure path never
// outlives the tree it was read from. A finding therefore never carries an
// address older than the report on screen — and that re-run is also what makes
// a fixed row flip live, since applying a fix is what changes the buffer. The
// same re-run is why every authored editor is late-read protected: a re-check
// landing mid-typing must reseed what nobody touched and nothing else.

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

/** One authored value and its Apply — the Tags panel's draft/apply shape.
 *
 * The language variant offers the app's own 28 languages by their native
 * names AND stays a free text box: the document's language is not the reader's
 * language, and a picker that could only offer the shipped ones would be
 * unable to say `haw` or `cy-GB`. */
function AuthoredEditor({
  testId,
  authored,
  value,
  placeholder,
  busy,
  onChange,
  onApply,
}: {
  testId: string;
  authored: AuthoredFix;
  value: string;
  placeholder: string;
  busy: boolean;
  onChange: (next: string) => void;
  onApply: () => void;
}): React.ReactElement {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <label className="text-xs text-neutral-400" htmlFor={`${testId}-input`}>
        {tChrome(`panel.a11y.field.${authored.field}` as Parameters<typeof tChrome>[0])}
      </label>
      {authored.input === 'language' && (
        <select
          data-testid={`${testId}-pick`}
          aria-label={tChrome('panel.a11y.langPick')}
          className="bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs text-neutral-200"
          value={SHIPPED_LOCALES.includes(value) ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{tChrome('panel.a11y.langPick')}</option>
          {SHIPPED_LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {LOCALE_NATIVE_NAMES[locale] ?? locale} ({locale})
            </option>
          ))}
        </select>
      )}
      {authored.input === 'role' ? (
        // Two answers, and no free text: content a reader should hear, or page
        // furniture it should not. A third value would be a tag name nobody
        // asked this row for.
        <select
          id={`${testId}-input`}
          data-testid={`${testId}-input`}
          className="min-w-0 flex-1 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs text-neutral-200"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {CONTENT_ROLES.map((role) => (
            <option key={role} value={role}>
              {tChrome(`panel.a11y.role.${role}` as Parameters<typeof tChrome>[0])}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={`${testId}-input`}
          data-testid={`${testId}-input`}
          className="min-w-0 flex-1 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs text-neutral-200"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <button
        data-testid={`${testId}-apply`}
        disabled={busy || !value.trim()}
        onClick={onApply}
        className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
      >
        {tChrome('panel.a11y.apply')}
      </button>
    </div>
  );
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

/** Every draft editor on screen, keyed by `draftKey`. */
type Drafts = Record<string, string>;

export function AccessibilityPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();
  const dispatch = useAppDispatch();
  const [report, setReport] = useState<AccessibilityReport | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const [shownCheck, setShownCheck] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>({});
  // Which draft editors the user has typed into. The report re-runs on every
  // buffer change and reseeds the drafts from it, and a re-run landing
  // mid-typing must not revert what someone is half way through writing —
  // the exact bug `lib/late-read.ts` documents, which this panel has one
  // editor per finding's worth of chances to make.
  const touchedDrafts = useRef<Set<string>>(new Set());

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

  // Every draft editor the current report calls for, empty. A value is never
  // seeded from the document: the finding IS that the document has none.
  const draftSeed = useMemo(() => {
    const seed: Drafts = {};
    for (const category of categories) {
      for (const check of category.checks) {
        const offer = fixFor(check);
        if (offer?.kind !== 'authored' || !offer.authored) continue;
        // A role editor has no empty state — it is a choice between two, and
        // the safe one is the one that puts the content INTO the reading
        // order. Declaring something decoration is the deliberate answer.
        const empty = offer.authored.input === 'role' ? CONTENT_ROLES[0] : '';
        if (offer.authored.scope === 'check') seed[draftKey(check.id, null)] = empty;
        else check.findings.forEach((_f, i) => (seed[draftKey(check.id, i)] = empty));
      }
    }
    return seed;
  }, [categories]);

  useEffect(() => {
    setDrafts((prev) => mergeUntouched(draftSeed, prev, touchedDrafts.current));
  }, [draftSeed]);

  // Every draft input goes through this, so "touched" means exactly "the user
  // typed here" — not "state changed", which a reseed also does.
  const editDraft = useCallback((key: string, value: string) => {
    touchedDrafts.current.add(key);
    setDrafts((d) => ({ ...d, [key]: value }));
  }, []);

  /** Repair every finding of one check as ONE undoable act. The engine owns
   * what that means (`engine/accessibility_fixes.py`); this only asks. */
  const applyAutoFix = useCallback(
    async (check: Check): Promise<boolean> => {
      if (!activeFile) return false;
      setBusy(true);
      setStatus(tChrome('panel.a11y.fixing'));
      try {
        // The signed-document decision is taken inside performOperation, from
        // the op's own edit class; `allow_signed` says it was taken here
        // rather than making the engine take it again with no way to consent.
        const r = await performOperation(activeFile.path, 'apply_accessibility_fixes', {
          checks: [check.id],
          allow_signed: true,
        });
        if (r === EDIT_DECLINED) {
          setStatus('');
          return false;
        }
        // The buffer changed, so the report re-runs and the row flips itself.
        setStatus(tChrome('panel.a11y.fixed'));
        return true;
      } catch (e: unknown) {
        setStatus(
          tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [activeFile, performOperation],
  );

  /** Declare every run this check named page furniture, a page at a time.
   *
   * Running heads and folios are the common case behind untagged content, and
   * a reader who has recognized them as a set should not have to say so once
   * per line. Marked-content ids are page-scoped, so each page is its own
   * call and its own undoable step. */
  const declareRestDecoration = useCallback(
    async (check: Check): Promise<boolean> => {
      if (!activeFile) return false;
      const calls = artifactCalls(check, true);
      if (calls.length === 0) {
        setStatus(tChrome('panel.a11y.nothingToShow'));
        return false;
      }
      setBusy(true);
      setStatus(tChrome('panel.a11y.fixing'));
      try {
        // One call per page, each its own undoable step. The first declined
        // one stops the run: the gate remembers a Continue per file, so a
        // decline is a decline for the whole set rather than for one page.
        for (const call of calls) {
          const r = await performOperation(activeFile.path, call.method, call.params);
          if (r === EDIT_DECLINED) {
            setStatus('');
            return false;
          }
        }
        setStatus(tChrome('panel.a11y.fixed'));
        return true;
      } catch (e: unknown) {
        setStatus(
          tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [activeFile, performOperation],
  );

  /** Write one authored value at one finding. */
  const applyAuthoredFix = useCallback(
    async (check: Check, finding: Finding | null, index: number | null) => {
      if (!activeFile) return;
      const key = draftKey(check.id, index);
      const spec = authoredCall(check.id, finding, drafts[key] ?? '', true);
      if (!spec) {
        setStatus(tChrome('panel.a11y.needsValue'));
        return;
      }
      setBusy(true);
      setStatus(tChrome('panel.a11y.fixing'));
      try {
        const r = await performOperation(activeFile.path, spec.method, spec.params);
        if (r === EDIT_DECLINED) {
          setStatus('');
          return;
        }
        // The value is written, so the re-check that follows owns this editor
        // again — keeping it "touched" would freeze the empty draft the next
        // report seeds against.
        touchedDrafts.current.delete(key);
        setStatus(tChrome('panel.a11y.fixed'));
      } catch (e: unknown) {
        setStatus(
          tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }),
        );
      } finally {
        setBusy(false);
      }
    },
    [activeFile, drafts, performOperation],
  );

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
                  fix: fixFor(check)?.kind ?? null,
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
      fix: async (checkId) => {
        const check = categories.flatMap((c) => c.checks).find((c) => c.id === checkId);
        if (!check) throw new Error(`no check ${checkId}`);
        if (fixFor(check)?.kind !== 'auto') {
          throw new Error(`a11yFix: ${checkId} has no automatic fix right now`);
        }
        // A refusal reaches the panel as a status line; a harness that saw
        // only "the call returned" could not tell a fix from a refusal.
        if (!(await applyAutoFix(check))) throw new Error(`a11yFix: ${checkId} did not run`);
      },
      artifactRest: async (checkId) => {
        const check = categories.flatMap((c) => c.checks).find((c) => c.id === checkId);
        if (!check) throw new Error(`no check ${checkId}`);
        if (!(await declareRestDecoration(check))) {
          throw new Error(`a11yArtifactRest: ${checkId} did not run`);
        }
      },
      authoredFix: async (checkId, index, value) => {
        const check = categories.flatMap((c) => c.checks).find((c) => c.id === checkId);
        if (!check) throw new Error(`no check ${checkId}`);
        const finding = index === null ? null : (check.findings[index] ?? null);
        if (index !== null && !finding) throw new Error(`no finding ${checkId}[${index}]`);
        setOpenCheck(checkId);
        editDraft(draftKey(checkId, index), value);
        // The draft is state; the apply reads the value it was handed rather
        // than racing React's next render for it.
        const spec = authoredCall(checkId, finding, value, true);
        if (!spec) throw new Error(`a11yAuthoredFix: ${checkId} takes no value like that`);
        if (!activeFile) throw new Error('a11yAuthoredFix: no document is open');
        setBusy(true);
        try {
          await performOperation(activeFile.path, spec.method, spec.params);
          touchedDrafts.current.delete(draftKey(checkId, index));
        } finally {
          setBusy(false);
        }
      },
    });
    return () => registerAccessibility(null);
  }, [
    report,
    categories,
    expanded,
    shownCheck,
    run,
    jump,
    showOnPage,
    writeReport,
    applyAutoFix,
    activeFile,
    editDraft,
    performOperation,
    declareRestDecoration,
  ]);

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
                    const offer: FixOffer | null = fixFor(check);
                    const authored = offer?.kind === 'authored' ? offer.authored : undefined;
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
                          {offer?.kind === 'auto' && (
                            <button
                              data-testid={`a11y-fix-${check.id}`}
                              title={tChrome('panel.a11y.fixTitle')}
                              disabled={busy}
                              onClick={() => void applyAutoFix(check)}
                              className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50 shrink-0"
                            >
                              {tChrome('panel.a11y.fix')}
                            </button>
                          )}
                        </div>
                        {isOpen && (
                          <div className="px-3 pb-2">
                            <div className="text-xs text-neutral-400">
                              {checkExplanation(check.id)}
                            </div>
                            {check.id === 'tagged_content' && check.findings.length > 0 && (
                              <button
                                data-testid="a11y-artifact-rest"
                                disabled={busy}
                                title={tChrome('panel.a11y.artifactRestTitle')}
                                onClick={() => void declareRestDecoration(check)}
                                className="mt-1 px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
                              >
                                {tChrome('panel.a11y.artifactRest')}
                              </button>
                            )}
                            {authored?.scope === 'check' && (
                              <AuthoredEditor
                                testId={`a11y-authored-${check.id}`}
                                authored={authored}
                                busy={busy}
                                value={drafts[draftKey(check.id, null)] ?? ''}
                                placeholder={tChrome(
                                  `panel.a11y.hint.${authored.field}` as Parameters<
                                    typeof tChrome
                                  >[0],
                                )}
                                onChange={(next) => editDraft(draftKey(check.id, null), next)}
                                onApply={() => void applyAuthoredFix(check, null, null)}
                              />
                            )}
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
                                    {authored?.scope === 'finding' && (
                                      <AuthoredEditor
                                        testId={`a11y-authored-${check.id}-${index}`}
                                        authored={authored}
                                        busy={busy}
                                        value={drafts[draftKey(check.id, index)] ?? ''}
                                        placeholder={
                                          suggestionFor(check.id, finding) ||
                                          tChrome(
                                            `panel.a11y.hint.${authored.field}` as Parameters<
                                              typeof tChrome
                                            >[0],
                                          )
                                        }
                                        onChange={(next) =>
                                          editDraft(draftKey(check.id, index), next)
                                        }
                                        onApply={() => void applyAuthoredFix(check, finding, index)}
                                      />
                                    )}
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
