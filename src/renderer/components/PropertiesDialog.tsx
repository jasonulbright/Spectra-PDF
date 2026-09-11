import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { invokeCommand } from '../commands/context';
import { useAppModal } from '../hooks/useAppModal';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, tNumber } from '../i18n';
import { runCommitGate } from '../lib/commit-gate';
import { formatBytes } from '../lib/format-bytes';
import { useReadAppState } from '../state/AppStateProvider';
import { createPropertiesDrafts } from '../lib/properties-drafts';
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
  useTranslation();
  const { activeFile } = useActiveFile();
  const readState = useReadAppState();
  const { call, saveFile } = useEngine();
  const { performOperation } = useOperations();
  const drafts = useMemo(() => createPropertiesDrafts(readState), [readState]);
  useSyncExternalStore(drafts.subscribe, drafts.snapshot, drafts.snapshot);
  const d = drafts.get(activeFile);
  const [tab, setTab] = useState<PropTab>('description');
  const workingPath = activeFile?.workingPath ?? null;
  const originalPath = activeFile?.path ?? null;
  const buffer = activeFile?.buffer ?? null;
  const current = d !== null && drafts.at(d) && !readState().pageDirtyPaths.includes(d.path);
  const view = d?.view.draft ?? DEFAULT_INITIAL_VIEW;
  const advanced = d?.advanced.draft ?? DEFAULT_ADVANCED;
  const viewKnown = !!d && current && d.view.fresh;
  const advancedKnown = !!d && current && d.advanced.fresh;
  const metadataKnown = !!d && drafts.editable(d, d.metadata);
  const busy = d?.busy ?? false;
  const version = advancedKnown ? advanced.version : null;
  const status = d && drafts.conflict(d) ? tChrome('app.history.changed') : d?.status ?? '';
  const title = d?.metadata.draft.title ?? '';
  const author = d?.metadata.draft.author ?? '';
  const subject = d?.metadata.draft.subject ?? '';
  const keywords = d?.metadata.draft.keywords ?? '';
  const setMetadata = (key: 'title' | 'author' | 'subject' | 'keywords', value: string) => {
    if (d) drafts.change(d, d.metadata, { ...d.metadata.draft, [key]: value });
  };
  const setTitle = (v: string) => setMetadata('title', v);
  const setAuthor = (v: string) => setMetadata('author', v);
  const setSubject = (v: string) => setMetadata('subject', v);
  const setKeywords = (v: string) => setMetadata('keywords', v);
  const setView = (next: InitialView) => { if (d) drafts.change(d, d.view, next); };
  const setAdvanced = (edit: (prior: AdvancedProperties) => AdvancedProperties) => {
    if (d) drafts.change(d, d.advanced, edit(d.advanced.draft));
  };
  const viewChanges = d?.view.baseline && viewKnown ? initialViewChanges(d.view.baseline, view) : null;
  const advancedDelta = d?.advanced.baseline && advancedKnown ? advancedChanges(d.advanced.baseline, advanced) : null;

  useEffect(() => { drafts.activate(); return () => drafts.deactivate(); }, [drafts]);

  useEffect(() => {
    if (!d) return;
    void drafts.load(d, call, runCommitGate);
    return () => drafts.cancelLoad(d);
  }, [d, buffer, drafts, call]);

  // Expensive facts belong to an exact revision, not just a stable working
  // pathname. Old values disappear in render before an effect can run.
  type FontRead = { workingPath: string; buffer: PdfBuffer; value: DocumentFont[] | null; error: string | null };
  type ImageRead = { workingPath: string; buffer: PdfBuffer; value: ImageResolution | null; error: string | null };
  const [fontRead, setFontRead] = useState<FontRead | null>(null);
  const [imageRead, setImageRead] = useState<ImageRead | null>(null);
  const [security, setSecurity] = useState<{ path: string; buffer: PdfBuffer; value: boolean | null } | null>(null);
  const fontsOwn = fontRead?.workingPath === workingPath && fontRead?.buffer === buffer && current;
  const imagesOwn = imageRead?.workingPath === workingPath && imageRead?.buffer === buffer && current;
  const fonts = fontsOwn ? fontRead!.value : null;
  const fontsError = fontsOwn ? fontRead!.error : null;
  const imageRes = imagesOwn ? imageRead!.value : null;
  const imageResError = imagesOwn ? imageRead!.error : null;
  const encrypted = security?.path === originalPath && security?.buffer === buffer ? security.value : null;
  const owns = useCallback(() => !!d && !!buffer && drafts.at(d, buffer)
    && !readState().pageDirtyPaths.includes(d.path), [d, buffer, drafts, readState]);

  useEffect(() => {
    if (tab !== 'fonts' || !d || !buffer || !workingPath || !current) return;
    let cancelled = false;
    const valid = () => !cancelled && owns();
    const assertCurrent = () => { if (!valid()) throw new Error(tChrome('app.history.changed')); };
    void (async () => {
      try {
        let fontDir: string | null = null;
        try { fontDir = await app.getEditFontPath(); } catch { /* Substitution stays unknown. */ }
        assertCurrent();
        const raw = await call('list_document_fonts', { file: workingPath, font_dir: fontDir }, { assertCurrent });
        if (valid()) setFontRead({ workingPath, buffer, value: parseDocumentFonts(raw), error: null });
      } catch (e) {
        if (valid()) setFontRead({ workingPath, buffer, value: null, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [tab, d, buffer, workingPath, current, owns, call]);

  useEffect(() => {
    if (tab !== 'advanced' || !d || !buffer || !workingPath || !current) return;
    let cancelled = false;
    const valid = () => !cancelled && owns();
    const assertCurrent = () => { if (!valid()) throw new Error(tChrome('app.history.changed')); };
    void (async () => {
      try {
        const raw = await call('summarize_image_resolution', { file: workingPath }, { assertCurrent });
        if (valid()) setImageRead({ workingPath, buffer, value: parseImageResolution(raw as unknown as Record<string, unknown>), error: null });
      } catch (e) {
        if (valid()) setImageRead({ workingPath, buffer, value: null, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [tab, d, buffer, workingPath, current, owns, call]);

  useEffect(() => {
    if (!originalPath || !buffer) return;
    let cancelled = false;
    // Protection is a fact about the original; the working copy is decrypted.
    const assertCurrent = () => { if (cancelled || !owns()) throw new Error(tChrome('app.history.changed')); };
    void call('check_encrypted', { file: originalPath }, { assertCurrent }).then(r => {
      if (!cancelled && owns()) setSecurity({ path: originalPath, buffer, value: typeof r.encrypted === 'boolean' ? r.encrypted : null });
    }).catch(() => {
      if (!cancelled && owns()) setSecurity({ path: originalPath, buffer, value: null });
    });
    return () => { cancelled = true; };
  }, [originalPath, buffer, owns, call]);

  const handleSave = async () => {
    if (d && activeFile) await drafts.exportMetadata(d, false,
      () => saveFile(suffixedOutputName(activeFile.name, 'metadata')), call);
  };
  const handleStrip = async () => {
    if (d && activeFile) await drafts.exportMetadata(d, true,
      () => saveFile(suffixedOutputName(activeFile.name, 'stripped')), call);
  };
  const handleApplyView = () => { if (d) void drafts.apply(d, 'view', performOperation, call); };
  const handleApplyAdvanced = () => { if (d) void drafts.apply(d, 'advanced', performOperation, call); };

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
                  disabled={!metadataKnown}
                  onChange={(e) => f.set(e.target.value)}
                />
              </div>
            ))}
            <div className="flex gap-2">
              <button
                data-testid="props-save"
                disabled={busy || !metadataKnown}
                onClick={() => void handleSave()}
                className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded font-medium"
              >
                {tChrome('dialog.props.saveAs')}
              </button>
              <button
                data-testid="props-strip"
                disabled={busy || !metadataKnown}
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

        {tab === 'initialView' && !d?.view.baseline && (
          <p data-testid="props-view-unknown">{tChrome('dialog.props.unknown')}</p>
        )}
        {tab === 'initialView' && d?.view.baseline && (
          <InitialViewTab
            view={view}
            pages={activeFile.pageCount}
            busy={busy || !viewKnown}
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
                {tChrome(!advancedKnown ? 'dialog.props.unknown' : advanced.linearized ? 'dialog.props.yes' : 'dialog.props.no')}
              </span>
            </Row>
            <Row label={tChrome('dialog.props.tagged')}>
              <span data-testid="props-tagged">
                {tChrome(!advancedKnown ? 'dialog.props.unknown' : advanced.tagged ? 'dialog.props.yes' : 'dialog.props.no')}
              </span>
            </Row>
            <Row label={tChrome('dialog.props.pageCount')}>
              <span data-testid="props-pages">{tNumber(activeFile.pageCount)}</span>
            </Row>
            <Row label={tChrome('dialog.props.pageSizes')}>
              <span data-testid="props-page-sizes" className="block">
                {!advancedKnown || advanced.page_sizes.length === 0
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
                {tChrome(!advancedKnown ? 'dialog.props.unknown' : advanced.has_open_action ? 'dialog.props.present' : 'dialog.props.absent')}
              </span>
            </Row>
            <Row label={tChrome('dialog.props.searchIndex')}>
              <span data-testid="props-search-index" className="break-all ltr-notation">
                {!advancedKnown ? tChrome('dialog.props.unknown') : advanced.search_index ?? tChrome('dialog.props.noneRecorded')}
              </span>
            </Row>

            <div>
              <label className="block text-sm text-neutral-400 mb-1" htmlFor="props-trapped">
                {tChrome('dialog.props.trapped')}
              </label>
              <select
                id="props-trapped"
                data-testid="props-trapped"
                disabled={busy || !advancedKnown}
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
                disabled={busy || !advancedKnown}
                className="w-full px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm ltr-notation"
                value={advanced.base_url}
                onChange={(e) => setAdvanced((prev) => ({ ...prev, base_url: e.target.value }))}
              />
              <p className="mt-1 text-xs text-neutral-500">{tChrome('dialog.props.baseUrlHint')}</p>
            </div>
            <button
              data-testid="props-advanced-apply"
              disabled={busy || !advancedKnown || advancedDelta === null}
              onClick={handleApplyAdvanced}
              className="self-start px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-60 rounded font-medium"
            >
              {tChrome('dialog.props.apply')}
            </button>
          </>
        )}

        {d && (d.metadata.error || d.view.error || d.advanced.error) && (
          <p className="text-xs text-red-400" data-testid="props-read-error">
            {tChrome('dialog.props.unknown')}: {d.metadata.error || d.view.error || d.advanced.error}
          </p>
        )}
        {status && <p className="text-xs text-neutral-500" data-testid="props-status">{status}</p>}
        {d && (drafts.conflict(d) || d.metadata.error || d.view.error || d.advanced.error) && (
          <button data-testid="props-reload" disabled={busy} onClick={() => {
            drafts.reload(d); void drafts.load(d, call, runCommitGate);
          }}>{tChrome('dialog.props.reload')}</button>
        )}
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
              patch({ zoom, zoom_percent: zoom === 'percent' ? (view.zoom_percent ?? 100) : null });
            }}
          >
            {ZOOM_VALUES.filter(value => value !== 'custom' || view.zoom === 'custom').map((value) => (
              <option key={value} value={value} disabled={value === 'custom'}>
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
