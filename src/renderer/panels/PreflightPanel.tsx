import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { EDIT_DECLINED } from '../lib/edit-text';
import { useAppDispatch } from '../state/AppStateProvider';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { getCanvasServices } from '../commands/context';
import { app, dialog, report as reportFile } from '../lib/tauri-bridge';
import { gsPathIfAvailable } from '../lib/gs-capability';
import { useGsCapability } from '../hooks/useGsCapability';
import { GsRequiredNotice } from '../components/GsRequiredNotice';
import { tChrome, tChromeCount } from '../i18n';
import { TEST_HARNESS_ENABLED, registerPreflight } from '../testHarness';
import type { PlaceableFinding } from '../lib/a11y-findings';
import {
  DEFAULT_PROFILE_ID,
  FIXUP_IDS,
  deriveProfile,
  isShippedProfileId,
  loadUserProfiles,
  paramKind,
  pickerOrder,
  profileFileName,
  removeProfile,
  type PreflightProfile,
  type ProfileCheck,
  type Severity,
} from '../lib/preflight-profile';
import {
  exportProfileToPath,
  importProfileFromPath,
  keepProfile,
} from '../lib/preflight-profile-io';
import {
  TRAPPED_STATES,
  authoredFixProfile,
  autoFixCall,
  draftKey,
  fixFor,
  fixableChecks,
  suggestionFor,
} from '../lib/preflight-fixes';
import {
  categoryCount,
  categoryName,
  checkExplanation,
  checkName,
  findingDetail,
  findingWhere,
  formatPreflightHtml,
  formatPreflightText,
  hiddenFindings,
  orderedCategories,
  paramsLine,
  profileName,
  reportFileName,
  summaryLine,
  verdictLabel,
  type Check,
  type Finding,
  type PreflightReport,
  type Verdict,
} from '../lib/preflight-report';

// The print-production preflight surface: 37 checks measured against ONE
// profile, as a categorized tree, each finding carrying a jump to the thing it
// names and each row carrying the rule it was measured against.
//
// **A verdict is meaningless without its rule.** So the profile sits on the
// header rather than inside a dialog, and every check row states its resolved
// parameters — the same document under two profiles gives two answers, and a
// report showing only the answer would be unreadable a year later by someone
// who does not have the profile.
//
// Two gestures, two outcomes, and they never trade places: clicking a finding
// JUMPS to the surface that owns it, and a control that changes a rule never
// moves the view. Three address kinds, one fewer than it looks: `content` (a
// rectangle drawn on the canvas), `page` (a box, a size or a coverage figure
// is about a page, not a thing on it) and `object` (an annotation, a form
// field, or an INK). The last two route by CHECK, because what owns "no trim
// box" and what owns "an unapproved ink" are different surfaces.
//
// The editor is a second VIEW of this panel, not a dialog: the same 37 rows
// with their enabled/severity/parameter controls, plus the fixup checklist.
// Saving an edit to a shipped profile creates a DERIVED profile rather than
// overwriting the shipped one, which is what keeps "reset to the shipped rule"
// always available. Whether a rule is VALID is the engine's answer and only
// the engine's — a second validator here would be a second answer waiting to
// drift, and the command line has no renderer at all.

// A needs-review row shows neither a tick nor a cross: it has not been
// decided, and borrowing either glyph is the claim the checker refuses to
// make.
const ICON: Record<Verdict, { glyph: string; color: string }> = {
  pass: { glyph: '✓', color: '#2fbf71' },
  warn: { glyph: '!', color: '#fbbf24' },
  fail: { glyph: '✕', color: '#f87171' },
  needs_review: { glyph: '?', color: '#a78bfa' },
  not_applicable: { glyph: '–', color: '#6b7280' },
};

/** Where a `page` or `object` finding is answered — the surface that owns the
 * edit, per check. A check with no entry lists its findings and jumps nowhere:
 * inventing a destination that cannot perform the repair is worse than leaving
 * the row where the reader can read it. */
const OWNING_OP: Record<string, string> = {
  pdf_version: 'pdf_version',
  print_permitted: 'decrypt',
  structurally_sound: 'repair',
  embedded_files: 'attachments',
  page_size_expected: 'pagebox',
  trim_box: 'pagebox',
  bleed_sufficient: 'pagebox',
  colour_family: 'convert_cmyk',
  grayscale_only: 'grayscale',
  device_independent_colour: 'convert_cmyk',
  spot_ink_count: 'inkmanager',
  spot_ink_names: 'inkmanager',
  ink_coverage_max: 'outputpreview',
  overprint: 'outputpreview',
  image_max_dpi: 'compress',
  image_compression: 'compress',
  image_colour_space: 'convert_cmyk',
  live_transparency: 'flattener',
  hairlines_absent: 'hairlines',
  optional_content: 'layers',
  printing_annotations: 'comments',
  interactive_form: 'forms',
  document_javascript: 'document_js',
};

// A check can name thousands of runs on a long document. The panel lists a
// bounded prefix and says how many it did not draw; the exported report
// carries every one, which is what the export is for.
const MAX_LISTED_FINDINGS = 200;

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

function labelOf(profile: PreflightProfile): string {
  return profileName({
    id: profile.id,
    name: profile.name,
    name_key: profile.name_key ?? '',
    based_on: profile.based_on ?? '',
  });
}

/** One parameter's control. The engine owns the bound and refuses a bad value
 * by name; this only decides which control to draw. */
function ParamControl({
  checkId,
  name,
  value,
  disabled,
  onChange,
}: {
  checkId: string;
  name: string;
  value: unknown;
  disabled: boolean;
  onChange: (next: unknown) => void;
}): React.ReactElement {
  const kind = paramKind(value);
  const testId = `preflight-param-${checkId}-${name}`;
  const label = tChrome(`panel.preflight.param.${name}` as Parameters<typeof tChrome>[0]);
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-400">
      <span className="min-w-40">{label}</span>
      {kind === 'boolean' ? (
        <input
          type="checkbox"
          data-testid={testId}
          disabled={disabled}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : kind === 'list' ? (
        <input
          data-testid={testId}
          disabled={disabled}
          className="min-w-0 flex-1 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs text-neutral-200"
          value={(value as unknown[]).join(', ')}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            )
          }
        />
      ) : kind === 'text' ? (
        <input
          data-testid={testId}
          disabled={disabled}
          className="min-w-0 flex-1 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs text-neutral-200"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="number"
          data-testid={testId}
          disabled={disabled}
          step={kind === 'integer' ? 1 : 'any'}
          className="w-28 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs text-neutral-200"
          value={String(value ?? 0)}
          onChange={(e) => {
            const next = Number(e.target.value);
            onChange(Number.isFinite(next) ? next : value);
          }}
        />
      )}
    </label>
  );
}

/** One authored fixup's editor: the value, and the control that writes it.
 *
 * A value nobody typed is never sent — the four authored fixups exist because
 * a trapping claim, a document title, a bleed margin and an ink alias are
 * decisions, and a machine that invented one would be wrong more expensively
 * than a row left standing. */
function AuthoredFixEditor({
  checkId,
  findingIndex,
  input,
  field,
  fixup,
  busy,
  value,
  onChange,
  onApply,
}: {
  checkId: string;
  findingIndex: number | null;
  input: string;
  field: string;
  fixup: string;
  busy: boolean;
  value: string;
  onChange: (next: string) => void;
  onApply: () => void;
}): React.ReactElement {
  const suffix = findingIndex === null ? '' : `-${findingIndex}`;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 px-3 pb-2">
      <span className="text-xs text-neutral-400">
        {tChrome(`panel.preflight.fixField.${field}` as Parameters<typeof tChrome>[0])}
      </span>
      {input === 'trapped' ? (
        <select
          data-testid={`preflight-fix-value-${checkId}${suffix}`}
          disabled={busy}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs text-neutral-200"
        >
          {TRAPPED_STATES.map((state) => (
            <option key={state} value={state}>
              {tChrome(`panel.preflight.trapped.${state}` as Parameters<typeof tChrome>[0])}
            </option>
          ))}
        </select>
      ) : (
        <input
          data-testid={`preflight-fix-value-${checkId}${suffix}`}
          type={input === 'number' ? 'number' : 'text'}
          step={input === 'number' ? 'any' : undefined}
          disabled={busy}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs text-neutral-200"
        />
      )}
      <button
        data-testid={`preflight-fix-${checkId}${suffix}`}
        disabled={busy}
        onClick={onApply}
        className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
      >
        {tChrome(`panel.preflight.fixup.${fixup}` as Parameters<typeof tChrome>[0])}
      </button>
    </div>
  );
}

export function PreflightPanel(): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call } = useEngine();
  const { performOperation } = useOperations();
  const dispatch = useAppDispatch();
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [shipped, setShipped] = useState<PreflightProfile[]>([]);
  const [userProfiles, setUserProfiles] = useState<PreflightProfile[]>(() =>
    loadUserProfiles(),
  );
  const [profileId, setProfileId] = useState<string>(DEFAULT_PROFILE_ID);
  const [editing, setEditing] = useState<PreflightProfile | null>(null);
  const [editName, setEditName] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  const [shownCheck, setShownCheck] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const gs = useGsCapability();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const buffer = activeFile?.buffer ?? null;
  const workingPath = activeFile?.workingPath ?? null;
  const path = activeFile?.path ?? null;
  const name = activeFile?.name ?? '';
  // Which document the expansion was seeded for. Every edit swaps the buffer,
  // so buffer identity cannot key it — the Tags panel's rule, same reason.
  const seededFor = useRef<string | null>(null);

  // The shipped profiles are ENGINE constants: the command line and a
  // scheduled run have no localStorage, so there is one authority for what
  // `sheetfed_offset` means and the panel reads it rather than restating it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = (await call('list_preflight_profiles', {})) as unknown as {
          profiles: PreflightProfile[];
        };
        if (!cancelled) setShipped(res.profiles ?? []);
      } catch {
        if (!cancelled) setShipped([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [call]);

  const profiles = useMemo(
    () => pickerOrder(shipped, userProfiles),
    [shipped, userProfiles],
  );
  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? profiles[0] ?? null,
    [profiles, profileId],
  );

  /** The optional tools the checks and the fixups reach for. Total area
   * coverage is a Ghostscript run per page and the colour, downsample and
   * standard-conversion fixups are gs-backed — so the path is passed when
   * there is one and '' when there is not. The structural checks are gs-free
   * and still run; the raster ones report NOT RUN with their reason, which is
   * the one thing a preflight report may never do silently. */
  const tools = useCallback(
    async () => ({
      gs_path: await gsPathIfAvailable(),
      font_dir: await app.getEditFontPath(),
    }),
    [],
  );

  const run = useCallback(
    async (usingId: string) => {
      if (!workingPath) return;
      setBusy(true);
      setStatus(tChrome('panel.preflight.analysing'));
      try {
        const user = userProfiles.find((p) => p.id === usingId);
        const res = (await call('preflight', {
          file: workingPath,
          // A user profile travels as the rule itself; a shipped one by id, so
          // the engine resolves its own constant rather than a copy of it.
          profile: user ?? usingId,
          ...(await tools()),
        })) as unknown as PreflightReport;
        setReport(res);
        // The addresses in the previous run's findings were read from a
        // document this run has replaced, so what is drawn goes with them.
        getCanvasServices()?.a11yFindings.clear();
        setShownCheck(null);
        if (seededFor.current !== workingPath) {
          seededFor.current = workingPath;
          setExpanded(
            new Set(
              res.categories
                .filter((c) =>
                  c.checks.some((k) => k.status === 'fail' || k.status === 'warn'),
                )
                .map((c) => c.id),
            ),
          );
          setOpenCheck(null);
        }
        setStatus('');
      } catch (e: unknown) {
        setStatus(
          tChrome('panel.common.error', {
            message: e instanceof Error ? e.message : String(e),
          }),
        );
      } finally {
        setBusy(false);
      }
    },
    [workingPath, call, userProfiles, tools],
  );

  useEffect(() => {
    if (!buffer || !workingPath) {
      setReport(null);
      return;
    }
    void run(profileId);
  }, [buffer, workingPath, profileId, run]);

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
        setStatus(tChrome('panel.preflight.noCanvas'));
        return;
      }
      if (shownCheck === check.id) {
        services.a11yFindings.clear();
        setShownCheck(null);
        return;
      }
      const { shown } = await services.a11yFindings.publish(path, placeable(check));
      setShownCheck(shown > 0 ? check.id : null);
      if (shown === 0) setStatus(tChrome('panel.preflight.nothingToShow'));
    },
    [path, shownCheck],
  );

  /** One finding's jump — one of the three address kinds, each landing on the
   * surface that owns the thing named. */
  const jump = useCallback(
    async (check: Check, finding: Finding, index: number) => {
      if (finding.address.kind === 'content') {
        const services = getCanvasServices();
        if (!services || !path) {
          setStatus(tChrome('panel.preflight.noCanvas'));
          return;
        }
        if (shownCheck !== check.id) {
          const { shown } = await services.a11yFindings.publish(path, placeable(check));
          setShownCheck(shown > 0 ? check.id : null);
        }
        // The published set is this check's content findings in order, so the
        // clicked row's position within THAT list is what addresses it.
        const at =
          check.findings.slice(0, index + 1).filter((f) => f.address.kind === 'content')
            .length - 1;
        const target = services.a11yFindings.list()[at];
        if (target) services.a11yFindings.focus(target.id);
        return;
      }
      const op = OWNING_OP[check.id];
      if (op) dispatch({ type: 'UI_SET_ACTIVE_OP', op });
      else setStatus(tChrome('panel.preflight.nothingToShow'));
    },
    [dispatch, path, shownCheck],
  );

  // ── fixups ──────────────────────────────────────────────────────────────
  //
  // The ENGINE owns what repairing a finding means AND the canonical order a
  // pass runs in, which no profile may change — so the panel sends CHECK ids
  // and never a sequence of its own.
  //
  // **One invocation is ONE undoable entry**, and that is the honest answer
  // rather than the convenient one: `performOperation` pushes one entry per
  // call, the user asked for "fix this row" or "fix what this profile can"
  // once, and the fixups inside a pass condition each other — undoing the
  // hairline stage while the flatten that rasterized around it stood would
  // leave a document the canonical order never produces.

  /** The rule a fix run measures against: a shipped profile by id so the
   * engine resolves its own constant, a user profile as the rule itself. */
  const profileArg = useMemo(
    () =>
      activeProfile && !isShippedProfileId(activeProfile.id)
        ? (activeProfile as unknown)
        : (activeProfile?.id ?? DEFAULT_PROFILE_ID),
    [activeProfile],
  );
  const carried = useMemo(
    () => (activeProfile?.fixups ?? []).map((f) => f.id),
    [activeProfile],
  );

  const runFix = useCallback(
    async (params: Record<string, unknown>): Promise<boolean> => {
      if (!activeFile) return false;
      setBusy(true);
      setStatus(tChrome('panel.preflight.fixing'));
      try {
        const r = await performOperation(activeFile.path, 'apply_preflight_fixups', {
          ...params,
          ...(await tools()),
          tesseract_path: await app.getTesseractPath(),
          // The report on screen is the one this repair is answering, and
          // total area coverage is a Ghostscript run per page — so the
          // measurement is handed on rather than taken twice. The re-check
          // AFTER is never skipped.
          ...(report ? { report } : {}),
        });
        if (r === EDIT_DECLINED) {
          setStatus('');
          return false;
        }
        // The buffer changed, so the report re-runs and the rows flip
        // themselves — the re-check is never a claim the panel makes.
        setStatus(tChrome('panel.preflight.fixed'));
        return true;
      } catch (e: unknown) {
        setStatus(
          tChrome('panel.common.error', {
            message: e instanceof Error ? e.message : String(e),
          }),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [activeFile, performOperation, report, tools],
  );

  /** Repair one row: the engine resolves the check to its doors and applies
   * them in its own order. */
  const applyAutoFix = useCallback(
    async (checkId: string): Promise<boolean> => {
      const spec = autoFixCall(profileArg, [checkId]);
      if (!spec) return false;
      return runFix(spec.params);
    },
    [profileArg, runFix],
  );

  /** Everything this profile can repair, as one act. */
  const applyAllFixes = useCallback(async (): Promise<boolean> => {
    const all = categories.flatMap((c) => c.checks);
    const spec = autoFixCall(profileArg, fixableChecks(all, carried));
    if (!spec) {
      setStatus(tChrome('panel.preflight.nothingToFix'));
      return false;
    }
    return runFix(spec.params);
  }, [categories, profileArg, carried, runFix]);

  /** Write one authored value. It travels as a PARAMETER of the profile's own
   * fixup entry rather than as a second argument, so the engine validates it
   * exactly like any other rule — there is one validator and this is not it. */
  const applyAuthoredFix = useCallback(
    async (check: Check, findingIndex: number | null): Promise<boolean> => {
      const offer = fixFor(check, carried);
      if (!offer?.authored || !activeProfile) return false;
      const key = draftKey(check.id, findingIndex);
      const finding = findingIndex === null ? null : check.findings[findingIndex];
      const extra =
        offer.authored.fixup === 'alias_spot' && finding?.address.ink
          ? { source: finding.address.ink }
          : {};
      const patched = authoredFixProfile(
        activeProfile as unknown as {
          fixups: { id: string; params: Record<string, unknown> }[];
        },
        offer.authored,
        drafts[key] ?? '',
        extra,
      );
      if (!patched) {
        setStatus(tChrome('panel.preflight.needsValue'));
        return false;
      }
      const applied = await runFix({
        profile: patched.profile,
        checks: patched.checks,
      });
      if (applied) setDrafts((d) => ({ ...d, [key]: '' }));
      return applied;
    },
    [activeProfile, carried, drafts, runFix],
  );

  /** Emit the report to `target`. The extension the user landed on picks the
   * format — one dialog, two emitters, one model. */
  const writeReport = useCallback(
    async (target: string, current: PreflightReport): Promise<string> => {
      const emitted = { documentName: name, runAt: new Date(), report: current };
      return reportFile.write(
        target,
        /\.html$/i.test(target)
          ? formatPreflightHtml(emitted)
          : formatPreflightText(emitted),
      );
    },
    [name],
  );

  const exportReport = useCallback(async () => {
    if (!report) return;
    const target = await dialog.saveReportFile(reportFileName(name, new Date(), 'html'));
    if (!target) return;
    setBusy(true);
    setStatus(tChrome('panel.preflight.exporting'));
    try {
      setStatus(
        tChrome('panel.preflight.exported', { path: await writeReport(target, report) }),
      );
    } catch (e: unknown) {
      setStatus(
        tChrome('panel.common.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [report, name, writeReport]);

  // ── profile management ──────────────────────────────────────────────────

  const openEditor = useCallback(() => {
    if (!activeProfile) return;
    setEditing(JSON.parse(JSON.stringify(activeProfile)) as PreflightProfile);
    setEditName(
      isShippedProfileId(activeProfile.id)
        ? tChrome('panel.preflight.copySuffix', { name: labelOf(activeProfile) })
        : activeProfile.name,
    );
  }, [activeProfile]);

  const editCheck = useCallback((checkId: string, patch: Partial<ProfileCheck>) => {
    setEditing((prev) => {
      if (!prev) return prev;
      const checks = { ...prev.checks };
      checks[checkId] = { ...(checks[checkId] ?? {}), ...patch };
      return { ...prev, checks };
    });
  }, []);

  const toggleFixup = useCallback((fixupId: string, on: boolean) => {
    setEditing((prev) => {
      if (!prev) return prev;
      const fixups = on
        ? [...prev.fixups.filter((f) => f.id !== fixupId), { id: fixupId, params: {} }]
        : prev.fixups.filter((f) => f.id !== fixupId);
      return { ...prev, fixups };
    });
  }, []);

  /** Save the edited rule. A shipped id is never written over: the save
   * derives a copy, which is what makes "reset to the shipped rule" always
   * available. Validation is the ENGINE's and only the engine's. */
  const saveEdits = useCallback(async () => {
    if (!editing) return;
    const taken = userProfiles.map((p) => p.id);
    const candidate = isShippedProfileId(editing.id)
      ? deriveProfile(editing, editName.trim() || editing.name, taken)
      : { ...editing, name: editName.trim() || editing.name };
    setBusy(true);
    try {
      const accepted = (await call('validate_preflight_profile', {
        profile: candidate,
      })) as unknown as PreflightProfile;
      const kept: PreflightProfile = { ...candidate, ...accepted };
      setUserProfiles(keepProfile(kept));
      setProfileId(kept.id);
      setEditing(null);
      setStatus(tChrome('panel.preflight.profileSaved', { name: kept.name }));
    } catch (e: unknown) {
      setStatus(
        tChrome('panel.common.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [editing, editName, userProfiles, call]);

  const duplicateProfile = useCallback(() => {
    if (!activeProfile) return;
    const copy = deriveProfile(
      activeProfile,
      tChrome('panel.preflight.copySuffix', { name: labelOf(activeProfile) }),
      userProfiles.map((p) => p.id),
    );
    setUserProfiles(keepProfile(copy));
    setProfileId(copy.id);
    setStatus(tChrome('panel.preflight.profileSaved', { name: copy.name }));
  }, [activeProfile, userProfiles]);

  const deleteActiveProfile = useCallback(() => {
    if (!activeProfile || isShippedProfileId(activeProfile.id)) return;
    const removed = activeProfile.name;
    setUserProfiles(removeProfile(activeProfile.id));
    setProfileId(DEFAULT_PROFILE_ID);
    setStatus(tChrome('panel.preflight.profileRemoved', { name: removed }));
  }, [activeProfile]);

  const importProfile = useCallback(
    async (fromPath: string): Promise<PreflightProfile> => {
      setBusy(true);
      try {
        const parsed = await importProfileFromPath(fromPath);
        const accepted = (await call('validate_preflight_profile', {
          profile: parsed,
        })) as unknown as PreflightProfile;
        const kept: PreflightProfile = { ...parsed, ...accepted };
        setUserProfiles(keepProfile(kept));
        setProfileId(kept.id);
        setStatus(tChrome('panel.preflight.profileImported', { name: kept.name }));
        return kept;
      } finally {
        setBusy(false);
      }
    },
    [call],
  );

  const pickAndImportProfile = useCallback(async () => {
    const from = await dialog.pickAnyFile();
    if (!from) return;
    try {
      await importProfile(from);
    } catch (e: unknown) {
      setStatus(
        tChrome('panel.common.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }, [importProfile]);

  const exportProfile = useCallback(
    async (target: string): Promise<string> => {
      if (!activeProfile) throw new Error('preflightExportProfile: no profile is selected');
      await exportProfileToPath(activeProfile, target);
      setStatus(tChrome('panel.preflight.profileExported', { path: target }));
      return target;
    },
    [activeProfile],
  );

  const pickAndExportProfile = useCallback(async () => {
    if (!activeProfile) return;
    const target = await dialog.saveFile({ defaultPath: profileFileName(activeProfile) });
    if (!target) return;
    try {
      await exportProfile(target);
    } catch (e: unknown) {
      setStatus(
        tChrome('panel.common.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }, [activeProfile, exportProfile]);

  // The dialogs the panel drives are native, so e2e injects the destination
  // into the SAME emit-and-write the button runs, and reaches the row handlers
  // by check id (a finding row has no id of its own).
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerPreflight({
      snapshot: () =>
        report
          ? {
              profile: report.profile.id,
              summary: report.summary,
              checks: orderedCategories(report).flatMap((category) =>
                category.checks.map((check) => ({
                  id: check.id,
                  category: category.id,
                  status: check.status,
                  severity: check.severity,
                  counted: check.counted,
                  findings: check.finding_count,
                  addressKinds: [...new Set(check.findings.map((f) => f.address.kind))],
                  params: check.params,
                  fix: fixFor(check, carried)?.kind ?? null,
                })),
              ),
              profiles: profiles.map((p) => p.id),
              expandedCategories: [...expanded],
              shownCheck,
              fixable: fixableChecks(
                orderedCategories(report).flatMap((c) => c.checks),
                carried,
              ),
            }
          : null,
      recheck: () => run(profileId),
      // The picker sets the id and the `profileId` effect owns the run. Running
      // here as well starts a second, overlapping run: the caller's wait is
      // satisfied by the first, and the second lands later and clears both the
      // drawn findings and `shownCheck` — which turns a following toggle into a
      // publish.
      selectProfile: async (id: string) => {
        setProfileId(id);
      },
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
        if (!report) throw new Error('preflightExport: the report has not run yet');
        return writeReport(destPath, report);
      },
      importProfileFrom: async (fromPath) => (await importProfile(fromPath)).id,
      exportProfileTo: exportProfile,
      fix: applyAutoFix,
      fixAll: applyAllFixes,
      authoredFix: async (checkId, index, value) => {
        const check = categories.flatMap((c) => c.checks).find((c) => c.id === checkId);
        if (!check) throw new Error(`no check ${checkId}`);
        setDrafts((d) => ({ ...d, [draftKey(checkId, index)]: value }));
        // The draft state the editor reads is set above; the apply below takes
        // the value directly, so the injector cannot race its own setState.
        const offer = fixFor(check, carried);
        if (!offer?.authored || !activeProfile) throw new Error(`no authored fix ${checkId}`);
        const finding = index === null ? null : check.findings[index];
        const patched = authoredFixProfile(
          activeProfile as unknown as {
            fixups: { id: string; params: Record<string, unknown> }[];
          },
          offer.authored,
          value,
          offer.authored.fixup === 'alias_spot' && finding?.address.ink
            ? { source: finding.address.ink }
            : {},
        );
        if (!patched) throw new Error(`preflightAuthoredFix: ${checkId} needs a value`);
        return runFix({ profile: patched.profile, checks: patched.checks });
      },
    });
    return () => registerPreflight(null);
  }, [
    report,
    categories,
    profiles,
    profileId,
    expanded,
    shownCheck,
    carried,
    activeProfile,
    run,
    jump,
    showOnPage,
    writeReport,
    importProfile,
    exportProfile,
    applyAutoFix,
    applyAllFixes,
    runFix,
  ]);

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.preflight.open')} />;
  }

  if (editing) {
    const shippedRule = isShippedProfileId(editing.id);
    return (
      <div className="flex flex-col gap-3" data-testid="preflight-editor">
        <div className="flex items-center justify-between">
          <div className="text-sm text-neutral-300">
            {tChrome('panel.preflight.editorHeading', { name: labelOf(editing) })}
          </div>
          <button
            data-testid="preflight-editor-close"
            onClick={() => setEditing(null)}
            className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700"
          >
            {tChrome('panel.preflight.closeEditor')}
          </button>
        </div>
        {shippedRule && (
          <div className="text-xs text-amber-300">
            {tChrome('panel.preflight.shippedReadOnly')}
          </div>
        )}
        {editing.based_on && (
          <div className="text-xs text-neutral-500">
            {tChrome('panel.preflight.derivedFrom', { name: editing.based_on })}
          </div>
        )}
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <span>{tChrome('panel.preflight.profileNameLabel')}</span>
          <input
            data-testid="preflight-editor-name"
            className="min-w-0 flex-1 bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs text-neutral-200"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
          <button
            data-testid="preflight-editor-save"
            disabled={busy}
            onClick={() => void saveEdits()}
            className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
          >
            {tChrome(
              shippedRule ? 'panel.preflight.saveProfile' : 'panel.preflight.saveEdits',
            )}
          </button>
        </label>

        <div className="flex flex-col gap-2">
          {(report ? orderedCategories(report) : []).map((category) => (
            <div key={category.id}>
              <div className="px-2 py-1 text-xs uppercase tracking-wide text-neutral-400">
                {categoryName(category.id)}
              </div>
              {category.checks.map((check) => {
                const rule = editing.checks[check.id] ?? {};
                const enabled = rule.enabled !== false;
                return (
                  <div
                    key={check.id}
                    data-testid={`preflight-edit-${check.id}`}
                    className="rounded border border-neutral-800 bg-neutral-800/60 px-3 py-2 mb-1"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-1 text-sm text-neutral-200">
                        <input
                          type="checkbox"
                          data-testid={`preflight-enabled-${check.id}`}
                          checked={enabled}
                          onChange={(e) => editCheck(check.id, { enabled: e.target.checked })}
                        />
                        {checkName(check.id)}
                      </label>
                      <label className="flex items-center gap-1 text-xs text-neutral-400">
                        <span>{tChrome('panel.preflight.severityLabel')}</span>
                        <select
                          data-testid={`preflight-severity-${check.id}`}
                          disabled={!enabled}
                          value={(rule.severity as Severity) ?? (check.severity as Severity)}
                          onChange={(e) =>
                            editCheck(check.id, { severity: e.target.value as Severity })
                          }
                          className="bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs text-neutral-200"
                        >
                          <option value="fail">
                            {tChrome('panel.preflight.severity.fail')}
                          </option>
                          <option value="warn">
                            {tChrome('panel.preflight.severity.warn')}
                          </option>
                        </select>
                      </label>
                    </div>
                    <div className="mt-1 flex flex-col gap-1">
                      {Object.entries(check.params).map(([param, fallback]) => (
                        <ParamControl
                          key={param}
                          checkId={check.id}
                          name={param}
                          value={rule[param] ?? fallback}
                          disabled={!enabled}
                          onChange={(next) => editCheck(check.id, { [param]: next })}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div>
          <div className="px-2 py-1 text-xs uppercase tracking-wide text-neutral-400">
            {tChrome('panel.preflight.fixupsHeading')}
          </div>
          <div className="flex flex-col gap-0.5">
            {FIXUP_IDS.map((fixupId) => (
              <label
                key={fixupId}
                className="flex items-center gap-2 text-xs text-neutral-300"
              >
                <input
                  type="checkbox"
                  data-testid={`preflight-fixup-${fixupId}`}
                  checked={editing.fixups.some((f) => f.id === fixupId)}
                  onChange={(e) => toggleFixup(fixupId, e.target.checked)}
                />
                {tChrome(`panel.preflight.fixup.${fixupId}` as Parameters<typeof tChrome>[0])}
              </label>
            ))}
          </div>
        </div>
        <StatusBar message={status} busy={busy} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-neutral-400">
          {tChrome('panel.common.workingOn')}{' '}
          <span className="text-neutral-200">{activeFile.name}</span>
        </div>
        <GsRequiredNotice capability={gs} testId="preflight-gs" />
        <div className="flex items-center gap-2">
          <button
            data-testid="preflight-recheck"
            onClick={() => void run(profileId)}
            disabled={busy}
            className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
          >
            {tChrome('panel.preflight.rerun')}
          </button>
          <button
            data-testid="preflight-fix-all"
            onClick={() => void applyAllFixes()}
            disabled={busy || !report || fixableChecks(
              categories.flatMap((c) => c.checks), carried,
            ).length === 0}
            className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
          >
            {tChrome('panel.preflight.fixAll')}
          </button>
          <button
            data-testid="preflight-export"
            onClick={() => void exportReport()}
            disabled={busy || !report}
            className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
          >
            {tChrome('panel.preflight.export')}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-neutral-400">
          <span>{tChrome('panel.preflight.profileLabel')}</span>
          <select
            data-testid="preflight-profile"
            value={activeProfile?.id ?? ''}
            disabled={busy}
            onChange={(e) => setProfileId(e.target.value)}
            className="bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5 text-xs text-neutral-200"
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {labelOf(p)}
              </option>
            ))}
          </select>
        </label>
        <button
          data-testid="preflight-profile-edit"
          onClick={openEditor}
          disabled={busy || !activeProfile}
          className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
        >
          {tChrome('panel.preflight.editProfile')}
        </button>
        <button
          data-testid="preflight-profile-duplicate"
          onClick={duplicateProfile}
          disabled={busy || !activeProfile}
          className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
        >
          {tChrome('panel.preflight.duplicateProfile')}
        </button>
        <button
          data-testid="preflight-profile-import"
          onClick={() => void pickAndImportProfile()}
          disabled={busy}
          className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
        >
          {tChrome('panel.preflight.importProfile')}
        </button>
        <button
          data-testid="preflight-profile-export"
          onClick={() => void pickAndExportProfile()}
          disabled={busy || !activeProfile}
          className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
        >
          {tChrome('panel.preflight.exportProfile')}
        </button>
        {activeProfile && !isShippedProfileId(activeProfile.id) && (
          <button
            data-testid="preflight-profile-delete"
            onClick={deleteActiveProfile}
            disabled={busy}
            className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50"
          >
            {tChrome('panel.preflight.deleteProfile')}
          </button>
        )}
      </div>

      {report && (
        <div className="text-sm text-neutral-300" data-testid="preflight-summary">
          {summaryLine(report.summary)}
        </div>
      )}

      <div className="flex flex-col gap-2" data-testid="preflight-tree">
        {categories.map((category) => {
          const open = expanded.has(category.id);
          return (
            <div key={category.id} data-testid={`preflight-category-${category.id}`}>
              <button
                className="flex w-full items-center justify-between px-2 py-1 text-xs uppercase tracking-wide text-neutral-400 hover:text-neutral-200"
                aria-expanded={open}
                data-testid={`preflight-category-toggle-${category.id}`}
                onClick={() => toggleCategory(category.id)}
              >
                <span>
                  <span aria-hidden className="me-1">
                    {open ? '▾' : '▸'}
                  </span>
                  {categoryName(category.id)}
                </span>
                <span data-testid={`preflight-category-count-${category.id}`}>
                  {categoryCount(category)}
                </span>
              </button>
              {open && (
                <div className="flex flex-col gap-1">
                  {category.checks.map((check) => {
                    const listed = check.findings.slice(0, MAX_LISTED_FINDINGS);
                    const hidden =
                      hiddenFindings(check) + (check.findings.length - listed.length);
                    const onPage = placeable(check).length > 0;
                    const isOpen = openCheck === check.id;
                    const offer = fixFor(check, carried);
                    return (
                      <div
                        key={check.id}
                        data-testid={`preflight-check-${check.id}`}
                        data-preflight-status={check.status}
                        // A not-applicable row is marked by its BORDER, never
                        // by a fade or a recessed fill: it is excluded from the
                        // pass tally and has to read as a different kind of
                        // row, but every treatment that changes what the text
                        // sits on changes its contrast — and does so
                        // differently per theme. The glyph and the verdict
                        // label carry the state; the dashes carry the grouping.
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
                            data-testid={`preflight-check-open-${check.id}`}
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
                          {check.finding_count > 0 && (
                            <span className="text-xs text-neutral-400 shrink-0">
                              {tChrome('panel.preflight.findingCount', {
                                count: check.finding_count,
                                counted: check.counted,
                              })}
                            </span>
                          )}
                          {onPage && (
                            <button
                              data-testid={`preflight-show-${check.id}`}
                              onClick={() => void showOnPage(check)}
                              className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 shrink-0"
                            >
                              {shownCheck === check.id
                                ? tChrome('panel.preflight.hide')
                                : tChrome('panel.preflight.show')}
                            </button>
                          )}
                          {/* The fix control never jumps and the finding row
                              never fixes — two gestures, two outcomes. */}
                          {offer?.kind === 'auto' && (
                            <button
                              data-testid={`preflight-fix-${check.id}`}
                              disabled={busy}
                              onClick={() => void applyAutoFix(check.id)}
                              className="px-2 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded hover:bg-neutral-700 disabled:opacity-50 shrink-0"
                            >
                              {tChrome(
                                `panel.preflight.fixup.${offer.fixups[0]}` as Parameters<
                                  typeof tChrome
                                >[0],
                              )}
                            </button>
                          )}
                        </div>
                        {offer?.kind === 'authored' &&
                          offer.authored?.scope === 'check' && (
                            <AuthoredFixEditor
                              checkId={check.id}
                              findingIndex={null}
                              input={offer.authored.input}
                              field={offer.authored.field}
                              fixup={offer.authored.fixup}
                              busy={busy}
                              value={
                                drafts[draftKey(check.id, null)] ?? suggestionFor(check)
                              }
                              onChange={(next) =>
                                setDrafts((d) => ({
                                  ...d,
                                  [draftKey(check.id, null)]: next,
                                }))
                              }
                              onApply={() => void applyAuthoredFix(check, null)}
                            />
                          )}
                        {isOpen && (
                          <div className="px-3 pb-2">
                            <div className="text-xs text-neutral-400">
                              {checkExplanation(check.id)}
                            </div>
                            {/* Every row states its rule. Without it the
                                verdict cannot be read a year later by anyone
                                who does not have the profile. */}
                            <div
                              className="text-xs text-neutral-500"
                              data-testid={`preflight-rule-${check.id}`}
                            >
                              {paramsLine(check)}
                            </div>
                            {listed.length > 0 && (
                              <ul className="mt-1 flex flex-col gap-0.5">
                                {listed.map((finding, index) => (
                                  <li key={`${check.id}:${index}`}>
                                    <button
                                      className="w-full text-start text-xs text-neutral-300 hover:text-neutral-100"
                                      title={tChrome('panel.preflight.jumpTitle')}
                                      data-testid={`preflight-finding-${check.id}-${index}`}
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
                                    {offer?.kind === 'authored' &&
                                      offer.authored?.scope === 'finding' && (
                                        <AuthoredFixEditor
                                          checkId={check.id}
                                          findingIndex={index}
                                          input={offer.authored.input}
                                          field={offer.authored.field}
                                          fixup={offer.authored.fixup}
                                          busy={busy}
                                          value={drafts[draftKey(check.id, index)] ?? ''}
                                          onChange={(next) =>
                                            setDrafts((d) => ({
                                              ...d,
                                              [draftKey(check.id, index)]: next,
                                            }))
                                          }
                                          onApply={() =>
                                            void applyAuthoredFix(check, index)
                                          }
                                        />
                                      )}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {hidden > 0 && (
                              <div className="mt-1 text-xs text-neutral-500">
                                {tChrome('panel.preflight.moreFindings', { count: hidden })}
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
        <div className="text-xs text-amber-400" data-testid="preflight-unreadable">
          <div>{tChrome('panel.preflight.unreadableHeading')}</div>
          {report.unreadable.map((branch) => (
            <div key={branch.reason}>{branch.reason}</div>
          ))}
        </div>
      )}

      {report && (
        <div className="text-xs text-neutral-500">
          {tChromeCount('panel.preflight.images', report.images)}
          {report.color_families.length > 0 &&
            tChrome('panel.preflight.colour', {
              families: report.color_families.join(', '),
            })}
        </div>
      )}
      <StatusBar message={status} busy={busy} />
    </div>
  );
}
