import React, { useCallback, useEffect, useState } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { invokeCommand } from '../commands/context';
import { useAppModal } from '../hooks/useAppModal';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, tNumber } from '../i18n';
import { runCommitGate } from '../lib/commit-gate';
import { formatBytes } from '../lib/format-bytes';
import { EDIT_DECLINED } from '../lib/edit-text';
import type { OpMethod } from '../lib/op-edit-class';
import { app } from '../lib/tauri-bridge';
import {
  DEFAULT_INITIAL_VIEW,
  HONORED_ZOOMS,
  PAGE_LAYOUT_VALUES,
  PAGE_MODE_VALUES,
  VIEWER_ONLY_OPTIONS,
  ZOOM_PERCENT_MAX,
  ZOOM_PERCENT_MIN,
  ZOOM_PERCENT_STEPS,
  ZOOM_VALUES,
  initialViewChanges,
  parseInitialView,
  type InitialView,
  type PageLayoutValue,
  type PageModeValue,
  type ViewerOnlyOption,
  type ZoomValue,
} from '../lib/initial-view';
import {
  DEFAULT_ADVANCED,
  TRAPPED_VALUES,
  advancedChanges,
  pageSizeMeasures,
  paperNameOf,
  parseAdvanced,
  type AdvancedProperties,
  type TrappedValue,
} from '../lib/doc-advanced';
import {
  fontStatus,
  fontTestId,
  groupFonts,
  parseDocumentFonts,
  type DocumentFont,
} from '../lib/font-inventory';
import {
  parseImageResolution,
  type ImageResolutionSummary as ImageResolution,
} from '../lib/image-resolution';
import { ImageResolutionSummary } from './ImageResolutionSummary';
import type { PdfBuffer } from '../state/types';
import { suffixedOutputName } from '../lib/output-names';

// File ▸ Properties: metadata, security, the fonts the document uses, its
// initial view, and the file's own facts. Metadata changes retain their
// save-to-a-new-file behavior; the initial-view and advanced writes are
// ordinary undoable in-place edits of THIS document.

const TABS = ['description', 'security', 'fonts', 'initialView', 'advanced'] as const;
type PropTab = (typeof TABS)[number];

const TAB_KEYS = {
  description: 'dialog.props.tab.description',
  security: 'dialog.props.tab.security',
  fonts: 'dialog.props.tab.fonts',
  initialView: 'dialog.props.tab.initialView',
  advanced: 'dialog.props.tab.advanced',
} as const;

const VIEWER_ONLY_LABELS = {
  hide_toolbar: 'dialog.props.iv.hideToolbar',
  hide_menubar: 'dialog.props.iv.hideMenubar',
  hide_window_ui: 'dialog.props.iv.hideWindowUi',
  fit_window: 'dialog.props.iv.fitWindow',
  center_window: 'dialog.props.iv.centerWindow',
  display_doc_title: 'dialog.props.iv.displayDocTitle',
} as const satisfies Record<ViewerOnlyOption, string>;

export interface PropertiesDialogProps {
  onClose: () => void;
}

export function PropertiesDialog({ onClose }: PropertiesDialogProps): React.JSX.Element {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile } = useActiveFile();
  const { call, saveFile } = useEngine();
  const { performOperation } = useOperations();
  const [tab, setTab] = useState<PropTab>('description');

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [subject, setSubject] = useState('');
  const [keywords, setKeywords] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const [version, setVersion] = useState<string | null>(null);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);

  // Initial view, fonts, advanced. Each keeps a BASELINE beside the edited value so a
  // save sends only what moved — every engine parameter is
  // none-means-unchanged, and rewriting an untouched key would churn the file.
  const [view, setView] = useState<InitialView>(DEFAULT_INITIAL_VIEW);
  const [viewBase, setViewBase] = useState<InitialView>(DEFAULT_INITIAL_VIEW);
  const [advanced, setAdvanced] = useState<AdvancedProperties>(DEFAULT_ADVANCED);
  const [advancedBase, setAdvancedBase] = useState<AdvancedProperties>(DEFAULT_ADVANCED);
  const [fonts, setFonts] = useState<DocumentFont[] | null>(null);
  const [fontsError, setFontsError] = useState<string | null>(null);
  const [imageRes, setImageRes] = useState<ImageResolution | null>(null);
  const [imageResError, setImageResError] = useState<string | null>(null);

  // Keyed on workingPath (stable per path, unlike the activeFile object, which
  // swaps on every buffer update) — the MetadataPanel's own note.
  const workingPath = activeFile?.workingPath ?? null;
  const originalPath = activeFile?.path ?? null;

  useEffect(() => {
    if (!workingPath) return;
    let cancelled = false;
    void (async () => {
      // FLUSH FIRST. Every number in this dialog describes the document's
      // BYTES — metadata and version are read out of the working copy, and
      // pageCount/size come from `files`, which only moves on a real byte op.
      // Pending page-tier edits live in `workspace` and touch none of that, so
      // without this a Properties opened right after deleting a page reports
      // the page as still there, disagreeing with the page counter a few pixels
      // away. This is the commit gate's stated job — "before anything READS or
      // replaces file bytes, so these reads are
      // INTERNAL_METHODS (individually ungated: a panel reading on mount must
      // not commit) is exactly why the gate has to be asked for here.
      try {
        await runCommitGate();
      } catch (e: unknown) {
        if (!cancelled) setStatus(tChrome('dialog.props.gateFailed', { message: e instanceof Error ? e.message : String(e) }));
        return;
      }
      if (cancelled) return;
      try {
        const r = await call('get_metadata', { file: workingPath });
        if (cancelled) return;
        setTitle(r.title || '');
        setAuthor(r.author || '');
        setSubject(r.subject || '');
        setKeywords(r.keywords || '');
      } catch (e: unknown) {
        if (!cancelled) setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
      }
      try {
        const v = await call('get_pdf_version', { file: workingPath });
        if (!cancelled) setVersion(v.version);
      } catch {
        if (!cancelled) setVersion(null);
      }
      try {
        const raw = (await call('get_initial_view', { file: workingPath })) as unknown as Record<string, unknown>;
        if (cancelled) return;
        const parsed = parseInitialView(raw);
        setView(parsed);
        setViewBase(parsed);
      } catch {
        if (!cancelled) {
          setView(DEFAULT_INITIAL_VIEW);
          setViewBase(DEFAULT_INITIAL_VIEW);
        }
      }
      try {
        const raw = (await call('get_advanced_properties', { file: workingPath })) as unknown as Record<string, unknown>;
        if (cancelled) return;
        const parsed = parseAdvanced(raw);
        setAdvanced(parsed);
        setAdvancedBase(parsed);
      } catch {
        if (!cancelled) {
          setAdvanced(DEFAULT_ADVANCED);
          setAdvancedBase(DEFAULT_ADVANCED);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [workingPath, call]);

  // The font walk visits every page's resources, every nested form and every
  // appearance stream, so it runs when the tab is first shown rather than on
  // mount — a dialog opened to read the title must not pay for it.
  useEffect(() => {
    if (tab !== 'fonts' || fonts !== null || !workingPath) return;
    let cancelled = false;
    void (async () => {
      try {
        // The vendored fonts directory is what makes the substitution line
        // real; without it the engine reports the substitution as unknown.
        let fontDir: string | null = null;
        try {
          fontDir = await app.getEditFontPath();
        } catch {
          fontDir = null;
        }
        const raw = await call('list_document_fonts', { file: workingPath, font_dir: fontDir });
        if (!cancelled) setFonts(parseDocumentFonts(raw as unknown));
      } catch (e: unknown) {
        if (!cancelled) {
          setFonts([]);
          setFontsError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [tab, fonts, workingPath, call]);

  // The resolution walk parses every page's content stream, so it runs when
  // the Advanced tab is first shown rather than on mount — the font walk's
  // reasoning, for the same cost.
  useEffect(() => {
    if (tab !== 'advanced' || imageRes !== null || imageResError !== null || !workingPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const raw = (await call('summarize_image_resolution', {
          file: workingPath,
        })) as unknown as Record<string, unknown>;
        if (!cancelled) setImageRes(parseImageResolution(raw));
      } catch (e: unknown) {
        if (!cancelled) setImageResError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [tab, imageRes, imageResError, workingPath, call]);

  useEffect(() => {
    if (!originalPath) return;
    let cancelled = false;
    // The ORIGINAL, not the working copy: opening an encrypted file decrypts the
    // working copy, so asking it would always answer "not protected" — a
    // confident, useless lie. What the user wants to know is whether the file on
    // disk needs a password.
    call('check_encrypted', { file: originalPath })
      .then((r) => { if (!cancelled) setEncrypted(Boolean(r.encrypted)); })
      .catch(() => { if (!cancelled) setEncrypted(null); });
    return () => { cancelled = true; };
  }, [originalPath, call]);

  const handleSave = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile(suffixedOutputName(activeFile.name, "metadata"));
    if (!output) return;
    setBusy(true);
    setStatus(tChrome('dialog.props.savingMetadata'));
    try {
      const r = await call('set_metadata', {
        file: activeFile.workingPath, output, title, author, subject, keywords,
      });
      setStatus(tChrome('dialog.props.updated', { fields: (r.updated_fields as string[]).join(', ') }));
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, title, author, subject, keywords, call, saveFile]);

  const handleStrip = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile(suffixedOutputName(activeFile.name, "stripped"));
    if (!output) return;
    setBusy(true);
    setStatus(tChrome('dialog.props.strippingMetadata'));
    try {
      await call('strip_metadata', { file: activeFile.workingPath, output });
      setTitle(''); setAuthor(''); setSubject(''); setKeywords('');
      setStatus(tChrome('dialog.props.stripped'));
    } catch (e: unknown) {
      setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [activeFile, call, saveFile]);

  /** Both catalog writes share one shape: run the op through the undoable
   * in-place flow — which takes the signed-document decision from the op's
   * own edit class (a catalog edit is structural: it coalesces the file and
   * breaks every byte range) — then re-read, so the baseline is what the file
   * now says rather than what was typed. */
  const runCatalogWrite = useCallback(
    async (
      method: OpMethod,
      params: Record<string, unknown>,
      savingKey: 'dialog.props.savingView' | 'dialog.props.savingAdvanced',
    ): Promise<void> => {
      if (!activeFile) return;
      setBusy(true);
      setStatus(tChrome(savingKey));
      try {
        if ((await performOperation(activeFile.path, method, params)) === EDIT_DECLINED) {
          setStatus('');
          return;
        }
        const rawView = (await call('get_initial_view', { file: activeFile.workingPath })) as unknown as Record<string, unknown>;
        const parsedView = parseInitialView(rawView);
        setView(parsedView);
        setViewBase(parsedView);
        const rawAdvanced = (await call('get_advanced_properties', { file: activeFile.workingPath })) as unknown as Record<string, unknown>;
        const parsedAdvanced = parseAdvanced(rawAdvanced);
        setAdvanced(parsedAdvanced);
        setAdvancedBase(parsedAdvanced);
        setStatus(tChrome('dialog.props.saved'));
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(false);
      }
    },
    [activeFile, call, performOperation],
  );

  const viewChanges = initialViewChanges(viewBase, view);
  const advancedDelta = advancedChanges(advancedBase, advanced);

  const handleApplyView = useCallback(() => {
    if (!viewChanges) return;
    void runCatalogWrite('set_initial_view', viewChanges, 'dialog.props.savingView');
  }, [viewChanges, runCatalogWrite]);

  const handleApplyAdvanced = useCallback(() => {
    if (!advancedDelta) return;
    void runCatalogWrite('set_advanced_properties', advancedDelta, 'dialog.props.savingAdvanced');
  }, [advancedDelta, runCatalogWrite]);

  // The command's `when` requires a showable document, so this is unreachable —
  // but the dialog reads `activeFile` on every render, and a file can close
  // underneath an open dialog.
  if (!activeFile) {
    return (
      <Shell onClose={onClose}>
        <p className="text-sm text-neutral-400" data-testid="props-no-file">
          {tChrome('dialog.props.noFile')}
        </p>
      </Shell>
    );
  }

  // `id` is the STABLE testid/DOM handle. It used to be derived from the
  // English label (`props-${label.toLowerCase()}`) — a localization
  // landmine: translating the label would silently rename every test hook
  // and make the DOM depend on the UI language.
  const fields: { id: string; label: string; value: string; set: (v: string) => void }[] = [
    { id: 'title', label: tChrome('dialog.props.field.title'), value: title, set: setTitle },
    { id: 'author', label: tChrome('dialog.props.field.author'), value: author, set: setAuthor },
    { id: 'subject', label: tChrome('dialog.props.field.subject'), value: subject, set: setSubject },
    { id: 'keywords', label: tChrome('dialog.props.field.keywords'), value: keywords, set: setKeywords },
  ];

  return (
    <Shell onClose={onClose}>
      <nav className="prefs-nav" aria-label={tChrome('dialog.props.tabsAria')}>
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            data-testid={`props-tab-${t}`}
            aria-pressed={tab === t}
            className={'prefs-cat' + (tab === t ? ' active' : '')}
            onClick={() => setTab(t)}
          >
            {tChrome(TAB_KEYS[t])}
          </button>
        ))}
      </nav>

      <div className="prefs-body flex flex-col gap-4" data-testid={`props-body-${tab}`}>
        {tab === 'description' && (
          <>
            {fields.map((f) => (
              <div key={f.id}>
                <label className="block text-sm text-neutral-400 mb-1">{f.label}</label>
                <input
                  data-testid={`props-${f.id}`}
                  aria-label={f.label}
                  className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                  value={f.value}
                  onChange={(e) => f.set(e.target.value)}
                />
              </div>
            ))}
            <div className="flex gap-2">
              <button
                data-testid="props-save"
                disabled={busy}
                onClick={() => void handleSave()}
                className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded font-medium"
              >
                {tChrome('dialog.props.saveAs')}
              </button>
              <button
                data-testid="props-strip"
                disabled={busy}
                onClick={() => void handleStrip()}
                className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 disabled:opacity-60 rounded font-medium"
              >
                {tChrome('dialog.props.removeAll')}
              </button>
            </div>
          </>
        )}

        {tab === 'security' && (
          <>
            <Row label={tChrome('dialog.props.passwordProtection')}>
              <span data-testid="props-encrypted">
                {encrypted === null
                  ? tChrome('dialog.props.unknown')
                  : encrypted
                    ? tChrome('dialog.props.needsPassword')
                    : tChrome('dialog.props.noProtection')}
              </span>
            </Row>
            <button
              data-testid="props-protect"
              onClick={() => {
                onClose();
                invokeCommand('tools.open.protect');
              }}
              className="self-start px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
            >
              {tChrome('dialog.props.openProtect')}
            </button>
          </>
        )}

        {tab === 'fonts' && (
          <FontsTab fonts={fonts} error={fontsError} />
        )}

        {tab === 'initialView' && (
          <InitialViewTab
            view={view}
            pages={activeFile.pageCount}
            busy={busy}
            dirty={viewChanges !== null}
            onChange={setView}
            onApply={handleApplyView}
          />
        )}

        {tab === 'advanced' && (
          <>
            <Row label={tChrome('dialog.props.pdfVersion')}>
              <span data-testid="props-version">
                {version
                  ? tChrome('dialog.props.versionValue', { version })
                  : tChrome('dialog.props.unknown')}
              </span>
            </Row>
            <Row label={tChrome('dialog.props.fastWebView')}>
              <span data-testid="props-linearized">
                {tChrome(advanced.linearized ? 'dialog.props.yes' : 'dialog.props.no')}
              </span>
            </Row>
            <Row label={tChrome('dialog.props.tagged')}>
              <span data-testid="props-tagged">
                {tChrome(advanced.tagged ? 'dialog.props.yes' : 'dialog.props.no')}
              </span>
            </Row>
            <Row label={tChrome('dialog.props.pageCount')}>
              <span data-testid="props-pages">{tNumber(activeFile.pageCount)}</span>
            </Row>
            <Row label={tChrome('dialog.props.pageSizes')}>
              <span data-testid="props-page-sizes" className="block">
                {advanced.page_sizes.length === 0
                  ? tChrome('dialog.props.unknown')
                  : advanced.page_sizes.map((size) => (
                      <span key={`${size.width}x${size.height}`} className="block">
                        {describePageSize(size.width, size.height, size.count)}
                      </span>
                    ))}
              </span>
            </Row>
            <Row label={tChrome('imageres.title')}>
              <span data-testid="props-images" className="block">
                <ImageResolutionSummary
                  summary={imageRes}
                  loading={imageRes === null && imageResError === null}
                  error={imageResError}
                  testIdPrefix="props-images"
                />
              </span>
            </Row>
            <Row label={tChrome('dialog.props.size')}>
              {/* The working copy's bytes — the document as it currently stands,
                  which is what the rest of this dialog describes too. */}
              <span data-testid="props-size">{formatBytes(byteLengthOf(activeFile.buffer))}</span>
            </Row>
            <Row label={tChrome('dialog.props.location')}>
              <span className="break-all ltr-notation" data-testid="props-path">
                {activeFile.path}
              </span>
            </Row>
            <Row label={tChrome('dialog.props.openAction')}>
              <span data-testid="props-open-action">
                {tChrome(advanced.has_open_action ? 'dialog.props.present' : 'dialog.props.absent')}
              </span>
            </Row>
            <Row label={tChrome('dialog.props.searchIndex')}>
              <span data-testid="props-search-index" className="break-all ltr-notation">
                {advanced.search_index ?? tChrome('dialog.props.noneRecorded')}
              </span>
            </Row>

            <div>
              <label className="block text-sm text-neutral-400 mb-1" htmlFor="props-trapped">
                {tChrome('dialog.props.trapped')}
              </label>
              <select
                id="props-trapped"
                data-testid="props-trapped"
                disabled={busy}
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
                value={advanced.trapped}
                onChange={(e) =>
                  setAdvanced((prev) => ({ ...prev, trapped: e.target.value as TrappedValue }))
                }
              >
                {TRAPPED_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {tChrome(`dialog.props.trapped.${value}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-neutral-400 mb-1" htmlFor="props-base-url">
                {tChrome('dialog.props.baseUrl')}
              </label>
              <input
                id="props-base-url"
                data-testid="props-base-url"
                disabled={busy}
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm ltr-notation"
                value={advanced.base_url}
                onChange={(e) => setAdvanced((prev) => ({ ...prev, base_url: e.target.value }))}
              />
              <p className="mt-1 text-xs text-neutral-500">{tChrome('dialog.props.baseUrlHint')}</p>
            </div>
            <button
              data-testid="props-advanced-apply"
              disabled={busy || advancedDelta === null}
              onClick={handleApplyAdvanced}
              className="self-start px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded font-medium"
            >
              {tChrome('dialog.props.apply')}
            </button>
          </>
        )}

        {status && <p className="text-xs text-neutral-500" data-testid="props-status">{status}</p>}
      </div>
    </Shell>
  );
}

function describePageSize(width: number, height: number, count: number): string {
  const measures = pageSizeMeasures(width, height);
  const paper = paperNameOf(width, height);
  const size = tChrome('dialog.props.pageSizeValue', {
    inchesW: tNumber(measures.inches.w),
    inchesH: tNumber(measures.inches.h),
    mmW: tNumber(measures.millimetres.w),
    mmH: tNumber(measures.millimetres.h),
  });
  const named = paper ? tChrome('dialog.props.pageSizeNamed', { paper, size }) : size;
  return tChromeCount('dialog.props.pageSizeRow', count, { size: named });
}

function FontsTab({
  fonts,
  error,
}: {
  fonts: DocumentFont[] | null;
  error: string | null;
}): React.JSX.Element {
  if (error) {
    return (
      <p className="text-sm text-red-400" data-testid="props-fonts-error">
        {tChrome('panel.common.error', { message: error })}
      </p>
    );
  }
  if (fonts === null) {
    return (
      <p className="text-sm text-neutral-400" data-testid="props-fonts-loading">
        {tChrome('dialog.props.fontsLoading')}
      </p>
    );
  }
  if (fonts.length === 0) {
    return (
      <p className="text-sm text-neutral-400" data-testid="props-fonts-empty">
        {tChrome('dialog.props.fontsEmpty')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="props-fonts">
      {groupFonts(fonts).map((group) => (
        <div key={group.type}>
          <h4 className="text-xs uppercase tracking-wide text-neutral-500 mb-1">{group.type}</h4>
          <ul className="flex flex-col gap-2">
            {group.fonts.map((font) => (
              <li
                key={`${font.raw_name}|${font.encoding}|${String(font.embedded)}`}
                data-testid={`props-font-${fontTestId(font)}`}
                className="rounded border border-neutral-800 bg-neutral-900/50 px-3 py-2"
              >
                <div className="text-sm text-neutral-200">
                  {font.name || tChrome('dialog.props.fontUnnamed')}
                </div>
                <div className="text-xs text-neutral-500">
                  {tChrome('dialog.props.fontDetail', {
                    type: font.type,
                    encoding: font.encoding,
                  })}
                </div>
                <div className="text-xs text-neutral-500">
                  {tChromeCount('dialog.props.fontPages', font.page_count)}
                </div>
                <div className="text-xs text-neutral-400">{fontStatusText(font)}</div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function fontStatusText(font: DocumentFont): string {
  const state = fontStatus(font);
  switch (state.kind) {
    case 'embedded-subset':
      return tChrome('dialog.props.fontEmbeddedSubset');
    case 'embedded':
      return tChrome('dialog.props.fontEmbedded');
    case 'embedding-unknown':
      return tChrome('dialog.props.fontEmbeddingUnknown');
    case 'substituted':
      return tChrome('dialog.props.fontSubstituted', { face: state.face });
    default:
      return tChrome('dialog.props.fontNotEmbedded');
  }
}

function InitialViewTab({
  view,
  pages,
  busy,
  dirty,
  onChange,
  onApply,
}: {
  view: InitialView;
  pages: number;
  busy: boolean;
  dirty: boolean;
  onChange: (next: InitialView) => void;
  onApply: () => void;
}): React.JSX.Element {
  const patch = (delta: Partial<InitialView>): void => onChange({ ...view, ...delta });
  const zoomHonored = HONORED_ZOOMS.includes(view.zoom);
  return (
    <>
      <div>
        <label className="block text-sm text-neutral-400 mb-1" htmlFor="props-iv-layout">
          {tChrome('dialog.props.iv.pageLayout')}
        </label>
        <select
          id="props-iv-layout"
          data-testid="props-iv-layout"
          disabled={busy}
          className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
          value={view.page_layout}
          onChange={(e) => patch({ page_layout: e.target.value as PageLayoutValue })}
        >
          {PAGE_LAYOUT_VALUES.map((value) => (
            <option key={value} value={value}>
              {tChrome(`dialog.props.iv.layout.${value}`)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm text-neutral-400 mb-1" htmlFor="props-iv-mode">
          {tChrome('dialog.props.iv.pageMode')}
        </label>
        <select
          id="props-iv-mode"
          data-testid="props-iv-mode"
          disabled={busy}
          className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
          value={view.page_mode}
          onChange={(e) => patch({ page_mode: e.target.value as PageModeValue })}
        >
          {PAGE_MODE_VALUES.map((value) => (
            <option key={value} value={value}>
              {tChrome(`dialog.props.iv.mode.${value}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex gap-3">
        <div className="w-32">
          <label className="block text-sm text-neutral-400 mb-1" htmlFor="props-iv-page">
            {tChrome('dialog.props.iv.openPage')}
          </label>
          <input
            id="props-iv-page"
            data-testid="props-iv-page"
            type="number"
            min={1}
            max={Math.max(1, pages)}
            disabled={busy}
            className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
            value={view.open_page ?? ''}
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (raw === '') {
                patch({ open_page: null });
                return;
              }
              const parsed = Number.parseInt(raw, 10);
              if (!Number.isFinite(parsed)) return;
              patch({ open_page: Math.min(Math.max(1, parsed), Math.max(1, pages)) });
            }}
          />
        </div>
        <div className="flex-1">
          <label className="block text-sm text-neutral-400 mb-1" htmlFor="props-iv-zoom">
            {tChrome('dialog.props.iv.magnification')}
          </label>
          <select
            id="props-iv-zoom"
            data-testid="props-iv-zoom"
            disabled={busy || view.open_page === null}
            className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
            value={view.zoom}
            onChange={(e) => {
              const zoom = e.target.value as ZoomValue;
              patch({ zoom, zoom_percent: zoom === 'percent' ? (view.zoom_percent ?? 100) : view.zoom_percent });
            }}
          >
            {ZOOM_VALUES.map((value) => (
              <option key={value} value={value}>
                {tChrome(`dialog.props.iv.zoom.${value}`)}
              </option>
            ))}
          </select>
        </div>
        {view.zoom === 'percent' && (
          <div className="w-28">
            <label className="block text-sm text-neutral-400 mb-1" htmlFor="props-iv-zoom-percent">
              {tChrome('dialog.props.iv.percent')}
            </label>
            <input
              id="props-iv-zoom-percent"
              data-testid="props-iv-zoom-percent"
              type="number"
              list="props-iv-zoom-steps"
              min={ZOOM_PERCENT_MIN}
              max={ZOOM_PERCENT_MAX}
              disabled={busy}
              className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
              value={view.zoom_percent ?? 100}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                patch({
                  zoom_percent: Math.min(Math.max(ZOOM_PERCENT_MIN, parsed), ZOOM_PERCENT_MAX),
                });
              }}
            />
            <datalist id="props-iv-zoom-steps">
              {ZOOM_PERCENT_STEPS.map((step) => (
                <option key={step} value={step} />
              ))}
            </datalist>
          </div>
        )}
      </div>

      {view.open_page !== null && !zoomHonored && (
        <p className="text-xs text-neutral-500" data-testid="props-iv-zoom-note">
          {tChrome('dialog.props.iv.zoomViewerOnly')}
        </p>
      )}
      {!view.open_action_replaceable && (
        <p className="text-xs text-amber-400" data-testid="props-iv-open-action-note">
          {tChrome('dialog.props.iv.openActionScript')}
        </p>
      )}

      <div>
        <label className="block text-sm text-neutral-400 mb-1" htmlFor="props-iv-direction">
          {tChrome('dialog.props.iv.direction')}
        </label>
        <select
          id="props-iv-direction"
          data-testid="props-iv-direction"
          disabled={busy}
          className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
          value={view.direction}
          onChange={(e) => patch({ direction: e.target.value === 'R2L' ? 'R2L' : 'L2R' })}
        >
          <option value="L2R">{tChrome('dialog.props.iv.directionL2R')}</option>
          <option value="R2L">{tChrome('dialog.props.iv.directionR2L')}</option>
        </select>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm text-neutral-400 mb-1">
          {tChrome('dialog.props.iv.windowOptions')}
        </legend>
        {VIEWER_ONLY_OPTIONS.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              data-testid={`props-iv-${option.replace(/_/g, '-')}`}
              disabled={busy}
              checked={view[option]}
              onChange={(e) => patch({ [option]: e.target.checked } as Partial<InitialView>)}
            />
            {tChrome(VIEWER_ONLY_LABELS[option])}
          </label>
        ))}
        <p className="text-xs text-neutral-500">{tChrome('dialog.props.iv.windowOptionsNote')}</p>
      </fieldset>

      <button
        data-testid="props-iv-apply"
        disabled={busy || !dirty}
        onClick={onApply}
        className="self-start px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded font-medium"
      >
        {tChrome('dialog.props.apply')}
      </button>
    </>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }): React.JSX.Element {
  // Escape-closes / focus-trap / focus-restore — the shared dialog contract.
  const shellRef = useAppModal(onClose);
  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('dialog.props.title')}
        data-testid="properties-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[640px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome('dialog.props.title')}</h3>
          <button
            data-testid="props-close"
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-sm"
          >
            {tChrome('dialog.common.close')}
          </button>
        </div>
        <div className="p-5 prefs">{children}</div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <span className="block text-sm text-neutral-400 mb-1">{label}</span>
      <span className="text-sm text-neutral-200">{children}</span>
    </div>
  );
}

/** `PdfBuffer` is one of three shapes (and may be absent while a file loads),
 * so the byte count needs asking properly rather than `.length` — which is
 * undefined on an ArrayBuffer and would have rendered "undefined bytes". */
function byteLengthOf(buffer: PdfBuffer | null): number | null {
  if (!buffer) return null;
  if (Array.isArray(buffer)) return buffer.length;
  return buffer.byteLength;
}
