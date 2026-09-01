import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { AppStateProvider, useAppState, useAppDispatch } from './state/AppStateProvider';
import { file, app, dialog, batch, tabDrag } from './lib/tauri-bridge';
import type { PhysicalScreenPoint, TabDragReservation, TabDragResult } from './lib/tauri-bridge';
import { flushTabOrder, planHandOff, reservationHolds, tabMoved } from './lib/tab-drag';
import {
  decodeToRawSource,
  engineWantsRawFallback,
  isJpegPath,
  isSvgPath,
  jpegExifOrientation,
  type AddImageSource,
  type ReplacementSource,
} from './lib/image-replace';
import { EDIT_DECLINED } from './lib/edit-text';
import {
  lockNeedsFields,
  signedEditDecision,
  type EditClass,
  type FieldLock,
  type SignaturePolicy,
  type SignedEditDecision,
} from './lib/signatures';
import type { LinkSpec } from './lib/links';
import { toEngineFormat } from './lib/af-emit';
import {
  toEngineAction,
  type AuthoredAction,
  type SubmitFormat,
  type WidgetAction,
} from './lib/field-actions';
import {
  SUBMIT_EXTENSION as SUBMIT_PAYLOAD_EXTENSION,
  destinationRefusal,
  payloadPreview,
  responseRoute,
  statusAccepted,
  submitRequest,
  type PayloadPreview,
} from './lib/form-submit';
import {
  SubmitConsentDialog,
  type SubmitConsentAnswer,
} from './components/SubmitConsentDialog';
import type { FieldActions } from './lib/form-candidates';
import type { EditImageMaskParam } from './lib/edit-images';
import type { ParagraphEditOpts } from './lib/edit-paragraphs';
import { ConfirmDialog, ConfirmResult } from './components/ConfirmDialog';
import { PasswordDialog, PasswordResult } from './components/PasswordDialog';
import { CertUnlockDialog, CertUnlockResult } from './components/CertUnlockDialog';
import { SplitPanel } from './panels/SplitPanel';
import { RotatePanel } from './panels/RotatePanel';
import { DeletePanel } from './panels/DeletePanel';
import { CompressPanel } from './panels/CompressPanel';
import { PdfaPanel } from './panels/PdfaPanel';
import { EncryptPanel } from './panels/EncryptPanel';
import { DecryptPanel } from './panels/DecryptPanel';
import { ExtractTextPanel } from './panels/ExtractTextPanel';
import { RepairPanel } from './panels/RepairPanel';
import { RebuildPanel } from './panels/RebuildPanel';
import { RecoverPanel } from './panels/RecoverPanel';
import { GrayscalePanel } from './panels/GrayscalePanel';
import { OptimizePanel } from './panels/OptimizePanel';
import { PdfVersionPanel } from './panels/PdfVersionPanel';
import { WatermarkPanel } from './panels/WatermarkPanel';
import { HeaderFooterPanel } from './panels/HeaderFooterPanel';
import { PageBoxesPanel } from './panels/PageBoxesPanel';
import { PageLabelsPanel } from './panels/PageLabelsPanel';
import { AttachmentsPanel } from './panels/AttachmentsPanel';
import { PortfolioPanel, PortfolioAutoOpen } from './panels/PortfolioPanel';
import { GuidedActionsPanel } from './panels/GuidedActionsPanel';
import { TakeoffPanel } from './panels/TakeoffPanel';
import { SearchRedactPanel } from './panels/SearchRedactPanel';
import { SanitizePanel } from './panels/SanitizePanel';
import { PrepareFormPanel } from './panels/PrepareFormPanel';
import { TableReviewPanel } from './panels/TableReviewPanel';
import { ScanEnhancePanel } from './panels/ScanEnhancePanel';
import { SpellingPanel } from './panels/SpellingPanel';
import { LayersPanel } from './panels/LayersPanel';
import { AccessibilityPanel } from './panels/AccessibilityPanel';
import { CommentsPanel } from './panels/CommentsPanel';
import { PreflightPanel } from './panels/PreflightPanel';
import { LinksPanel } from './panels/LinksPanel';
import { TagsPanel } from './panels/TagsPanel';
import { ReadingOrderPanel } from './panels/ReadingOrderPanel';
import { FormsPanel } from './panels/FormsPanel';
import { ComparePanel } from './panels/ComparePanel';
import { SignaturesPanel } from './panels/SignaturesPanel';
import { DocumentJsPanel } from './panels/DocumentJsPanel';
import { PrepressPanel } from './panels/PrepressPanel';
import { useEngine } from './hooks/useEngine';
import { useWorkspaceIndexer } from './hooks/useWorkspaceIndexer';
import { indexOpenFile } from './lib/workspace';
import type { PageRef, PdfBuffer } from './state/types';
import { isDocTab, viewOf } from './state/types';
import { showableDoc, showableDocuments, tabFiles } from './state/selectors';
import type { CanvasTool } from './state/types';
import { WorkspaceCanvasView } from './components/canvas/WorkspaceCanvasView';
import { PresentationView } from './components/canvas/PresentationView';
import { usePdfProxies } from './hooks/usePdfProxies';
import type { CanvasDropResolver } from './components/canvas/WorkspaceCanvasView';
import { commitPageEdits } from './lib/workspace-commit';
import { pageEditDecision, type PageDelta } from './lib/page-edit-gate';
import { opEditClass, type OpMethod } from './lib/op-edit-class';
import type { PreserveOutcome, PreserveRefusal } from './lib/preserve-reason';
import { sealBeforeClose } from './lib/close-sequence';
import { setCommitGate, runCommitGate } from './lib/commit-gate';
import { initialViewPlan, parseInitialView, planIsInert } from './lib/initial-view';
import { readFormFields } from './lib/forms';
import type { FormFieldValue } from './lib/forms';
import { fillClosure, formCalculation, resolveFillTargets } from './lib/form-overlay';
import { classifyFillResult } from './lib/fill-result';
import { addFormFields } from './lib/form-authoring';
import type { NewFieldSpec } from './lib/form-authoring';
import { choiceAppearanceFields, verticalFontCalls } from './lib/form-writing';
import { DropZone } from './components/DropZone';
import { OperationsProvider, type PerformOperation } from './hooks/useOperations';
import { OperationQueue } from './components/OperationQueue';
import { QueueProvider, useOperationQueue } from './hooks/useOperationQueue';
import { SearchProvider } from './search/SearchProvider';
import { SeparationPreviewProvider } from './hooks/useSeparationPreview';
import { FlattenerPreviewProvider } from './hooks/useFlattenerPreview';
import { OutputPreviewPanel } from './panels/OutputPreviewPanel';
import { InkManagerPanel } from './panels/InkManagerPanel';
import { PrinterMarksPanel } from './panels/PrinterMarksPanel';
import { HairlinesPanel } from './panels/HairlinesPanel';
import { FlattenerPanel } from './panels/FlattenerPanel';
import { TrapPresetsPanel } from './panels/TrapPresetsPanel';
import { SettingsPanel, getSettings, type PrefCategory } from './panels/SettingsPanel';
import {
  ensureGsCapability,
  gsPathIfAvailable,
  registerGsSetupOpener,
  requireGsPath,
  takeGsLaunchPrompt,
} from './lib/gs-capability';
import { GsMissingDialog } from './components/GsMissingDialog';
import { isPrimaryWindow } from './lib/window-label';
import { MenuBar } from './components/MenuBar';
import { MainToolbar } from './components/MainToolbar';
import { TabStrip } from './components/TabStrip';
import { HomeTab } from './components/HomeTab';
import { AboutDialog } from './components/AboutDialog';
import { IccLicenseDialog } from './components/IccLicenseDialog';
import { ensureIccAssent, iccNeedsAssent, registerIccLicenseOpener } from './lib/icc-assent';
import { CustomizeToolbarDialog } from './components/CustomizeToolbarDialog';
import { persistToolbarOverrides } from './lib/toolbar-layout';
import { PropertiesDialog } from './components/PropertiesDialog';
import { PrintDialog } from './components/PrintDialog';
import { BatchOcrDialog } from './components/BatchOcrDialog';
import { DiskRedactDialog } from './components/DiskRedactDialog';
import { FolderFormPrepDialog } from './components/FolderFormPrepDialog';
import { FolderExportDialog } from './components/FolderExportDialog';
import { FolderPreflightDialog } from './components/FolderPreflightDialog';
import { FolderCreatePdfDialog } from './components/FolderCreatePdfDialog';
import { ScanDialog } from './components/ScanDialog';
import { ScheduledRunsDialog } from './components/ScheduledRunsDialog';
import { WatchedFoldersDialog } from './components/WatchedFoldersDialog';
import { CreatePdfDialog } from './components/CreatePdfDialog';
import { CombineDialog } from './components/CombineDialog';
import { OpenFromWebDialog, type OpenFromWebResult } from './components/OpenFromWebDialog';
import { saveRouteFor } from './lib/web-open';
import { classify as classifySource } from './lib/create-pdf';
import type { CombineDestination } from './lib/combine';
import { ExportImagesDialog } from './components/ExportImagesDialog';
import { ExportDocumentDialog, type DocumentExportFormat } from './components/ExportDocumentDialog';
import { buildBlankPagePdf } from './lib/blank-page';
import { insertAnchor } from './state/selectors';
import { UpdateBar } from './components/UpdateBar';
import { NavPane } from './components/navpane/NavPane';
import { ToolDock } from './components/ToolDock';
import { type Operation } from './commands/operations';
import { persistRecent, sameRecent, withRecent } from './lib/recent-files';
import { claimPaths, releasePaths, soleOwner, type ClaimRefusal } from './lib/window-claims';
import { writeWorkbenchUi } from './lib/workbench-ui';
import { installTestHarness, TEST_HARNESS_ENABLED } from './testHarness';
import type { TestStateSnapshot } from './testHarness';
import {
  getCanvasServices,
  pushEscapeInterceptor,
  invokeCommand,
  registerAppCommandHandlers,
  setCommandStateSource,
} from './commands/context';
import { useKeymapDispatcher } from './commands/keymap';
import { useAppModal } from './hooks/useAppModal';
import type { AppCommandHandlers } from './commands/types';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, tNumber } from './i18n';
import {
  summarizeOpenOutcomes,
  translateOpenFailure,
  type OpenOutcome,
  type OpenSummary,
} from './lib/open-failure';
import type { SanitizeRequest } from './lib/sanitize-report';

// The Preferences shell — a component (not inline JSX) so it can carry the
// shared dialog keyboard/focus contract (useAppModal).
function PreferencesModal({
  category,
  onClose,
}: {
  category: PrefCategory;
  onClose: () => void;
}): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const shellRef = useAppModal(onClose);
  return (
    <div data-app-modal className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('app.prefs.aria')}
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[640px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome('app.prefs.title')}</h3>
          <button data-testid="prefs-close" onClick={onClose} className="text-neutral-500 hover:text-neutral-300 text-sm">
            {tChrome('app.prefs.close')}
          </button>
        </div>
        <div className="p-5">
          <SettingsPanel initialCategory={category} />
        </div>
      </div>
    </div>
  );
}

const panels: Record<Operation, React.ComponentType> = {
  split: SplitPanel, rotate: RotatePanel, delete: DeletePanel,
  compress: CompressPanel, grayscale: GrayscalePanel, optimize: OptimizePanel,
  pdfa: PdfaPanel, pdf_version: PdfVersionPanel,
  encrypt: EncryptPanel, decrypt: DecryptPanel,
  extract_text: ExtractTextPanel,
  watermark: WatermarkPanel, forms: FormsPanel, compare: ComparePanel,
  signatures: SignaturesPanel, document_js: DocumentJsPanel,
  convert_cmyk: PrepressPanel, headerfooter: HeaderFooterPanel, pagebox: PageBoxesPanel,
  pagelabels: PageLabelsPanel, attachments: AttachmentsPanel, portfolio: PortfolioPanel, layers: LayersPanel,
  accessibility: AccessibilityPanel, comments: CommentsPanel, preflight: PreflightPanel,
  outputpreview: OutputPreviewPanel, inkmanager: InkManagerPanel,
  printermarks: PrinterMarksPanel, hairlines: HairlinesPanel, flattener: FlattenerPanel,
  trappresets: TrapPresetsPanel,
  links: LinksPanel, tags: TagsPanel, readingorder: ReadingOrderPanel,
  repair: RepairPanel, rebuild: RebuildPanel, recover: RecoverPanel,
  actions: GuidedActionsPanel, takeoff: TakeoffPanel,
  search_redact: SearchRedactPanel,
  prepareform: PrepareFormPanel,
  sanitize: SanitizePanel,
  tablereview: TableReviewPanel,
  scanenhance: ScanEnhancePanel,
  spelling: SpellingPanel,
};

/** What a built submission is saved as — one table, in `lib/form-submit.ts`
 * beside the content types it pairs with. `html` is
 * `application/x-www-form-urlencoded` text, which has no extension of its own,
 * so it takes the one a text editor will open. */
const SUBMIT_EXTENSION = SUBMIT_PAYLOAD_EXTENSION;

function AppContent(): React.ReactElement {
  // Re-render on language change; the banner's buttons and every
  // confirm/notice message below resolve via tChrome.
  useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  // The tab model lives in the ui slice so the command registry,
  // menus, and tab strip all read it. focusedTab replaces the old `view`.
  const focusedTab = state.ui.focusedTab;
  const inDocTab = isDocTab(focusedTab);
  const activeOp = state.ui.activeOp as Operation;
  // The tool whose pane the Tools tab shows; null = the tile grid ("no tool
  // open" is a real state, not an absence to paper over). `activeToolId` outlives the
  // document it was opened on (deliberately — Escape disarms the mode, not the
  // tool), so an ops-less tool with nothing to act on has NOTHING to put here:
  // its pane is a fence saying "this works on the page" plus a button that
  // `when`-fails with no document open. A dead button is worse than the grid.
  const setActiveOp = useCallback(
    (op: Operation) => dispatch({ type: 'UI_SET_ACTIVE_OP', op }),
    [dispatch],
  );
  // Which Preferences category is open, or null for closed. Carrying the
  // category (rather than a boolean) is what lets Help ▸ Third-party Licenses
  // land ON the licences, instead of at the top of a scroll.
  const [showSettings, setShowSettings] = useState<PrefCategory | null>(null);
  // Every Ghostscript-gated surface offers the same set-up affordance, and
  // Preferences is reachable from App alone — so App registers the route
  // once (the command-context slot idiom) rather than each of the 25
  // surfaces holding its own.
  useEffect(() => {
    registerGsSetupOpener(() => setShowSettings('engine'));
    return () => registerGsSetupOpener(null);
  }, []);
  // The Ghostscript launch offer. Once per launch, on the PRIMARY window
  // alone: a second window is a second workspace, not a second install, and
  // the answer being offered is machine-wide. `takeGsLaunchPrompt` is what
  // makes "once" true — a remount cannot re-ask, and neither can the second
  // window if it ever becomes the one that mounts first.
  const [showGsMissing, setShowGsMissing] = useState(false);
  useEffect(() => {
    if (!isPrimaryWindow()) return;
    void ensureGsCapability().then((capability) => {
      if (takeGsLaunchPrompt(capability)) setShowGsMissing(true);
    });
  }, []);
  const [showAbout, setShowAbout] = useState(false);
  // The colour-profile licence. It opens BY ITSELF exactly once — on a
  // portable copy with no answer on record — because the bundling terms
  // require the text to be presented before the profiles are used, and a
  // portable copy has no installer to present it. Every other appearance is
  // the user re-opening it from a disabled surface's notice, so a decline is
  // final until they change their mind rather than a question re-asked at
  // every launch.
  const [showIccLicense, setShowIccLicense] = useState(false);
  useEffect(() => {
    registerIccLicenseOpener(() => setShowIccLicense(true));
    void ensureIccAssent().then((state) => {
      if (iccNeedsAssent(state)) setShowIccLicense(true);
    });
    return () => registerIccLicenseOpener(null);
  }, []);
  const [showProperties, setShowProperties] = useState(false);
  const [showPrint, setShowPrint] = useState(false);
  const [showBatchOcr, setShowBatchOcr] = useState(false);
  const [showDiskRedact, setShowDiskRedact] = useState(false);
  const [showFormPrepFolder, setShowFormPrepFolder] = useState(false);
  const [showFolderExport, setShowFolderExport] = useState(false);
  const [showFolderPreflight, setShowFolderPreflight] = useState(false);
  const [showFolderCreatePdf, setShowFolderCreatePdf] = useState(false);
  const [showSchedules, setShowSchedules] = useState(false);
  const [showWatchers, setShowWatchers] = useState(false);
  const [showCreatePdf, setShowCreatePdf] = useState(false);
  // File ▸ Open from Web Address. `null` = closed; a string is the address the
  // field OPENS ON — a re-opened recent entry or a dropped link. Pre-filled is
  // as far as it goes: the request happens when the user presses Open.
  const [openWebUrl, setOpenWebUrl] = useState<string | null>(null);
  // Which acquisition the dialog starts on, when it was opened from one of
  // the File ▸ Create siblings rather than from Create PDF itself.
  const [createPdfAutoStart, setCreatePdfAutoStart] = useState<'clipboard' | 'web' | null>(null);
  // Which destination the scan dialog was opened for. `null` = closed; the
  // mode is settled at the entry point rather than inside the dialog, because
  // "append" is only meaningful where there is a document to append to.
  const [scanMode, setScanMode] = useState<'new' | 'append' | null>(null);
  // Sources a drop pre-populates Create PDF with. Cleared on close so
  // the next menu-opened dialog starts empty rather than replaying a drop.
  const [createPdfSeed, setCreatePdfSeed] = useState<string[]>([]);
  // Combine Files is a dialog now, not a bare picker: it has to
  // show per-row conversion state, page ranges and a target, none of which a
  // native file picker can carry.
  const [showCombine, setShowCombine] = useState(false);
  const [combineSeed, setCombineSeed] = useState<string[]>([]);
  // Read by the drop handler, which must not re-bind on every open/close.
  const showCombineRef = useRef(false);
  showCombineRef.current = showCombine;
  const [showExportImages, setShowExportImages] = useState(false);
  const [exportDocFormat, setExportDocFormat] = useState<DocumentExportFormat | null>(null);
  const [showCustomizeToolbar, setShowCustomizeToolbar] = useState(false);
  // Full-screen presentation mode (I.6): a transient overlay; `startIndex`
  // is the page to open on, resolved from the page being read.
  const [presentation, setPresentation] = useState<{ startIndex: number } | null>(null);
  // Own proxy map (pdfDocCache dedupes against the canvas's) so the overlay
  // renders independently of the reading column — the SearchProvider pattern.
  const presentationProxies = usePdfProxies(state.files);
  // Manual "Check for Updates" (Help menu): bump a signal the UpdateBar
  // watches, so the banner surfaces the available / up-to-date / disabled state.
  const [updateCheckSignal, setUpdateCheckSignal] = useState(0);
  const { items: queue, clear: clearQueue } = useOperationQueue();
  const [extractPage, setExtractPage] = useState<number | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const recentFiles = state.ui.recentFiles;
  const { call, callRaw, openFiles, saveFile } = useEngine();
  useWorkspaceIndexer();

  // Confirm dialog state — 3-choice unsaved (Save / Don't Save / Cancel),
  // 2-choice proceed (Continue / Cancel), or 1-button notice (OK); one
  // dialog, one result type.
  const [confirmState, setConfirmState] = useState<{
    message: string;
    kind?: 'unsaved' | 'proceed' | 'notice';
    title?: string;
    affirmLabel?: string;
    resolve: (result: ConfirmResult) => void;
  } | null>(null);

  // Password prompt dialog state
  const [passwordState, setPasswordState] = useState<{
    fileName: string;
    error?: string;
    resolve: (result: PasswordResult) => void;
  } | null>(null);

  const showPasswordPrompt = useCallback((fileName: string, error?: string): Promise<PasswordResult> => {
    return new Promise((resolve) => {
      setPasswordState({ fileName, error, resolve });
    });
  }, []);

  const handlePasswordResult = useCallback((result: PasswordResult) => {
    if (passwordState) {
      passwordState.resolve(result);
      setPasswordState(null);
    }
  }, [passwordState]);

  // Certificate-unlock prompt — the pubkey sibling of the password one.
  const [certUnlockState, setCertUnlockState] = useState<{
    fileName: string;
    error?: string;
    resolve: (result: CertUnlockResult) => void;
  } | null>(null);

  const showCertUnlockPrompt = useCallback(
    (fileName: string, error?: string): Promise<CertUnlockResult> => {
      return new Promise((resolve) => {
        setCertUnlockState({ fileName, error, resolve });
      });
    },
    [],
  );

  const handleCertUnlockResult = useCallback(
    (result: CertUnlockResult) => {
      if (certUnlockState) {
        certUnlockState.resolve(result);
        setCertUnlockState(null);
      }
    },
    [certUnlockState],
  );

  const showConfirm = useCallback((message: string): Promise<ConfirmResult> => {
    return new Promise((resolve) => {
      setConfirmState({ message, resolve });
    });
  }, []);

  /** Two-choice Continue/Cancel confirmation; resolves true on Continue. */
  const showProceedConfirm = useCallback((title: string, message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmState({ message, kind: 'proceed', title, resolve: (r) => resolve(r === 'save') });
    });
  }, []);

  // The submission consent dialog's state. It resolves ONE answer for ONE
  // request: there is no per-host memory to keep, deliberately, so the state
  // is torn down with the dialog.
  const [submitConsentState, setSubmitConsentState] = useState<{
    fieldName: string;
    url: string;
    format: SubmitFormat;
    method: 'get' | 'post';
    preview: PayloadPreview;
    fieldCount: number;
    resolve: (answer: SubmitConsentAnswer) => void;
  } | null>(null);

  const showSubmitConsent = useCallback(
    (
      fieldName: string,
      url: string,
      format: SubmitFormat,
      method: 'get' | 'post',
      preview: PayloadPreview,
      fieldCount: number,
    ): Promise<SubmitConsentAnswer> =>
      new Promise((resolve) => {
        setSubmitConsentState({ fieldName, url, format, method, preview, fieldCount, resolve });
      }),
    [],
  );

  const handleSubmitConsent = useCallback(
    (answer: SubmitConsentAnswer) => {
      if (submitConsentState) {
        submitConsentState.resolve(answer);
        setSubmitConsentState(null);
      }
    },
    [submitConsentState],
  );

  /** One-button OK notice — errors and outcomes with no choice to make. */
  const showNotice = useCallback((title: string, message: string): Promise<void> => {
    return new Promise((resolve) => {
      setConfirmState({ message, kind: 'notice', title, resolve: () => resolve() });
    });
  }, []);

  // A launch that found a "Start with Windows" entry naming a path this copy
  // has moved away from corrects it before any window exists. Only the launch
  // that could NOT write the correction has anything to say, and it says it
  // here because the correction ran with no surface to say it on.
  useEffect(() => {
    void app
      .startupEntryNotice()
      .then((detail) => {
        if (!detail) return;
        void showNotice(
          tChrome('app.startupEntry.staleTitle'),
          tChrome('app.startupEntry.stale', { detail }),
        );
      })
      .catch(() => {});
  }, [showNotice]);

  /** A refusal that has somewhere to send the user: the affirmative button
   * carries the action's own name rather than a generic Continue. */
  const showActionConfirm = useCallback(
    (title: string, message: string, affirmLabel: string): Promise<boolean> => {
      return new Promise((resolve) => {
        setConfirmState({
          message,
          kind: 'proceed',
          title,
          affirmLabel,
          resolve: (r) => resolve(r === 'save'),
        });
      });
    },
    [],
  );

  const editWarnedPathsRef = useRef<Set<string>>(new Set());
  // What a document's own signatures allow to be changed. The policy is read
  // every time — a file unsigned at the last check may have been signed
  // in-session since, and a refusal must hold on every attempt; only the
  // WARNING is remembered, per file, and only after the user said Continue
  // (caching the bare "checked once" skipped the warning after an in-session
  // sign). `signature_policy` is an internal read, so asking the question does
  // not flush the user's pending annotations to disk.
  const readSignaturePolicy = useCallback(
    async (workingPath: string): Promise<SignaturePolicy> =>
      (await call('signature_policy', { path: workingPath })) as unknown as SignaturePolicy,
    [call],
  );

  /** Render one decision. Shared by the whole-file classes and the page tier
   * so the two surfaces cannot drift on how a refusal is shown, only on how
   * the decision was reached. */
  const confirmDecision = useCallback(
    async (path: string, decision: SignedEditDecision): Promise<boolean> => {
      if (decision.kind === 'proceed') return true;
      // The locked-field refusal names what it stopped; every other decision
      // takes no values, and passing an unused one is harmless.
      const body = tChrome(decision.bodyKey, {
        fields: (decision.fields ?? []).join(', '),
        typed: (decision.typed ?? []).join(', '),
      });
      if (decision.kind === 'refuse') {
        await showNotice(tChrome(decision.titleKey), body);
        return false;
      }
      if (editWarnedPathsRef.current.has(path)) return true;
      const proceed = await showProceedConfirm(tChrome(decision.titleKey), body);
      if (!proceed) return false;
      editWarnedPathsRef.current.add(path);
      return true;
    },
    [showNotice, showProceedConfirm],
  );

  const confirmEditOfSignedDoc = useCallback(
    async (
      path: string,
      workingPath: string,
      editClass: EditClass,
      fields: readonly string[] | null = null,
      /** Of `fields`, the ones the caller actually named — the rest are what
       * the document's own calculations would change as a result. A lock that
       * bites only those has to say so, or a user told "Total is locked" after
       * typing into "Item 1" has been told nothing. */
      typed: readonly string[] | null = null,
    ): Promise<boolean> => {
      const policy = await readSignaturePolicy(workingPath);
      return confirmDecision(path, signedEditDecision(policy, editClass, fields, typed));
    },
    [readSignaturePolicy, confirmDecision],
  );

  /** The page tier's gate, taken BEFORE the gesture like every other one.
   *
   * The page tier writes at COMMIT time, so the question is not whether the
   * document is signed but whether the commit's append will carry THIS delta:
   * a rotate on an approval-signed document keeps its signature and must not
   * raise a dialog, while the same rotate on a certified one costs it and
   * must. One selection can span files, so each affected document is decided
   * on its own policy and the first refusal stops the whole gesture — a
   * partially-applied batch is not a thing the page tier can undo halfway. */
  const confirmPageEdit = useCallback(
    async (paths: readonly string[], delta: PageDelta): Promise<boolean> => {
      for (const path of paths) {
        const f = state.files.get(path);
        if (!f) continue;
        const policy = await readSignaturePolicy(f.workingPath);
        if (!(await confirmDecision(path, pageEditDecision(policy, delta)))) return false;
      }
      return true;
    },
    [state.files, readSignaturePolicy, confirmDecision],
  );

  const handleConfirmResult = useCallback((result: ConfirmResult) => {
    if (confirmState) {
      confirmState.resolve(result);
      setConfirmState(null);
    }
  }, [confirmState]);

  // Fetch app version on mount
  useEffect(() => {
    app.getVersion().then((v) => setAppVersion(`v${v}`));
  }, []);

  // Mirror the recent-files list (ui slice) to localStorage — the single
  // persistence point; every mutation just dispatches UI_SET_RECENT_FILES.
  // The key is shared by every window, so the write folds in whatever another
  // window recorded since this one last wrote, and the result is adopted back
  // into state rather than left to drift from what is stored.
  useEffect(() => {
    const merged = persistRecent(recentFiles);
    if (!sameRecent(merged, recentFiles)) {
      dispatch({ type: 'UI_SET_RECENT_FILES', files: merged });
    }
  }, [recentFiles, dispatch]);

  // Mirror the toolbar overrides (I.6 customization) the same way.
  useEffect(() => {
    persistToolbarOverrides(state.ui.toolbarOverrides);
  }, [state.ui.toolbarOverrides]);

  // Mirror the nav-pane state to the workbench-ui key. Debounced: a resize
  // drag dispatches a new width per pointermove, and an unthrottled synchronous
  // localStorage write per event competes with the drag for main-thread time
  // (regression). Each change reschedules; only the settled value persists.
  useEffect(() => {
    const t = setTimeout(
      () =>
        writeWorkbenchUi({
          navPane: state.ui.navPane,
          toolDock: state.ui.toolDock,
          toolLock: state.ui.toolLock,
        }),
      200,
    );
    return () => clearTimeout(t);
  }, [state.ui.navPane, state.ui.toolDock, state.ui.toolLock]);

  const activeFile = state.activeFileId ? state.files.get(state.activeFileId) : null;
  // Commit-failure banner: commits triggered from gates/effects have no
  // natural place to report, so failures surface here.
  const [commitError, setCommitError] = useState<string | null>(null);

  // Signed files whose commit could not be appended, waiting to be said out
  // loud. Queued rather than awaited inside the commit: the commit's promise
  // is what the commit gate and every save flow wait on, and parking those
  // behind a modal would put an OK button in front of the engine queue. The
  // rewrite has already landed by the time this runs — the notice reports
  // what happened, it does not gate it.
  const preserveQueue = useRef<PreserveRefusal[]>([]);
  const preserveDraining = useRef(false);
  const reportPreserveRefusals = useCallback(
    (refusals: readonly PreserveRefusal[]) => {
      if (refusals.length === 0) return;
      preserveQueue.current.push(...refusals);
      if (preserveDraining.current) return;
      preserveDraining.current = true;
      void (async () => {
        try {
          for (;;) {
            const next = preserveQueue.current.shift();
            if (!next) break;
            const reason =
              'detail' in next.reason
                ? tChrome(next.reason.key, { detail: next.reason.detail })
                : tChrome(next.reason.key);
            await showNotice(
              tChrome('app.preserve.title'),
              tChrome('app.preserve.notPreserved', {
                name: next.path.split(/[\\/]/).pop() ?? next.path,
                reason,
              }),
            );
          }
        } finally {
          preserveDraining.current = false;
        }
      })();
    },
    [showNotice],
  );

  // Materialize pending in-memory page edits onto the snapshot undo chain.
  // Runs before anything that reads or replaces file bytes (save, whole-file
  // ops, close) — all dirty files commit together because cross-file moves
  // entangle them. Uses the raw (ungated) snapshot to avoid re-entering the
  // commit gate.
  const inflightCommit = useRef<Promise<void> | null>(null);
  const commitIfNeeded = useCallback((): Promise<void> => {
    if (inflightCommit.current) return inflightCommit.current;
    if (state.pageDirtyPaths.length === 0) return Promise.resolve();
    const run = (async () => {
      try {
        const outcome = await commitPageEdits({
          workspace: state.workspace,
          files: state.files,
          dirtyPaths: state.pageDirtyPaths,
          dispatch,
          snapshot: file.snapshotRaw,
          writeBuffer: file.writeBuffer,
          rename: file.rename,
          remove: file.remove,
          // callRaw, deliberately — this runs INSIDE the commit, so
          // the gated `call` would re-enter commitPageEdits (loud throw).
          // The gate's guarantee ("engine reads bytes matching what the
          // user sees") holds by construction here: we ARE the commit,
          // reading the working copy plus the temp this very run staged.
          // The engine's OUTCOME travels, not a boolean: `applied: false`
          // covers an unsigned file and a refused append equally, and the
          // reason is the only thing that separates the standing behaviour
          // from a signature the user just lost.
          preserveSignatures: async (workingPath, stagedPath) => {
            const r = (await callRaw('transplant_incremental', {
              original: workingPath,
              modified: stagedPath,
              output: stagedPath,
            })) as unknown as PreserveOutcome;
            return { ...r, applied: r.applied === true };
          },
          readBack: batch.readFileBuffer,
        });
        setCommitError(null);
        reportPreserveRefusals(outcome.signatureRefusals);
      } finally {
        inflightCommit.current = null;
      }
    })();
    inflightCommit.current = run;
    return run;
  }, [
    state.pageDirtyPaths,
    state.workspace,
    state.files,
    dispatch,
    callRaw,
    reportPreserveRefusals,
  ]);
  const commitRef = useRef(commitIfNeeded);
  commitRef.current = commitIfNeeded;

  // Fire-and-forget variant for gates/effects/buttons: reports instead of
  // throwing. Flows that must abort on failure (save, close) await
  // commitIfNeeded directly and handle the rejection themselves.
  const commitAndReport = useCallback(async () => {
    try {
      await commitRef.current();
    } catch (err) {
      setCommitError(
        tChrome('app.commit.failedRetry', {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }, []);

  // Register the commit gate so panel operations (which snapshot the working
  // file before mutating it) flush pending canvas edits first.
  useEffect(() => {
    setCommitGate(() => commitRef.current());
    return () => setCommitGate(null);
  }, []);

  const isFileDirty = useCallback(
    (f: { path: string; dirty: boolean }) =>
      f.dirty || state.pageDirtyPaths.includes(f.path),
    [state.pageDirtyPaths],
  );

  // Reload the working copy buffer and page count into state
  const reloadFile = useCallback(async (filePath: string) => {
    const f = state.files.get(filePath);
    if (!f) return;
    const buffer = await file.readBuffer(f.workingPath);
    const info = await call('get_page_count', { file: f.workingPath });
    return { buffer, pageCount: info.pages };
  }, [state.files, call]);

  // Create a working copy, unlock if encrypted, read bytes + page count. Shared
  // by opening files and by importing a file's pages into a document.
  // Returns null if the user cancelled an encrypted file.
  const prepareFileBytes = useCallback(
    async (
      filePath: string,
    ): Promise<{ workingPath: string; name: string; buffer: PdfBuffer; pageCount: number } | null> => {
      const workingPath = await file.createWorkingCopy(filePath);
      const name = filePath.split(/[\\/]/).pop() || filePath;
      const encStatus = await call('check_encrypted', { file: workingPath });
      if (encStatus.encrypted) {
        let unlocked = false;
        let error: string | undefined;
        while (!unlocked) {
          if (encStatus.kind === 'pubkey') {
            // Certificate-encrypted (Adobe.PubSec) — unlock with the
            // user's PKCS#12 key. The engine's refusals are already honest
            // ("does not match any recipient" / "check the file and its
            // password"), so they surface verbatim.
            const result = await showCertUnlockPrompt(name, error);
            if (result === 'cancel') return null;
            try {
              await call('decrypt_pubkey', {
                file: workingPath,
                output: workingPath,
                pfx: result.pfx,
                password: result.password,
              });
              unlocked = true;
            } catch (e) {
              error = e instanceof Error ? e.message : String(e);
            }
          } else {
            const result = await showPasswordPrompt(name, error);
            if (result === 'cancel') return null;
            try {
              await call('unlock', { file: workingPath, password: result.password });
              unlocked = true;
            } catch {
              error = 'Incorrect password. Please try again.';
            }
          }
        }
      }
      const buffer = await file.readBuffer(workingPath);
      const info = await call('get_page_count', { file: workingPath });
      return { workingPath, name, buffer, pageCount: info.pages };
    },
    [call, showPasswordPrompt, showCertUnlockPrompt],
  );

  const stateRef = useRef(state);
  stateRef.current = state;

  // Documents this window has handed to another and not yet heard the outcome
  // for. A handover moves ownership before the receiving window has opened
  // anything, so a window destroyed in that gap gives the document back — and
  // whether that return means "keep the tab you were about to close" or "open
  // this again" is a question only the hand-off in flight can answer.
  const handOffsInFlight = useRef(new Map<string, { returned: boolean }>());

  // A newly opened document's own initial view: the layout, navigation pane
  // and reading mode land as one reducer act; the opening page and its
  // magnification are applied to the canvas once the document has indexed.
  // A catalog this cannot read never blocks an open — the document appears
  // with the workbench's own view, which is what a reader without the
  // preference does.
  const applyInitialView = useCallback(
    async (path: string, workingPath: string) => {
      let view;
      try {
        view = parseInitialView(
          (await call('get_initial_view', { file: workingPath })) as unknown as Record<string, unknown>,
        );
      } catch {
        return;
      }
      const plan = initialViewPlan(view);
      if (!planIsInert(plan, stateRef.current.ui.spreadDirection)) {
        dispatch({ type: 'UI_APPLY_INITIAL_VIEW', plan });
      }
      if (plan.page === null) return;
      // The OPEN_FILE dispatch and the workspace index land over the next
      // renders, so poll the (idempotent) jump and stop on the first success —
      // `openPathAtPage`'s own bounded shape, for the same reason.
      let landed = false;
      for (let i = 0; i < 15 && !landed; i++) {
        landed = getCanvasServices()?.jumpToFilePage(path, plan.page) ?? false;
        if (!landed) await new Promise((r) => setTimeout(r, 120));
      }
      if (!landed) return;
      const canvas = getCanvasServices()?.canvas();
      if (plan.zoomPercent !== null) canvas?.setZoomPercent?.(plan.zoomPercent);
      else if (plan.fitWidth) canvas?.fitWidth?.();
    },
    [call, dispatch],
  );

  // Open files, then focus the last opened document's tab (opening a file is
  // an explicit request to view it). Already-open files are
  // re-activated. Recent list accumulates once so a multi-open batch doesn't
  // clobber itself.
  // `focus: false` opens without moving the user: a panel's "Open a PDF"
  // button is a way to give the PANEL a file, not a request to go read it.
  // That difference used to justify a whole second implementation of "open some
  // files" (useActiveFile.openNewFiles), which then diverged from this one FOUR
  // times — including losing encryption support entirely, so a panel's Open
  // button could not open a password-protected PDF at all. One implementation,
  // one flag.
  // Tell the user which window holds what they asked for, and offer to go
  // there. A refusal that names one window is a routing decision rather than a
  // wall; a batch spanning several windows has nowhere single to send them, so
  // it states the fact and stops.
  const reportClaimRefusal = useCallback(
    async (refused: ClaimRefusal[], kind: 'window' | 'import'): Promise<void> => {
      const names = refused
        .map((r) => r.path.split(/[\\/]/).pop() ?? r.path)
        .join(', ');
      const title = tChrome('app.window.claimTitle');
      const body = tChrome(
        kind === 'import' ? 'app.window.importElsewhere' : 'app.window.openElsewhere',
        { names },
      );
      const owner = soleOwner(refused);
      if (!owner) {
        await showNotice(title, body);
        return;
      }
      const go = await showActionConfirm(title, body, tChrome('app.window.focusOther'));
      if (go) await app.focusWindow(owner);
    },
    [showNotice, showActionConfirm],
  );

  // ONE notice for a whole open batch, whatever its size. A file that never
  // appears is the one case where silence is wrong: the user made a request
  // and the application did nothing visible. Per-file reasons are carried
  // inside a single message rather than a dialog each, so opening a folder of
  // damaged files stays one interruption.
  const reportOpenSummary = useCallback(
    async (summary: OpenSummary): Promise<void> => {
      if (summary.kind === 'none') return;
      const title = tChrome('app.open.failedTitle');
      if (summary.kind === 'single') {
        await showNotice(
          title,
          tChrome('app.open.failedOne', { name: summary.name, reason: summary.reason }),
        );
        return;
      }
      const failures = summary.failures
        .map((f) => tChrome('app.open.failureItem', { name: f.name, reason: f.reason }))
        .join(' ');
      await showNotice(
        title,
        tChrome('app.open.failedBatch', {
          opened: tNumber(summary.openedCount),
          total: tNumber(summary.totalCount),
          failures,
        }),
      );
    },
    [showNotice],
  );

  // `index` is a tab position for the opens that have one — a tab dropped in
  // from another window lands at the gap its caret marked, and a batch lands
  // in order from there. Every other open appends; a stale index clamps.
  // `webOrigin` is the address a downloaded copy came from (File ▸ Open from
  // Web Address). It travels with the open rather than being looked up later:
  // it decides where File ▸ Save goes for that document, and it is the
  // provenance the recent list shows and re-opens by.
  // `reportFailures: false` takes the notice off this funnel and hands the
  // outcomes back instead — for the one caller that already shows the refusal
  // in its own surface (Open from Web Address, beside the address it typed).
  // Everything else gets the notice, because the alternative is the defect
  // this exists to close: the user picked a file and nothing happened.
  const openByPaths = useCallback(async (
    paths: string[],
    opts?: { focus?: boolean; index?: number; webOrigin?: string; reportFailures?: boolean },
  ): Promise<OpenSummary> => {
    // Every file this batch reached a verdict on. A cancelled password prompt
    // is neither: the user answered the question and the answer was no.
    const outcomes: OpenOutcome[] = [];
    let recent = stateRef.current.ui.recentFiles;
    let lastOpened: string | null = null;
    let inserted = 0;
    // The file that was really OPENED (not re-activated) and became the
    // landing tab. Only a fresh open applies an initial view: re-activating a
    // tab must not undo a layout the user chose while it was open.
    let freshlyOpened: { path: string; workingPath: string } | null = null;
    let changed = false;
    // Claimed but not yet accounted for — released in the finally.
    let unopened = new Set<string>();
    try {
      // THE PATH-IDENTITY GATE. File identity is the raw path string
      // app-wide (`state.files` keys, tabs, recents, activeFileId,
      // PageRef.sourceDocId), and Windows spells the same file many ways —
      // case, slash direction, 8.3 short names. Rust producers (dialogs,
      // argv, second instance) canonicalize at the source; this covers what
      // arrives through the webview (drops, recents persisted before the
      // gate, the harness), so `C:\a.pdf` and `c:\A.PDF` are ONE file from
      // here on. One authority (the Rust canonicalizer), applied at the one
      // funnel every open flows through — NOT a local string normalize,
      // which is what the old tracked gap warned against.
      const canonical = await app.canonicalizePaths(paths);
      // Web-download provenance must survive a cross-window hand-off (Move to
      // New Window, a torn-off tab), where the handover carries the PATH ONLY —
      // never a page or document id, whose generation counters are per-realm.
      // The origin is registered here on the open that downloaded it and
      // recovered here, by path, on any later open of that temp copy — so
      // `saveRouteFor` still routes Save to Save As in the window it moved to.
      //
      // Both the register and the recover are BEST-EFFORT: this map is only how
      // a HAND-OFF relearns the origin. The window that downloaded the file
      // already carries it in `opts.webOrigin` and threads it straight into
      // OPEN_FILE below — so a failed IPC here can never keep a same-window
      // web-open from routing Save to Save As, nor abort the open itself.
      const canonicalSet = [...new Set(canonical)];
      if (opts?.webOrigin) {
        const origin = opts.webOrigin;
        await Promise.all(
          canonicalSet.map((p) => app.registerWebOrigin(p, origin).catch(() => {})),
        );
      }
      const recoveredOrigins = opts?.webOrigin
        ? null
        : await app.webOriginsFor(canonicalSet).catch(() => ({}) as Record<string, string>);
      const originFor = (filePath: string): string | undefined =>
        opts?.webOrigin ?? recoveredOrigins?.[filePath];
      //
      // The same path twice in one batch is one open. Nothing upstream
      // dedupes: `spectrapdf.exe a.pdf a.pdf` really arrives as two
      // entries — and post-gate, `a.pdf A.PDF` collapses here too.
      //
      // This can't be left to the already-open check below: that reads state
      // React hasn't flushed yet. The loop only awaits BEFORE each dispatch,
      // never after, so the next iteration's read runs in the same tick as the
      // previous OPEN_FILE and still sees the file as absent — `stateRef` is as
      // stale as the closure was for this particular read. A duplicate would
      // open twice, leaking the first working copy (`create_working_copy` mints
      // a fresh temp dir per call and nothing purges them) and prompting twice
      // for an encrypted file's password.
      // THE OWNERSHIP GATE. A path is live in at most one window, and the
      // claim is taken before any bytes are read: `create_working_copy` mints
      // a fresh temp directory per call, so a second window opening the same
      // file gets an independent edit session on a private copy, and the two
      // are reconciled by whichever bare `save_as` copy lands last. The claim
      // sits here rather than at commit time because by commit time both
      // sessions exist and one of them has to be thrown away.
      const { granted, refused } = await claimPaths([...new Set(canonical)], 'write');
      if (refused.length > 0) void reportClaimRefusal(refused, 'window');
      unopened = new Set(granted);
      for (const filePath of granted) {
        // Already open as a real DOCUMENT → just re-activate it. A byte-only
        // import source doesn't count: it has an entry in `files` but no tab,
        // nothing ever upgrades the flag, and `focusTab` rejects a doc tab for
        // it — so treating it as "already open" made File ▸ Open on a file you
        // had previously imported pages FROM a permanent no-op with no
        // feedback. Fall through and open it properly instead.
        // Off the ref, not the closure: the closure's `state.files` is stale for
        // the whole call (the same reason `recent` is threaded above), so a
        // file opened by an earlier, separate openByPaths call would be missed.
        // The ref is current as of the last completed render — which is enough
        // here precisely because the dedupe above already handles the one case
        // it can't see (a duplicate within this batch, dispatched but not yet
        // flushed).
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        const existing = stateRef.current.files.get(filePath);
        if (existing && !existing.importOnly) {
          outcomes.push({ name: fileName, reason: null });
          dispatch({ type: 'SET_ACTIVE_FILE', path: filePath });
          recent = withRecent(recent, filePath, Date.now(), originFor(filePath)); // only on success — a cancel/throw
          lastOpened = filePath;                  // must not pollute Recent (regression)
          freshlyOpened = null;
          changed = true;
          unopened.delete(filePath);
          continue;
        }
        if (existing?.importOnly) {
          // Upgrading a ghost REPLACES bytes that other documents' pending
          // pages still point into (`PageRef.sourceDocId` + a positional
          // `sourcePageIndex`, resolved at commit by `bytesFor`). If the file
          // changed on disk since the import, those indices now mean something
          // else — a silent wrong page, or a throw at commit. Flush first, so
          // the imported pages are materialized into their own files and
          // nothing references these bytes any more. `prepareFileBytes` can't
          // be relied on for this: its only engine call is `check_encrypted`,
          // which is an INTERNAL_METHOD and so deliberately ungated.
          await runCommitGate();
        }
        // THE REFUSAL SEAM. `prepareFileBytes` mints the working copy and runs
        // the engine's first reads; anything the file is too broken for throws
        // HERE, and used to propagate out of the funnel into a rejection
        // nobody caught. A throw is one file's verdict, never the batch's: the
        // loop continues, the claim on this path is released by the finally,
        // and the batch reports every outcome once at the end.
        let prepared: Awaited<ReturnType<typeof prepareFileBytes>>;
        try {
          prepared = await prepareFileBytes(filePath);
        } catch (err) {
          outcomes.push({
            name: fileName,
            reason: translateOpenFailure(err instanceof Error ? err.message : String(err), {
              name: fileName,
              path: filePath,
            }),
          });
          continue;
        }
        if (!prepared) continue; // cancelled encrypted file
        outcomes.push({ name: fileName, reason: null });
        dispatch({
          type: 'OPEN_FILE',
          path: filePath,
          ...prepared,
          index: opts?.index === undefined ? undefined : opts.index + inserted,
          webOrigin: originFor(filePath),
        });
        inserted += 1;
        recent = withRecent(recent, filePath, Date.now(), originFor(filePath));
        lastOpened = filePath;
        freshlyOpened = { path: filePath, workingPath: prepared.workingPath };
        changed = true;
        unopened.delete(filePath);
      }
    } finally {
      // Flush whatever succeeded even if a later file threw (a malformed PDF
      // mid-batch would otherwise strand the opened tabs unfocused + unrecorded).
      if (changed) dispatch({ type: 'UI_SET_RECENT_FILES', files: recent });
      if (lastOpened && opts?.focus !== false) dispatch({ type: 'UI_FOCUS_TAB', tab: { doc: lastOpened } });
      // A claim outlives only what it protects: a cancelled password prompt or
      // a file that threw mid-batch must not leave this window holding a path
      // it never opened.
      if (unopened.size > 0) void releasePaths([...unopened]);
    }
    // Outside the finally: an initial view is a courtesy on top of a
    // completed open, never a reason for the open itself to report a failure.
    if (freshlyOpened && lastOpened === freshlyOpened.path && opts?.focus !== false) {
      await applyInitialView(freshlyOpened.path, freshlyOpened.workingPath);
    }
    const summary = summarizeOpenOutcomes(outcomes);
    // Unawaited, like every other notice this funnel raises: the notice is
    // dismissed by the user, and an open that has already done everything it
    // can must not stay pending until they get to it.
    if (opts?.reportFailures !== false) void reportOpenSummary(summary);
    return summary;
  }, [dispatch, prepareFileBytes, applyInitialView, reportClaimRefusal, reportOpenSummary]);

  // Import one or more files' pages INTO an existing document at an index (the
  // add-page ghost and per-position drops). Each file is registered
  // byte-only (no strip) and its pages spliced in — atomic, undoable. Files
  // already open are reused. A cancelled encrypted file is skipped.
  const importFilesIntoDoc = useCallback(
    async (rawPaths: string[], toDocId: string, toIndex: number) => {
      // Adding pages changes the destination's page TREE, which is
      // `page-structure`: the append tier carries it on an approval-signed
      // document and no certification permits it. Asked first, before a claim
      // is taken or a byte is read, so a refusal costs nothing.
      const dest = state.workspace.documents.find((d) => d.id === toDocId);
      if (dest && !(await confirmPageEdit([dest.path], 'page-structure'))) return;
      // Import sources are `files` entries keyed by path too — the same
      // identity gate as openByPaths (a case-variant drop must reuse the
      // already-registered source, not mint a second ghost) INCLUDING its
      // batch dedup: post-canonicalization, two spellings in one dialog
      // batch are the same string, and `state.files` is a stale snapshot
      // for this whole call — without the Set both passes take the
      // "unregistered" branch and IMPORT_PAGES splices duplicate PageRef
      // ids into the document (regression).
      // A READ claim, and it is exclusive against a write claim: an import
      // source's pending pages resolve by (source, positional index) at commit
      // time, so a window rewriting that file turns those indices into
      // different content — a silent wrong page, across a boundary where no
      // flush can fix it. Two readers coexist; nobody rewrites through a read
      // claim.
      const canonicalImports = [...new Set(await app.canonicalizePaths(rawPaths))];
      const claimed = await claimPaths(canonicalImports, 'read');
      if (claimed.refused.length > 0) void reportClaimRefusal(claimed.refused, 'import');
      const filePaths = claimed.granted;
      const toRegister: {
        path: string;
        workingPath: string;
        name: string;
        pageCount: number;
        buffer: PdfBuffer;
      }[] = [];
      const allPages: PageRef[] = [];
      // Paths this window already held before the import: releasing one would
      // drop the WRITE claim on a document that is still open here.
      const unused = new Set(filePaths.filter((p) => !state.files.has(p)));
      for (const filePath of filePaths) {
        const existing = state.files.get(filePath);
        let src: { workingPath: string; name: string; buffer: PdfBuffer; pageCount: number };
        if (existing?.buffer) {
          src = {
            workingPath: existing.workingPath,
            name: existing.name,
            buffer: existing.buffer,
            pageCount: existing.pageCount,
          };
        } else {
          const prepared = await prepareFileBytes(filePath);
          if (!prepared) continue;
          toRegister.push({ path: filePath, ...prepared });
          src = prepared;
        }
        const docs = await indexOpenFile({
          path: filePath,
          workingPath: src.workingPath,
          name: src.name,
          pageCount: src.pageCount,
          buffer: src.buffer,
          dirty: false,
          undoStack: [],
          redoStack: [],
          importOnly: true,
        });
        for (const d of docs) allPages.push(...d.pages);
        unused.delete(filePath);
      }
      if (allPages.length === 0) {
        if (unused.size > 0) void releasePaths([...unused]);
        return;
      }
      for (const reg of toRegister) dispatch({ type: 'REGISTER_IMPORT_SOURCE', ...reg });
      dispatch({ type: 'IMPORT_PAGES', toDocId, toIndex, pages: allPages });
      if (unused.size > 0) void releasePaths([...unused]);
    },
    [
      state.files,
      state.workspace.documents,
      dispatch,
      prepareFileBytes,
      reportClaimRefusal,
      confirmPageEdit,
    ],
  );

  // The canvas publishes its drop resolver here.
  const dropResolverRef = useRef<CanvasDropResolver | null>(null);

  const handleFilesDropped = useCallback(
    async (paths: string[], position?: { x: number; y: number }) => {
      // A drop landing ON a document while a doc tab is focused imports its
      // pages into that document at the drop point. A miss falls
      // through to opening the files (which focuses the last one's tab).
      // A zoom refusal from the resolver is recorded, not announced here: the
      // routes below produce different outcomes (a Combine list, the Create-PDF
      // dialog, nothing at all for an unsupported kind), and a notice naming an
      // outcome fires only on the branch that actually produces it.
      let refusedZoom = false;
      if (inDocTab && position && dropResolverRef.current) {
        const dpr = window.devicePixelRatio || 1;
        const target = dropResolverRef.current(position.x / dpr, position.y / dpr);
        if (target && 'docId' in target) {
          await importFilesIntoDoc(paths, target.docId, target.index);
          return;
        }
        if (target) refusedZoom = true;
      }
      // Drop-to-combine: while the Combine dialog is open a
      // drop is an ADD, whatever the kinds are — including PDFs, which the
      // funnel would otherwise open in their own tabs behind the dialog the
      // user is building a list in. Read through a ref so the drop handler
      // does not re-bind every time the dialog opens or closes.
      if (showCombineRef.current) {
        const accepted = paths.filter((p) => classifySource(p) !== '');
        if (accepted.length > 0) setCombineSeed(accepted);
        return;
      }
      // A drop carrying files the open funnel cannot take (a .docx, a
      // .png, a .ps) used to do NOTHING. It now offers to convert them,
      // through the same dialog, pre-populated — and the funnel rule holds,
      // because everything still lands in openByPaths once a PDF exists.
      const convertible = paths.filter((p) => classifySource(p) !== '' && classifySource(p) !== 'pdf');
      const pdfs = paths.filter((p) => classifySource(p) === 'pdf');
      if (convertible.length > 0) {
        setCreatePdfSeed(convertible);
        setShowCreatePdf(true);
      }
      if (pdfs.length > 0) {
        await openByPaths(pdfs);
        // The documents are open by the time this fires, so the past tense is
        // true, and it is fire-and-forget: `showNotice` resolves on dismissal,
        // so awaiting it would hold the drop open behind an OK button for a
        // message about work already finished.
        if (refusedZoom) {
          void showNotice(
            tChrome('dialog.dropImport.zoomTitle'),
            tChrome('dialog.dropImport.zoomBody'),
          );
        }
      }
    },
    [openByPaths, importFilesIntoDoc, inDocTab, showNotice],
  );

  const handleOpenFile = useCallback(async (): Promise<boolean> => {
    const paths = await openFiles();
    if (paths.length > 0) {
      await openByPaths(paths);
      return true;
    }
    return false;
  }, [openFiles, openByPaths]);

  // The downloaded copy, handed to the ONE open funnel. Nothing here inspects
  // the bytes: whether they are a document is the funnel's existing question,
  // and its refusal comes back as text for the dialog to show beside the
  // address rather than as a throw nobody catches.
  const openDownloadedFile = useCallback(
    async ({ path, url }: OpenFromWebResult): Promise<string | null> => {
      try {
        // The funnel's own notice is suppressed here and only here: this
        // dialog shows the refusal beside the address the user typed, and two
        // surfaces for one refusal is the noise the open path does not have.
        const summary = await openByPaths([path], { webOrigin: url, reportFailures: false });
        if (summary.kind === 'single') return summary.reason;
        if (summary.kind === 'batch' && summary.failures.length > 0) {
          return summary.failures[0].reason;
        }
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [openByPaths],
  );

  // Add-page ghost: pick file(s) and import their pages into a document.
  const handleAddPages = useCallback(
    async (docId: string, toIndex: number) => {
      const paths = await openFiles();
      if (paths.length > 0) await importFilesIntoDoc(paths, docId, toIndex);
    },
    [openFiles, importFilesIntoDoc],
  );

  // Document ▸ Insert Pages ▸ …. Both land AFTER the page being read
  // (`insertAnchor`) and both ride the byte-only import machinery — undoable
  // page-tier work, zero new commit paths.
  const insertPagesFromFile = useCallback(async () => {
    const anchor = insertAnchor(stateRef.current);
    if (!anchor) return;
    await handleAddPages(anchor.docId, anchor.index);
  }, [handleAddPages]);

  // Combine Files. Was a bare `openFiles()` into the page-tier
  // import, which is why it took PDFs only — a .docx cannot enter the page
  // tier. It opens the Combine dialog now: the conversion happens through the
  // one `create_pdf` door and only the RESULT reaches the import machinery,
  // so combining into an open document stays undoable page-tier work.
  //
  // Available with NO document open, deliberately: "combine into a new PDF"
  // is a create, and gating the command on an insert anchor made the Home
  // tab's own Combine action dead on a cold start.
  const combineFiles = useCallback(async () => {
    setCombineSeed([]);
    setShowCombine(true);
  }, []);

  // The documents Combine may add pages to. Ghost-backed ones are excluded by
  // the selector, not here — importing into a ghost would put pages in a
  // document with no tab and no dirty marker (the showableDoc hazard).
  const combineDestinations = useMemo<CombineDestination[]>(
    () =>
      showableDocuments(state).map((d) => ({
        docId: d.id,
        name: d.name,
        pages: d.pages.length,
      })),
    [state],
  );

  // Where a converted member is staged for an append: beside the destination's
  // working copy. That directory exists by construction (create_working_copy
  // made it) and is inside the fs capability's $TEMP/spectrapdf scope, so no
  // new grants and no mkdir — the insertBlankPage precedent.
  const combineWorkingDirFor = useCallback((docId: string): string | null => {
    const s = stateRef.current;
    const doc = s.workspace.documents.find((d) => d.id === docId);
    const destFile = doc ? s.files.get(doc.path) : null;
    if (!destFile) return null;
    return destFile.workingPath.replace(/[\\/][^\\/]+$/, '');
  }, []);

  const appendCombined = useCallback(
    async (docId: string, paths: string[]) => {
      const doc = stateRef.current.workspace.documents.find((d) => d.id === docId);
      if (!doc) return;
      await importFilesIntoDoc(paths, docId, doc.pages.length);
    },
    [importFilesIntoDoc],
  );

  const insertBlankPage = useCallback(async () => {
    const s = stateRef.current;
    const anchor = insertAnchor(s);
    if (!anchor) return;
    const destDoc = s.workspace.documents.find((d) => d.id === anchor.docId);
    const destFile = destDoc ? s.files.get(destDoc.path) : null;
    if (!destFile) return;
    const bytes = await buildBlankPagePdf(
      anchor.neighbor?.width,
      anchor.neighbor?.height,
    );
    // Written beside the destination's working copy: that directory exists by
    // construction (create_working_copy made it) and is inside the fs
    // capability's $TEMP/spectrapdf scope — no new grants, no mkdir.
    const dir = destFile.workingPath.replace(/[\\/][^\\/]+$/, '');
    const sep = destFile.workingPath.includes('\\') ? '\\' : '/';
    const tempPath = `${dir}${sep}blank-${crypto.randomUUID()}.pdf`;
    await file.writeBuffer(tempPath, bytes);
    await importFilesIntoDoc([tempPath], anchor.docId, anchor.index);
  }, [importFilesIntoDoc]);

  /** Where an appended scan assembles: beside the destination's working copy,
   * which exists by construction and is inside the filesystem capability's own
   * scope, so the import reads it back with no new grant. */
  const scanAppendDir = useMemo(() => {
    const anchor = insertAnchor(state);
    return anchor ? combineWorkingDirFor(anchor.docId) : null;
  }, [state, combineWorkingDirFor]);

  /** A scan's assembled PDF into the open document at the insertion anchor —
   * the byte-only import machinery, so the added pages are undoable page-tier
   * work and no new commit path exists. */
  const insertPagesFromScan = useCallback(
    async (path: string) => {
      const anchor = insertAnchor(stateRef.current);
      if (!anchor) return;
      await importFilesIntoDoc([path], anchor.docId, anchor.index);
    },
    [importFilesIntoDoc],
  );

  // Snapshot + perform operation + reload. The engine's answer is RETURNED —
  // an operation that reports a partial result can only reach the surface
  // that must say so through this value.
  //
  // THE SIGNED-DOCUMENT GATE LIVES HERE, once, keyed on the op's own edit
  // class. Every in-place operation flows through this function, so a class
  // in the roster is a question asked on every surface that runs the op —
  // which is the difference between sixteen guarded call sites and fourteen
  // unguarded ones. The two `none` ops own their own confirms, for reasons
  // the roster states.
  //
  // The decision runs BEFORE the snapshot: `file.snapshot` runs the commit
  // gate, so asking afterwards would have flushed the user's pending page
  // edits to disk on the way to refusing the edit that caused it.
  const performOperation = useCallback<PerformOperation>(async (
    filePath: string,
    method: OpMethod,
    params: Record<string, unknown>,
  ) => {
    const f = state.files.get(filePath);
    if (!f) return null;
    const editClass = opEditClass(method);
    if (editClass !== 'none' && !(await confirmEditOfSignedDoc(filePath, f.workingPath, editClass))) {
      return EDIT_DECLINED;
    }
    const snapshotPath = await file.snapshot(f.workingPath);
    const answer = await call(method, { ...params, file: f.workingPath, output: f.workingPath });
    const reloaded = await reloadFile(filePath);
    if (reloaded) {
      dispatch({ type: 'UPDATE_FILE', path: filePath, pageCount: reloaded.pageCount, buffer: reloaded.buffer, snapshotPath });
    }
    return answer;
  }, [state.files, call, reloadFile, dispatch, confirmEditOfSignedDoc]);

  // Applying redactions REWRITES the page content, so it is a structural-class
  // edit however small the band: the append tier cannot carry it, every byte
  // range breaks, and a certification that forbids the change is refused
  // rather than warned about. Returns whether the redaction ran — the caller
  // clears the applied marks, and clearing them after a declined edit would
  // lose the user's markup with nothing to show for it.
  const handleRedactFile = useCallback(
    async (path: string, regions: { page: number; rect: [number, number, number, number] }[]): Promise<boolean> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      return (await performOperation(path, 'redact', { regions })) !== EDIT_DECLINED;
    },
    [state.files, performOperation],
  );

  // Persist the pending marks as the file's /Redact set — undoable,
  // same snapshot→engine→reload shape as apply. The reload's buffer change
  // clears the transient marks and the re-seed loads them back from the
  // file, so state and file agree by construction.
  const handleSaveRedactionMarks = useCallback(
    async (path: string, regions: { page: number; rect: [number, number, number, number] }[]) => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      // Saving marks writes /Redact annotations and removes nothing yet, so
      // it is annotate-class in the roster; applying them is the content change.
      await performOperation(path, 'save_redaction_marks', { regions });
    },
    [state.files, performOperation],
  );

  // An address this app will not open is still an address the user wants.
  // One implementation, so every "we don't open this — here it is" path
  // reports a clipboard failure the same way.
  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        await showNotice(
          tChrome('app.formButton.title'),
          tChrome('app.formButton.clipboardFailed'),
        );
      }
    },
    [showNotice],
  );

  // A widget's data action, fired by the gesture the document authored it on.
  //
  // Every kind that carries no code RUNS: go-to navigates, reset and show/hide
  // and import are engine ops (undoable through the ordinary snapshot), and
  // submit builds the submission in full and then ASKS whether to send it.
  //
  // The submit arm is the app's only outbound-request path, and every step of
  // it is a person's: the document supplies an address, the app builds the
  // payload, the consent dialog shows both, and one click on chrome the app
  // drew is what transmits. The answer is never remembered. A `/URI` is still
  // not opened — there is no general shell-open surface for a
  // document-supplied string to reach — and a script, a go-to into another
  // file and an action this build does not know are reported by name and run
  // nothing.
  //
  // Reaching here at all requires the gesture the document AUTHORED on a
  // widget: this handler is called from the widget overlay's pointer, focus
  // and blur handlers and from nowhere else. No script path exists to it
  // because no script runs — `engine/document_js.py` states that the app
  // never executes document JavaScript, `lib/af-script.ts` only READS what a
  // field's scripts say, and the `javascript` action kind is reported by name
  // in the case below rather than run.
  const handleWidgetAction = useCallback(
    async (path: string, fieldName: string, action: WidgetAction | null) => {
      if (!action) {
        await showNotice(
          tChrome('app.formButton.title'),
          tChrome('app.formButton.noAction', { field: fieldName }),
        );
        return;
      }
      switch (action.kind) {
        case 'goto': {
          if (action.page === null) {
            await showNotice(
              tChrome('app.formButton.title'),
              tChrome('app.formButton.gotoUnresolved', { field: fieldName }),
            );
            return;
          }
          // Ids are opaque, so the jump resolves the page NUMBER against live
          // workspace state rather than building one.
          const landed = getCanvasServices()?.jumpToFilePage(path, action.page + 1) ?? false;
          if (!landed) {
            await showNotice(
              tChrome('app.formButton.title'),
              tChrome('app.formButton.gotoUnresolved', { field: fieldName }),
            );
          }
          return;
        }
        case 'reset': {
          const params: Record<string, unknown> = {};
          if (action.fields) params.fields = action.fields;
          if (action.exclude) params.exclude = true;
          params.font_dir = await app.getEditFontPath();
          await performOperation(path, 'reset_form_fields', params);
          return;
        }
        case 'hide': {
          if (action.targets.length === 0) return;
          // A visibility change writes the annotation's own /F bit: the page
          // raster is drawn from the file, so a widget hidden only in memory
          // is still on the page every other reader sees. Annotate-class.
          await performOperation(path, 'set_widget_visibility', {
            targets: action.targets,
            hide: action.hide,
          });
          return;
        }
        case 'import': {
          // The action names a file; this app asks the user instead, so a
          // document can never make it read a path nobody chose. The authored
          // name is shown so the user can find the right file.
          const proceed = await showProceedConfirm(
            tChrome('app.formButton.importTitle'),
            tChrome('app.formButton.import', {
              field: fieldName,
              file: action.file || tChrome('app.formButton.importNoFile'),
            }),
          );
          if (!proceed) return;
          const chosen = await dialog.pickFormDataFile();
          if (!chosen) return;
          await performOperation(path, 'import_form_data', {
            data: chosen,
            font_dir: await app.getEditFontPath(),
          });
          return;
        }
        case 'submit': {
          const f = state.files.get(path);
          if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
          const stem = (f.name || 'form').replace(/\.pdf$/i, '');
          // A destination this app has no transport for — an empty address, a
          // `mailto:`, anything that is not http(s). The payload is still
          // built and can still be saved: the refusal is about the transport,
          // never about the submission.
          const refusalKey = destinationRefusal(action.url);
          const proceed = await showProceedConfirm(
            tChrome('app.formButton.submitTitle'),
            refusalKey
              ? tChrome(refusalKey, { field: fieldName })
              : tChrome('app.formButton.submit', {
                  field: fieldName,
                  url: action.url,
                  format: action.format,
                }),
          );
          if (!proceed) return;
          // The payload is built to the app's own temp tree FIRST, because the
          // consent dialog shows that file's bytes: a preview assembled from
          // anything else would be a second answer to what gets transmitted.
          //
          // Read-only against the document, so it takes the gated call and
          // writes its payload beside — never through performOperation, which
          // would replace the file with its own submission.
          const payloadPath = await app.netPayloadPath(
            `${stem}-submission`,
            SUBMIT_EXTENSION[action.format].slice(1),
          );
          const built = (await call('export_form_data', {
            file: f.workingPath,
            output: payloadPath,
            format: action.format,
            ...(action.fields ? { fields: action.fields, exclude: action.exclude } : {}),
            include_empty: action.includeEmpty,
          })) as unknown as { count?: number };

          /** The pre-transmit behaviour, kept: the built submission handed
           * over as a file, with its destination offered to the clipboard. */
          const saveBuiltCopy = async (): Promise<void> => {
            const target = await dialog.saveFormDataFile(
              `${stem}${SUBMIT_EXTENSION[action.format]}`,
            );
            if (!target) return;
            await batch.copyFile(payloadPath, target);
            const copy = await showProceedConfirm(
              tChrome('app.formButton.submitBuiltTitle'),
              tChrome('app.formButton.submitBuilt', { file: target, url: action.url }),
            );
            if (copy) await copyToClipboard(action.url);
          };

          if (refusalKey) {
            await saveBuiltCopy();
            return;
          }

          const answer = await showSubmitConsent(
            fieldName,
            action.url,
            action.format,
            action.method,
            payloadPreview(action.format, await app.netPayloadBytes(payloadPath)),
            built.count ?? 0,
          );
          if (answer === 'cancel') return;
          if (answer === 'save') {
            await saveBuiltCopy();
            return;
          }

          let response;
          try {
            response = await app.netRequest(
              submitRequest(action, payloadPath, `${stem}-reply`),
            );
          } catch (error) {
            await showNotice(
              tChrome('app.formButton.submitFailedTitle'),
              tChrome('app.formButton.submitFailed', {
                url: action.url,
                detail: String(error),
              }),
            );
            return;
          }

          /** The reply as a file the user keeps — the door that interprets
           * nothing. An HTML reply always lands here: this app never renders a
           * page it was sent. */
          const saveReply = async (): Promise<void> => {
            const suffix = response.path.slice(response.path.lastIndexOf('.'));
            const target = await dialog.saveFormDataFile(`${stem}-reply${suffix}`);
            if (!target) return;
            await batch.copyFile(response.path, target);
            await showNotice(
              tChrome('app.formButton.submitSentTitle'),
              tChrome('app.formButton.submitReplySaved', { file: target }),
            );
          };

          if (!statusAccepted(response.status)) {
            await showNotice(
              tChrome('app.formButton.submitFailedTitle'),
              tChrome('app.formButton.submitRejected', {
                url: action.url,
                status: response.status,
              }),
            );
            if (response.bytes > 0) await saveReply();
            return;
          }
          if (response.bytes === 0) {
            await showNotice(
              tChrome('app.formButton.submitSentTitle'),
              tChrome('app.formButton.submitEmptyReply', { url: action.url }),
            );
            return;
          }
          // Everything below routes UNTRUSTED bytes into a door this app
          // already has, and every door asks first. Nothing executes.
          switch (responseRoute(response.contentType)) {
            case 'formData': {
              const importIt = await showProceedConfirm(
                tChrome('app.formButton.submitSentTitle'),
                tChrome('app.formButton.submitFormDataReply', {
                  url: action.url,
                  bytes: response.bytes,
                }),
              );
              if (!importIt) return;
              await performOperation(path, 'import_form_data', {
                data: response.path,
                font_dir: await app.getEditFontPath(),
              });
              return;
            }
            case 'document': {
              const openIt = await showProceedConfirm(
                tChrome('app.formButton.submitSentTitle'),
                tChrome('app.formButton.submitDocumentReply', {
                  url: action.url,
                  bytes: response.bytes,
                }),
              );
              if (!openIt) return;
              await openByPaths([response.path]);
              return;
            }
            default: {
              const saveIt = await showProceedConfirm(
                tChrome('app.formButton.submitSentTitle'),
                tChrome('app.formButton.submitFileReply', {
                  url: action.url,
                  bytes: response.bytes,
                  type:
                    response.contentType ||
                    tChrome('app.formButton.submitFileReplyUnknown'),
                }),
              );
              if (!saveIt) return;
              await saveReply();
              return;
            }
          }
        }
        case 'uri': {
          const copy = await showProceedConfirm(
            tChrome('app.formButton.externalTitle'),
            tChrome('app.formButton.uri', { field: fieldName, uri: action.uri }),
          );
          if (copy) await copyToClipboard(action.uri);
          return;
        }
        case 'javascript':
          await showNotice(
            tChrome('app.formButton.title'),
            tChrome('app.formButton.javascript', { field: fieldName }),
          );
          return;
        case 'remote':
          await showNotice(
            tChrome('app.formButton.title'),
            tChrome('app.formButton.remote', {
              field: fieldName,
              file: action.file || tChrome('app.formButton.importNoFile'),
            }),
          );
          return;
        case 'named':
          await showNotice(
            tChrome('app.formButton.title'),
            tChrome('app.formButton.named', { field: fieldName, action: action.name }),
          );
          return;
        default:
          await showNotice(
            tChrome('app.formButton.title'),
            tChrome('app.formButton.unsupported', { field: fieldName }),
          );
      }
    },
    [
      state.files,
      call,
      performOperation,
      showNotice,
      showProceedConfirm,
      showSubmitConsent,
      openByPaths,
      copyToClipboard,
    ],
  );

  // Link authoring writes /Link annotations, so every link method is
  // annotate-class in the roster: the incremental tier preserves it, and only
  // a certification that forbids commenting has anything to say about it.
  // EVERY link mutation routes through this one function — the canvas
  // gesture, the panel's Create, a retarget, a restyle, a delete — so the
  // four share one shape and one return contract.
  const runLinkEdit = useCallback(
    async (path: string, method: OpMethod, params: Record<string, unknown>): Promise<boolean> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      return (await performOperation(path, method, params)) !== EDIT_DECLINED;
    },
    [state.files, performOperation],
  );

  const handleAddLinks = useCallback(
    async (path: string, links: LinkSpec[]) => {
      await runLinkEdit(path, 'add_links', { links });
    },
    [runLinkEdit],
  );

  const handleFillFormValues = useCallback(
    async (path: string, values: Record<string, FormFieldValue>) => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      // Pre/post reads route through the engine — `read_form_fields` is
      // INTERNAL, so neither read runs the commit gate. The pre-read sees the
      // current working copy (== buffer); `file.snapshot` then flushes pending
      // page edits, and the post-read sees those committed bytes, so the
      // fingerprint/rename-family re-resolution below still detects an import
      // carry's field rename exactly as with the old pdf-lib read. It happens
      // BEFORE the signed-edit question because that question has to be asked
      // about the TRANSITIVE set — filling an unlocked line item that
      // recalculates a locked Total produces a document reporting as altered,
      // and a decision taken on the typed names alone would never see it.
      const pre = f.buffer ? await readFormFields(call, f.workingPath) : null;
      const preFields = pre?.fields ?? [];
      const typed = Object.keys(values);
      const targets = pre
        ? fillClosure(formCalculation(pre.fields, pre.calculationOrder), typed)
        : typed;
      if (!(await confirmEditOfSignedDoc(path, f.workingPath, 'form-fill', targets, typed))) return;
      const snapshotPath = await file.snapshot(f.workingPath);
      const postFields = (await readFormFields(call, f.workingPath)).fields;
      const { resolved, skipped } = resolveFillTargets(preFields, postFields, values);
      if (skipped.length > 0) {
        throw new Error(skipped.map((s) => `"${s.name}": ${s.reason}`).join('; '));
      }
      // Route the fill through the ENGINE — Unicode-capable
      // (embeds a font for non-WinAnsi values) and multi-select-optionlist
      // aware. Read (above) and fill are now one engine implementation;
      // `resolveFillTargets`' fingerprint/rename-family machinery is unchanged.
      // The snapshot already flushed pending edits, and `call` is commit-gated
      // for `fill_form_fields`, so the engine reads the committed bytes.
      const fillReport = await call('fill_form_fields', {
        file: f.workingPath,
        output: f.workingPath,
        edits: resolved,
        font_dir: await app.getEditFontPath(),
      });
      // The fill's own report, read rather than discarded. The engine refuses
      // an inconsistent fill atomically, so what is left to check is that the
      // success path accounts for every field this call named — the on-canvas
      // fill has no other evidence, and a silent shortfall is announced as a
      // completed fill.
      const outcome = classifyFillResult(fillReport, Object.keys(resolved).length);
      // The reload runs on both paths: the document changed on disk, and the
      // refreshed bytes are what the refusal tells the caller to trust.
      const result = await reloadFile(path);
      if (!result) throw new Error(tChrome('refusal.file.noLongerOpen'));
      dispatch({
        type: 'UPDATE_FILE',
        path,
        pageCount: result.pageCount,
        buffer: result.buffer,
        snapshotPath,
      });
      if (outcome.kind === 'refused') {
        throw new Error(
          outcome.refusal.kind === 'incomplete'
            ? tChrome('panel.forms.fillIncomplete', {
                named: outcome.refusal.requested,
                written: outcome.refusal.filled,
              })
            : tChrome('panel.forms.fillUnverified'),
        );
      }
    },
    [state.files, reloadFile, dispatch, call, confirmEditOfSignedDoc],
  );

  // One snapshot, one write, one reload — so N accepted fields are ONE undo
  // entry rather than N. The single-field placement path calls it with one
  // spec; there is no second creation path.
  //
  // A VERTICAL field takes a second write: pdf-lib cannot author the
  // CID-keyed font a column needs, so the field is created here and BOUND by
  // the engine door, one call per script. Both writes land inside the single
  // snapshot/reload/UPDATE_FILE pair — the pair is what makes the gesture one
  // undo entry, and splitting it would put a horizontal half-field on the
  // stack. A refusal from the door restores the snapshot before it rethrows,
  // so a create that could not become a column leaves nothing behind.
  const handleAddFormFields = useCallback(
    async (path: string, specs: readonly NewFieldSpec[]) => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      // Creating a field authors form STRUCTURE, not a value: pdf-lib's save
      // coalesces the file, so every byte range breaks and no certification
      // level carries it. Asked BEFORE the snapshot — `file.snapshot` runs the
      // commit gate, so asking after would flush pending page edits on the way
      // to refusing this one.
      if (!(await confirmEditOfSignedDoc(path, f.workingPath, 'structural'))) return EDIT_DECLINED;
      const snapshotPath = await file.snapshot(f.workingPath);
      const bytes = await file.readBuffer(f.workingPath);
      const withFields = await addFormFields(bytes, specs);
      await file.writeBuffer(f.workingPath, withFields);
      const vertical = verticalFontCalls(specs);
      const choices = choiceAppearanceFields(specs);
      if (vertical.length > 0 || choices.length > 0) {
        const fontDir = await app.getEditFontPath();
        try {
          for (const bind of vertical) {
            await call('author_vertical_field_font', {
              file: f.workingPath,
              output: f.workingPath,
              fields: bind.fields,
              script: bind.script,
              font_dir: fontDir,
            });
          }
          // After the vertical bind, never before: a list's writing mode is
          // stated by the font its /DA names, so the appearance door has to
          // read the /DA the bind wrote to draw rows as columns.
          if (choices.length > 0) {
            await call('author_choice_appearance', {
              file: f.workingPath,
              output: f.workingPath,
              fields: choices,
              font_dir: fontDir,
            });
          }
        } catch (err) {
          await file.restoreSnapshot(f.workingPath, snapshotPath);
          throw err;
        }
      }
      const result = await reloadFile(path);
      if (!result) throw new Error(tChrome('refusal.file.noLongerOpen'));
      dispatch({
        type: 'UPDATE_FILE',
        path,
        pageCount: result.pageCount,
        buffer: result.buffer,
        snapshotPath,
      });
    },
    [state.files, reloadFile, dispatch, call, confirmEditOfSignedDoc],
  );

  const handleAddFormField = useCallback(
    async (path: string, spec: NewFieldSpec) => handleAddFormFields(path, [spec]),
    [handleAddFormFields],
  );

  // Removing hidden information is a full rewrite by construction: collapsing
  // prior revisions is what drops content an earlier revision still holds, and
  // an incremental append would add a revision rather than remove one. On a
  // signed document that breaks the signatures, so the count the report
  // measured is named BEFORE the choice rather than after it. A certified
  // document states what may change in it, and this changes more than any
  // level permits, so it says so distinctly — and still proceeds, because a
  // tool that refuses to clean a file before it is sent out has failed at the
  // job it exists for.
  const handleSanitizeDocument = useCallback(
    async (path: string, request: SanitizeRequest): Promise<boolean> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      const signed = request.signatures.count + request.signatures.document_timestamps;
      if (signed > 0) {
        const certified = request.signatures.certification !== null;
        const proceed = await showProceedConfirm(
          tChrome(certified ? 'app.sanitize.certifiedTitle' : 'app.sanitize.title'),
          tChromeCount(certified ? 'app.sanitize.certified' : 'app.sanitize.signed', signed),
        );
        if (!proceed) return false;
      }
      await performOperation(path, 'sanitize_pdf', {
        categories: request.categories,
        form_fields_mode: request.formFieldsMode,
        hidden_text_ocr: request.includeOcrLayer,
      });
      return true;
    },
    [state.files, performOperation, showProceedConfirm],
  );

  // The preparer's half of field locking: the seed an UNSIGNED signature field
  // carries, which whoever signs it later is bound by. Writing it rewrites the
  // file, so it is decided as a structural edit like every other one — and
  // `allow_signed` says the decision was already taken here rather than making
  // the engine take it a second time with no way to consent.
  const handleSetFieldLock = useCallback(
    async (path: string, field: string, lock: FieldLock | null): Promise<boolean> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      const r = await performOperation(path, 'set_field_lock', {
        field,
        allow_signed: true,
        ...(lock === null
          ? {}
          : { lock: lock.action, lock_fields: lockNeedsFields(lock.action) ? lock.fields : [] }),
      });
      return r !== EDIT_DECLINED;
    },
    [state.files, performOperation],
  );

  const handleSetFieldActions = useCallback(
    async (
      path: string,
      field: string,
      actions: FieldActions | null,
      data?: AuthoredAction[],
    ): Promise<boolean> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      // The door is total over what it is ASKED about and inert about the
      // rest. `clear` names the members this call addresses, because the wire
      // cannot distinguish an omitted member from "leave it": passing
      // `actions` takes over the value half, passing `data` takes over every
      // data trigger, and a null/absent half leaves the document's own alone.
      // A button edit must not silently destroy a script it never mentioned.
      const r = await performOperation(path, 'set_field_actions', {
        field,
        allow_signed: true,
        clear: [
          ...(actions ? ['format', 'validate', 'calculate', 'default_value'] : []),
          ...(data ? ['actions'] : []),
        ],
        ...(actions?.format ? { format: toEngineFormat(actions.format) } : {}),
        ...(actions?.validate ? { validate: actions.validate } : {}),
        ...(actions?.calculate ? { calculate: actions.calculate } : {}),
        ...(actions?.defaultValue !== undefined ? { default_value: actions.defaultValue } : {}),
        ...(data ? { actions: data.map(toEngineAction) } : {}),
      });
      return r !== EDIT_DECLINED;
    },
    [state.files, performOperation],
  );

  const handleApplyOcrLayer = useCallback(
    async (
      path: string,
      pages: { page: number; words: { text: string; rect: [number, number, number, number] }[] }[],
    ) => {
      await performOperation(path, 'apply_ocr_layer', { pages });
    },
    [performOperation],
  );

  const handleEditText = useCallback(
    async (
      path: string,
      page: number,
      index: number,
      newText: string,
      opts?: { convert?: boolean },
    ): Promise<string | void> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      if (opts?.convert) {
        // Render the replacement in the bundled fallback
        // font FAMILY — getEditFontPath returns the fonts DIRECTORY and
        // the engine picks the face (serif/sans/mono) matching the run's
        // own font. The path the editor offers when the run's own font
        // can't express the typed characters.
        const fontPath = await app.getEditFontPath();
        const converted = await performOperation(path, 'convert_text_run', {
          page,
          index,
          new_text: newText,
          font_path: fontPath,
        });
        if (converted === EDIT_DECLINED) return EDIT_DECLINED;
        return;
      }
      const r = await performOperation(path, 'replace_text_run', { page, index, new_text: newText });
      if (r === EDIT_DECLINED) return EDIT_DECLINED;
    },
    [state.files, performOperation],
  );

  // Run-scoped size/color restyle — same signed-doc gate, text unchanged.
  const handleRestyleText = useCallback(
    async (
      path: string,
      page: number,
      index: number,
      style: { size?: number; color?: [number, number, number] },
    ): Promise<string | void> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      const r = await performOperation(path, 'restyle_text_run', {
        page,
        index,
        ...(style.size != null ? { size: style.size } : {}),
        ...(style.color ? { color: style.color } : {}),
      });
      if (r === EDIT_DECLINED) return EDIT_DECLINED;
    },
    [state.files, performOperation],
  );

  const handleEditParagraph = useCallback(
    async (
      path: string,
      page: number,
      para: { index: number; runs: number[]; text: string },
      newText: string,
      spans: { start: number; end: number; run: number }[],
      opts?: ParagraphEditOpts,
    ): Promise<string | void> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      // The fingerprint (member runs + logical text) makes the engine
      // re-derive its grouping and REFUSE if the page changed underneath —
      // a heuristic must never silently retarget.
      const params: Record<string, unknown> = {
        page,
        paragraph_index: para.index,
        new_text: newText,
        spans,
        expected_runs: para.runs,
        expected_text: para.text,
      };
      // restyle: uniform size (points) / fill colour ([r,g,b] 0-1).
      if (opts?.size !== undefined) params.size = opts.size;
      if (opts?.color !== undefined) params.color = opts.color;
      // substitution: the whole paragraph re-renders in the chosen
      // bundled face (family and/or absolute bold/italic pair).
      if (opts?.family !== undefined) params.family = opts.family;
      if (opts?.bold !== undefined) params.bold = opts.bold;
      if (opts?.italic !== undefined) params.italic = opts.italic;
      // split: a code-point offset — the engine lays out two blocks.
      if (opts?.split_at !== undefined) params.split_at = opts.split_at;
      // A user-chosen split gap (leading multiples) and/or an explicit
      // box resize (points; box_left rides when the LEFT grip dragged).
      if (opts?.split_gap !== undefined) params.split_gap = opts.split_gap;
      if (opts?.box_width !== undefined) params.box_width = opts.box_width;
      if (opts?.box_left !== undefined) params.box_left = opts.box_left;
      if (opts?.convert) params.convert = true;
      // Whole-paragraph OpenType features (small caps / alternates). The
      // engine applies them in place when the paragraph's own font carries the
      // feature, else switches to Libertinus Serif. Per-span features ride
      // span_styles below.
      if (opts?.features !== undefined) params.features = opts.features;
      if (opts?.alt_index !== undefined) params.alt_index = opts.alt_index;
      // Per-span overrides ride ONE span_styles list (colour,
      // face, and size fold independently in the engine). Forward it verbatim
      // — dropping it silently reverts a per-span edit to a plain re-typeset.
      if (opts?.span_styles !== undefined) params.span_styles = opts.span_styles;
      // The bundled fallback faces: convert renders only the
      // characters the mapped fonts cannot express; a substitution re-renders
      // every character. Either way the engine resolves the face from the
      // fonts DIRECTORY.
      // Sent UNCONDITIONALLY now — kerning reads the document's own
      // font, and a non-embedded standard-14 reaches its kern data through
      // the metric twin in that directory. Gating this on substitution would
      // kern some documents and silently not others.
      params.font_path = await app.getEditFontPath();
      const r = await performOperation(path, 'replace_paragraph_text', params);
      if (r === EDIT_DECLINED) return EDIT_DECLINED;
    },
    [state.files, performOperation],
  );

  // merge: one engine op, one undo step; both fingerprints ride so the
  // engine refuses a stale view. Structural-class like every content edit.
  const handleMergeParagraph = useCallback(
    async (
      path: string,
      page: number,
      prev: { index: number; runs: number[]; text: string },
      cur: { index: number; runs: number[]; text: string },
      // `withNext` merges cur (the NEXT paragraph) into prev (the
      // SELECTED one — prev is always the anchor slot); an edited editor
      // rides its text in as the selected side's override with the span
      // map the replace path would have sent.
      opts?: {
        withNext?: boolean;
        overrideText?: string;
        overrideSpans?: { start: number; end: number; run: number }[];
        restyle?: import('./lib/edit-paragraphs').MergeRestyle;
      },
    ): Promise<string | void> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      const r = await performOperation(path, 'merge_paragraph_with_previous', {
        page,
        // The engine addresses the SELECTED paragraph: for the shipped
        // previous-merge that is cur (it merges upward); for with_next it
        // is prev (the next merges into it).
        paragraph_index: opts?.withNext ? prev.index : cur.index,
        expected_prev_runs: prev.runs,
        expected_prev_text: prev.text,
        expected_runs: cur.runs,
        expected_text: cur.text,
        ...(opts?.withNext ? { with_next: true } : {}),
        // Whole-paragraph restyle riding the merge (same
        // semantics as replace, same engine pipeline).
        ...(opts?.restyle?.size !== undefined ? { size: opts.restyle.size } : {}),
        ...(opts?.restyle?.color !== undefined ? { color: opts.restyle.color } : {}),
        ...(opts?.restyle?.family !== undefined ? { family: opts.restyle.family } : {}),
        ...(opts?.restyle?.bold !== undefined ? { bold: opts.restyle.bold } : {}),
        ...(opts?.restyle?.italic !== undefined ? { italic: opts.restyle.italic } : {}),
        ...(opts?.overrideText !== undefined
          ? {
              selected_text_override: opts.overrideText,
              selected_spans_override: opts.overrideSpans,
            }
          : {}),
        // A merge re-lays-out text too, so it needs the same kern
        // source an edit gets.
        font_path: await app.getEditFontPath(),
      });
      if (r === EDIT_DECLINED) return EDIT_DECLINED;
    },
    [state.files, performOperation],
  );

  // Add Text: author a NEW text object at `rect` (PDF user-space points,
  // bottom-up — buildSignatureAppearance's output). Engine `add_text_box`
  // subset-embeds a bundled face, so the result is searchable and
  // re-editable by the run and paragraph editors with no special case. Undoable via performOperation;
  // refuses on a signed doc like every other content edit.
  const handleAddText = useCallback(
    async (
      path: string,
      page: number,
      rect: [number, number, number, number],
      text: string,
      opts?: {
        size?: number;
        color?: [number, number, number];
        family?: 'serif' | 'sans' | 'mono';
        rotate?: number;
        bold?: boolean;
        italic?: boolean;
        /** Pair kerning. Defaults ON engine-side, so only an explicit
         * opt-OUT is ever sent. */
        kern?: boolean;
        /** OpenType features — ['small_caps'] and/or ['salt']. Authoring
         * always renders in a bundled face, so a feature switches to Libertinus
         * Serif (Liberation has none); alt_index picks the salt alternate. */
        features?: string[];
        /** Per-span styling over the text's character positions. `tcy`
         * marks a tate-chu-yoko block: upright inside a column, one em. */
        spans?: {
          start: number;
          end: number;
          size?: number;
          color?: [number, number, number];
          bold?: boolean;
          italic?: boolean;
          tcy?: boolean;
        }[];
        alt_index?: number;
        /** Writing mode — `vertical` derives its column direction from the
         * text; horizontal is the engine default and never travels. */
        writingMode?: 'horizontal' | 'vertical' | 'vertical-rl' | 'vertical-lr';
      },
    ): Promise<string | void> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      const params: Record<string, unknown> = {
        page,
        rect,
        text,
        font_path: await app.getEditFontPath(),
      };
      if (opts?.size !== undefined) params.size = opts.size;
      if (opts?.color !== undefined) params.color = opts.color;
      if (opts?.family !== undefined) params.family = opts.family;
      if (opts?.rotate !== undefined) params.rotate = opts.rotate;
      if (opts?.bold !== undefined) params.bold = opts.bold;
      if (opts?.italic !== undefined) params.italic = opts.italic;
      if (opts?.kern === false) params.kern = false;
      if (opts?.features !== undefined && opts.features.length > 0) params.features = opts.features;
      if (opts?.alt_index !== undefined) params.alt_index = opts.alt_index;
      if (opts?.spans !== undefined && opts.spans.length > 0) params.spans = opts.spans;
      if (opts?.writingMode !== undefined && opts.writingMode !== 'horizontal') {
        params.writing_mode = opts.writingMode;
      }
      const r = await performOperation(path, 'add_text_box', params);
      if (r === EDIT_DECLINED) return EDIT_DECLINED;
    },
    [state.files, performOperation],
  );

  // Delete, transform (move/resize/rotate), or restyle (recolour /
  // line-width) one vector path object. Same undoable snapshot/commit-gate flow
  // as an image edit (structural-class), just a different engine op.
  const handleEditVector = useCallback(
    async (
      kind: 'delete' | 'transform' | 'restyle',
      path: string,
      page: number,
      index: number,
      opts?: {
        matrix?: number[];
        fill?: [number, number, number];
        stroke?: [number, number, number];
        lineWidth?: number;
      },
    ): Promise<string | void> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      if (kind === 'transform') {
        if (!opts?.matrix) throw new Error('transform requires a target matrix');
        const r = await performOperation(path, 'transform_page_vector', { page, index, matrix: opts.matrix });
        if (r === EDIT_DECLINED) return EDIT_DECLINED;
        return;
      }
      if (kind === 'restyle') {
        const params: Record<string, unknown> = { page, index };
        if (opts?.fill) params.fill = opts.fill;
        if (opts?.stroke) params.stroke = opts.stroke;
        if (opts?.lineWidth !== undefined) params.line_width = opts.lineWidth;
        const r = await performOperation(path, 'restyle_page_vector', params);
        if (r === EDIT_DECLINED) return EDIT_DECLINED;
        return;
      }
      const r = await performOperation(path, 'delete_page_vector', { page, index });
      if (r === EDIT_DECLINED) return EDIT_DECLINED;
    },
    [state.files, performOperation],
  );

  // --- Edit ▸ Images ----------------------------------------------------
  // One handler, three actions. Mutations route through performOperation
  // (gate → snapshot → engine → reload → undoable); extract is a gated read
  // that writes a NEW image file where the user chose. `opts` lets the e2e
  // harness inject what the native dialogs would collect.
  const handleEditImage = useCallback(
    async (
      kind: 'delete' | 'replace' | 'extract' | 'transform' | 'crop' | 'opacity',
      path: string,
      page: number,
      index: number,
      opts?: {
        source?: ReplacementSource;
        outputPrefix?: string;
        matrix?: number[];
        rect?: [number, number, number, number];
        opacity?: number;
        blend?: string;
        mask?: EditImageMaskParam;
      },
    ) => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));

      // Every mutating kind but `replace` runs through performOperation and
      // is decided there by its roster class. `replace` is the deliberate
      // exception: it holds ONE snapshot across a passthrough-then-raw retry
      // (two performOperation calls would snapshot twice and leak a copy on
      // every CMYK fallback), so it keeps its own guard — the shape is
      // bespoke, not the decision.
      if (kind === 'replace' && !(await confirmEditOfSignedDoc(path, f.workingPath, 'structural'))) {
        return EDIT_DECLINED;
      }

      if (kind === 'delete') {
        const r = await performOperation(path, 'delete_page_image', { page, index });
        if (r === EDIT_DECLINED) return EDIT_DECLINED;
        return;
      }

      if (kind === 'transform') {
        // Rewrite the placement's CTM to the gesture's target matrix.
        // User-space M' is invariant to /Rotate, so no rotation re-projection
        // is needed here (unlike signature placement).
        if (!opts?.matrix) throw new Error('transform requires a target matrix');
        const r = await performOperation(path, 'transform_page_image', { page, index, matrix: opts.matrix });
        if (r === EDIT_DECLINED) return EDIT_DECLINED;
        return;
      }

      if (kind === 'crop') {
        // rect is the crop in the image's UNIT space — depth- and
        // rotation-invariant by construction (the engine emits it as a clip
        // at the draw), so like transform it needs no re-projection.
        if (!opts?.rect) throw new Error('crop requires a rect');
        const r = await performOperation(path, 'crop_page_image', { page, index, rect: opts.rect });
        if (r === EDIT_DECLINED) return EDIT_DECLINED;
        return;
      }

      if (kind === 'opacity') {
        // Uniform placement opacity via a page-local ExtGState.
        // The same frame carries the blend mode and/or a gradient soft
        // mask — any combination; the engine merges into ONE frame.
        if (
          opts?.opacity === undefined &&
          opts?.blend === undefined &&
          opts?.mask === undefined
        ) {
          throw new Error('opacity requires a value, a blend mode, or a mask');
        }
        const r = await performOperation(path, 'set_image_opacity', {
          page,
          index,
          ...(opts.opacity !== undefined ? { opacity: opts.opacity } : {}),
          ...(opts.blend !== undefined ? { blend: opts.blend } : {}),
          ...(opts.mask !== undefined ? { mask: opts.mask } : {}),
        });
        if (r === EDIT_DECLINED) return EDIT_DECLINED;
        return;
      }

      if (kind === 'replace') {
        let source = opts?.source ?? null;
        let pickedPath: string | null = null;
        if (!source) {
          pickedPath = await dialog.pickImageFile();
          if (!pickedPath) return;
          if (isJpegPath(pickedPath)) {
            // EXIF-rotated photos must NOT passthrough: PDF viewers render
            // the sensor pixel grid and ignore EXIF, so a portrait phone
            // photo would land sideways. Route those to the decode path,
            // where the webview applies the rotation (regression).
            const head = await batch.readFileBuffer(pickedPath);
            if (jpegExifOrientation(head) === 1) source = { jpeg_path: pickedPath };
          }
        }
        // ONE snapshot for the whole attempt — the passthrough-then-raw
        // retry lives INSIDE it. Two performOperation calls would snapshot
        // twice and leak the first copy on every CMYK fallback
        // (regression); this is performOperation's exact shape with the
        // retry between snapshot and reload.
        const tempFiles: string[] = [];
        const writeTemp = async (data: Uint8Array): Promise<string> => {
          const dir = f.workingPath.replace(/[\\/][^\\/]+$/, '');
          const sep = f.workingPath.includes('\\') ? '\\' : '/';
          const p = `${dir}${sep}replace-${crypto.randomUUID()}.raw`;
          await file.writeBuffer(p, data);
          tempFiles.push(p);
          return p;
        };
        try {
          const snapshotPath = await file.snapshot(f.workingPath);
          // The replacement letterboxes into the old frame
          // (aspect preserved, centered) instead of stretching — the engine
          // emits a recognized transform frame, so later moves fold it.
          const params = {
            file: f.workingPath,
            output: f.workingPath,
            page,
            index,
            fit: 'contain',
          };
          if (source) {
            try {
              await call('replace_page_image', { ...params, source });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (!(pickedPath && engineWantsRawFallback(msg))) throw err;
              source = null; // passthrough refused — decode below
            }
          }
          if (!source) {
            const bytes = await batch.readFileBuffer(pickedPath!);
            const raw = await decodeToRawSource(bytes, writeTemp);
            await call('replace_page_image', { ...params, source: raw });
          }
          const result = await reloadFile(path);
          if (result) {
            dispatch({
              type: 'UPDATE_FILE',
              path,
              pageCount: result.pageCount,
              buffer: result.buffer,
              snapshotPath,
            });
          }
        } finally {
          for (const p of tempFiles) void file.remove(p).catch(() => {});
        }
        return;
      }

      if (kind === 'extract') {
        // The listing indexes must describe COMMITTED bytes (extract is not
        // a trackable op, so gate explicitly — the PrintDialog rule).
        await runCommitGate();
        let prefix = opts?.outputPrefix ?? null;
        if (!prefix) {
          const dest = await dialog.saveImageFile('image');
          if (!dest) return;
          prefix = dest.replace(/\.(png|jpe?g|tiff?|bmp)$/i, '');
        }
        const r = await call('extract_page_image', {
          file: f.workingPath,
          page,
          index,
          output_prefix: prefix,
        });
        // The engine appends the encoding's REAL extension — surface the
        // actual filename so "photo.png" quietly becoming photo.jpg is
        // seen, not suffered (regression).
        const out = (r as unknown as { output?: string }).output;
        return out ? `Saved ${out.split(/[\\/]/).pop()}` : undefined;
      }
    },
    [state.files, call, performOperation, reloadFile, dispatch, confirmEditOfSignedDoc],
  );

  // Multi-select: group transform/delete over N placements on one page —
  // ONE engine call, one snapshot, one undo entry (the whole point of the
  // engine's multi ops; N single calls would churn N undo entries and N page
  // rebuilds for one gesture).
  const handleEditImagesGroup = useCallback(
    async (
      kind: 'transform' | 'delete',
      path: string,
      page: number,
      opts: { targets?: { index: number; matrix: number[] }[]; indexes?: number[] },
    ): Promise<string | void> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      if (kind === 'transform') {
        if (!opts.targets?.length) throw new Error('group transform requires targets');
        const r = await performOperation(path, 'transform_page_images', { page, targets: opts.targets });
        if (r === EDIT_DECLINED) return EDIT_DECLINED;
        return;
      }
      if (!opts.indexes?.length) throw new Error('group delete requires indexes');
      const r = await performOperation(path, 'delete_page_images', { page, indexes: opts.indexes });
      if (r === EDIT_DECLINED) return EDIT_DECLINED;
    },
    [state.files, performOperation],
  );

  // Add Image: embed a NEW raster at `rect` (PDF user-space points). Picks
  // the file with the SAME EXIF-aware JPEG-passthrough / raw-decode routing as
  // image replace (one snapshot for the whole attempt, incl. the CMYK raw
  // fallback). `injected` lets the harness supply a source (the native picker
  // is undrivable). Undoable; refuses on a signed doc. The added image is an
  // ordinary placement afterward (movable and resizable).
  const handleAddImage = useCallback(
    async (
      path: string,
      page: number,
      rect: [number, number, number, number] | null,
      injected?: AddImageSource,
      at?: [number, number],
    ): Promise<string | void> => {
      const f = state.files.get(path);
      if (!f) throw new Error(tChrome('refusal.file.noLongerOpen'));
      if (!(await confirmEditOfSignedDoc(path, f.workingPath, 'structural'))) return EDIT_DECLINED;

      // An SVG (picked or injected) places as REAL vector
      // content — the engine compiles it into a unit-square form and the
      // result is an ordinary placement (movable, styleable, deletable).
      let svgPath: string | null =
        injected && 'svg_path' in injected ? injected.svg_path : null;
      let source: ReplacementSource | null =
        injected && !('svg_path' in injected) ? injected : null;
      let pickedPath: string | null = null;
      if (!injected) {
        pickedPath = await dialog.pickImageFile(true);
        if (!pickedPath) return; // cancelled — no-op
        if (isSvgPath(pickedPath)) {
          svgPath = pickedPath;
        } else if (isJpegPath(pickedPath)) {
          const head = await batch.readFileBuffer(pickedPath);
          if (jpegExifOrientation(head) === 1) source = { jpeg_path: pickedPath };
        }
      }
      if (svgPath) {
        const snapshotPath = await file.snapshot(f.workingPath);
        await call('add_page_vector_graphic', {
          file: f.workingPath,
          output: f.workingPath,
          page,
          ...(rect ? { rect } : { at }),
          svg_path: svgPath,
        });
        const result = await reloadFile(path);
        if (result) {
          dispatch({
            type: 'UPDATE_FILE',
            path,
            pageCount: result.pageCount,
            buffer: result.buffer,
            snapshotPath,
          });
        }
        return;
      }
      const tempFiles: string[] = [];
      const writeTemp = async (data: Uint8Array): Promise<string> => {
        const dir = f.workingPath.replace(/[\\/][^\\/]+$/, '');
        const sep = f.workingPath.includes('\\') ? '\\' : '/';
        const p = `${dir}${sep}addimg-${crypto.randomUUID()}.raw`;
        await file.writeBuffer(p, data);
        tempFiles.push(p);
        return p;
      };
      try {
        const snapshotPath = await file.snapshot(f.workingPath);
        // A drawn box embeds aspect-honest (fit contain — the
        // engine shrinks the box around its center to the source's aspect);
        // a click (`at`) places at natural size, page-clamped engine-side.
        const params = {
          file: f.workingPath,
          output: f.workingPath,
          page,
          ...(rect ? { rect, fit: 'contain' } : { at }),
        };
        if (source) {
          try {
            await call('add_page_image', { ...params, source });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!(pickedPath && engineWantsRawFallback(msg))) throw err;
            source = null; // passthrough refused — decode below
          }
        }
        if (!source) {
          const bytes = await batch.readFileBuffer(pickedPath!);
          const raw = await decodeToRawSource(bytes, writeTemp);
          await call('add_page_image', { ...params, source: raw });
        }
        const result = await reloadFile(path);
        if (result) {
          dispatch({
            type: 'UPDATE_FILE',
            path,
            pageCount: result.pageCount,
            buffer: result.buffer,
            snapshotPath,
          });
        }
      } finally {
        for (const p of tempFiles) void file.remove(p).catch(() => {});
      }
    },
    [state.files, call, reloadFile, dispatch, confirmEditOfSignedDoc],
  );


  const handleUndo = useCallback(async () => {
    if (state.pageUndoStack.length > 0) {
      dispatch({ type: 'UNDO_PAGE_OP' });
      return;
    }
    if (!activeFile || activeFile.undoStack.length === 0) return;
    const snapshotPath = activeFile.undoStack[activeFile.undoStack.length - 1];
    const redoSnapshot = await file.snapshotRaw(activeFile.workingPath);
    await file.restoreSnapshot(activeFile.workingPath, snapshotPath);
    dispatch({ type: 'UNDO', path: activeFile.path, redoSnapshot });
    const result = await reloadFile(activeFile.path);
    if (result) {
      dispatch({
        type: 'REFRESH_BUFFER',
        path: activeFile.path,
        pageCount: result.pageCount,
        buffer: result.buffer,
      });
    }
  }, [activeFile, state.pageUndoStack.length, reloadFile, dispatch]);

  const handleRedo = useCallback(async () => {
    if (state.pageRedoStack.length > 0) {
      dispatch({ type: 'REDO_PAGE_OP' });
      return;
    }
    if (!activeFile || activeFile.redoStack.length === 0) return;
    const snapshotPath = activeFile.redoStack[activeFile.redoStack.length - 1];
    const undoSnapshot = await file.snapshotRaw(activeFile.workingPath);
    await file.restoreSnapshot(activeFile.workingPath, snapshotPath);
    dispatch({ type: 'REDO', path: activeFile.path, undoSnapshot });
    const result = await reloadFile(activeFile.path);
    if (result) {
      dispatch({
        type: 'REFRESH_BUFFER',
        path: activeFile.path,
        pageCount: result.pageCount,
        buffer: result.buffer,
      });
    }
  }, [activeFile, state.pageRedoStack.length, reloadFile, dispatch]);

  // Run the commit ahead of a dependent step; on failure surface the error
  // and tell the caller to abort (the edits are still pending and retryable).
  const commitOrAbort = useCallback(async (): Promise<boolean> => {
    try {
      await commitIfNeeded();
      return true;
    } catch (err) {
      setCommitError(
        tChrome('app.commit.failedAbort', {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return false;
    }
  }, [commitIfNeeded]);

  const handleSave = useCallback(async () => {
    if (!activeFile) return;
    // A document downloaded from a web address has no file of the user's
    // underneath it — its `path` is a temporary copy — so Save asks where to
    // keep it. The routing is asked of the selector rather than decided here,
    // for the reason the ghost guard exists: a silent write to the wrong path
    // is not a cosmetic failure.
    if (saveRouteFor(activeFile) === 'saveAs') {
      await handleSaveAsRef.current();
      return;
    }
    if (!(await commitOrAbort())) return;
    await file.saveAs(activeFile.workingPath, activeFile.path);
    dispatch({ type: 'MARK_SAVED', path: activeFile.path });
  }, [activeFile, dispatch, commitOrAbort]);

  const handleSaveAs = useCallback(async () => {
    if (!activeFile) return;
    const dest = await saveFile(activeFile.name);
    if (!dest) return;
    // The destination is a bare byte copy over whatever is there. Writing over
    // a file another window has open replaces the bytes under a live document
    // that has no idea, so the destination is claimed like any other path and
    // released again — Save As does not take ownership of what it wrote.
    const { granted, refused } = await claimPaths([dest], 'write');
    if (refused.length > 0) {
      await reportClaimRefusal(refused, 'window');
      return;
    }
    try {
      if (!(await commitOrAbort())) return;
      await file.saveAs(activeFile.workingPath, dest);
      dispatch({ type: 'MARK_SAVED', path: activeFile.path });
    } finally {
      const held = stateRef.current.files;
      void releasePaths(granted.filter((p) => !held.has(p)));
    }
  }, [activeFile, saveFile, dispatch, commitOrAbort, reportClaimRefusal]);

  // Save routes INTO Save As for a downloaded document, and Save As is
  // declared after it. One implementation either way — a second copy of the
  // destination claim and its release is exactly the divergence this avoids.
  const handleSaveAsRef = useRef(handleSaveAs);
  handleSaveAsRef.current = handleSaveAs;

  // File ▸ Send To ▸ Email is a local OS integration. Flush pending page edits
  // and stage a copy of the current working state under the
  // document's real name, and hand it to the default desktop mail client via
  // MAPI. The compose window is the mail client's own — nothing here sends
  // anything by itself; failures (chiefly: no mail client registered) come
  // back fast and named, and are shown rather than swallowed.
  const handleSendToEmail = useCallback(async () => {
    if (!activeFile) return;
    if (!(await commitOrAbort())) return;
    try {
      const staged = await app.stageSendCopy(activeFile.workingPath, activeFile.name);
      await app.sendByEmail(staged);
    } catch (e: unknown) {
      // The engine/OS failure text itself stays verbatim (the slice-D
      // boundary); only the notice's TITLE is ours to translate.
      await showNotice(
        tChrome('app.sendEmail.title'),
        e instanceof Error ? e.message : String(e),
      );
    }
  }, [activeFile, commitOrAbort, showNotice]);

  // Export the active document to an editable Office / web format via the
  // bundled LibreOffice. The engine `call` is commit-gated, so pending page
  // edits flush first and the export reflects what the user sees; the output is
  // a NEW external file (never the workspace copy), so there's no reload/undo
  // entry — like Save As, it produces a file and leaves the document as-is.
  const handleExportDocument = useCallback(
    async (format: string) => {
      if (!activeFile) return;
      const soffice_path = await app.getSofficePath();
      const base = activeFile.name.replace(/\.pdf$/i, '');
      const dest = await saveFile(`${base}.${format === 'xhtml' ? 'xhtml' : format}`);
      if (!dest) return;
      // The queue surfaces success and any LibreOffice failure (missing runtime,
      // a corrupt PDF it can't import) — same channel as every whole-file op.
      await call('export_document', { file: activeFile.workingPath, output: dest, fmt: format, soffice_path });
    },
    [activeFile, saveFile, call],
  );

  // Close file with unsaved changes prompt
  const handleCloseFile = useCallback(async (filePath: string) => {
    const f = state.files.get(filePath);
    if (f && isFileDirty(f)) {
      const result = await showConfirm(tChrome('app.close.unsaved', { name: f.name }));
      if (result === 'cancel') return;
      if (result === 'save') {
        if (!(await commitOrAbort())) return;
        await file.saveAs(f.workingPath, f.path);
      }
    }
    dispatch({ type: 'CLOSE_FILE', path: filePath });
    void releasePaths([filePath]);
  }, [state.files, dispatch, showConfirm, isFileDirty, commitOrAbort]);

  // Close all open files with unsaved changes prompt
  const handleCloseAll = useCallback(async () => {
    const allOpen = Array.from(state.files.values());
    const dirtyFiles = allOpen.filter(isFileDirty);
    if (dirtyFiles.length > 0) {
      const names = dirtyFiles.map((f) => f.name).join(', ');
      const result = await showConfirm(tChrome('app.closeAll.unsaved', { names }));
      if (result === 'cancel') return;
      if (result === 'save') {
        if (!(await commitOrAbort())) return;
        for (const f of dirtyFiles) {
          await file.saveAs(f.workingPath, f.path);
        }
      }
    }
    for (const f of allOpen) {
      dispatch({ type: 'CLOSE_FILE', path: f.path });
    }
    void releasePaths(allOpen.map((f) => f.path));
  }, [state.files, dispatch, showConfirm, isFileDirty, commitOrAbort]);

  // Exit the app (File ▸ Exit / Ctrl+Q) — always quits when clean; the
  // tray-minimize setting governs the window × (below), not an explicit Exit.
  const handleExit = useCallback(async () => {
    const dirtyFiles = Array.from(state.files.values()).filter(isFileDirty);
    if (dirtyFiles.length > 0) {
      const names = dirtyFiles.map((f) => f.name).join(', ');
      const result = await showConfirm(tChrome('app.exit.unsaved', { names }));
      if (result === 'cancel') return;
      if (result === 'save') {
        if (!(await commitOrAbort())) return;
        for (const f of dirtyFiles) await file.saveAs(f.workingPath, f.path);
      }
    }
    // The quit SEALS the session record, and the seal takes whatever tab order
    // arrived last. The order publishes serially and nothing waits on it — a
    // reorder made in the seconds before Exit can still be behind an in-flight
    // publish, and the restored session would then arrange this window's tabs
    // the way they were before the user moved them. Flushed here, ahead of the
    // seal, because a post-seal publish is correctly ignored. (Every OTHER
    // window flushes in the quit's own prepare round, which also precedes the
    // capture.)
    //
    // An order that did not land is not flushed: exiting on it would record an
    // arrangement this window has already superseded, so the exit is called off
    // the same way an unanswered peer calls it off.
    if (!(await flushTabOrder())) {
      await showNotice(tChrome('app.exit.abortedTitle'), tChrome('app.exit.aborted'));
      return;
    }
    // Every other window runs its own close flow and closes itself; whichever
    // window closes last exits the process. A window that cancels keeps both
    // itself and the app, which is what a cancel means.
    //
    // Nothing closes until every other window has acknowledged the request. A
    // window that never answers has not heard it and will not close, and this
    // window closing anyway would leave it standing behind a session record
    // that stopped being written the moment Exit was chosen.
    if (!(await app.requestQuit())) {
      // Fail-closed, and said out loud. The quit unsealed itself and nothing
      // closed; without a word the user sees Exit do nothing at all, which is
      // indistinguishable from a hung menu — and the remedy (close the
      // unresponsive window first) is not guessable.
      await showNotice(tChrome('app.exit.abortedTitle'), tChrome('app.exit.aborted'));
      return;
    }
    // The last window out captures the session on its way down. A capture that
    // did not reach disk leaves this window standing rather than exiting with
    // an older run's record on the file — said out loud for the same reason the
    // abort above is.
    if (!(await app.confirmClose())) {
      await showNotice(tChrome('app.exit.abortedTitle'), tChrome('app.exit.aborted'));
    }
  }, [state.files, isFileDirty, showConfirm, commitOrAbort, showNotice]);

  // Hand a document to another window. A hand-off MOVES: the document leaves
  // this workspace, so two live copies of one file never exist and every
  // "whose" question keeps its structural answer.
  //
  // The message carries a path and nothing else: page and document ids are
  // minted against a per-window generation counter, so the same id string
  // names a different physical page in the other window.
  //
  // Which means the FILE is the only channel the document travels through, and
  // everything it is carrying has to be in it before it leaves. Two writes are
  // involved and they are not the same write. The commit gate flushes the page
  // tier into the WORKING copy — the shipped meaning of leaving a view, and
  // harmless wherever the document ends up. Writing that working copy back over
  // the user's own path is what a MOVE costs, because the receiving window opens
  // the path and mints a working copy from whatever is on disk; without it every
  // unsaved edit is discarded at the moment of the move, with no prompt and
  // nothing to undo.
  //
  // So the order is: flush the page tier, RESERVE the destination, and only
  // then — for a document that is actually leaving — write the file, mark it
  // saved and commit. A release that lands back in this window writes nothing:
  // it is not a hand-off, and marking a document saved discards its undo
  // history.
  //
  // The reservation is what makes that order safe. Classifying the release and
  // then resolving it again are two answers to the same question with the write
  // in between: a pointer released a pixel further on, or a window closed while
  // the file was being written, and the document stays put having already been
  // saved and had its history reset. So the first answer BINDS — the claim and
  // the queued open move under it, and the commit only reports what already
  // happened or hears that the destination is gone.
  //
  // Ownership is handed over in one step, and the receiving window is built
  // only once it has. Releasing the claim and re-taking it around the build
  // leaves the path owned by nobody for as long as the window takes to appear:
  // a third window claiming it in that gap would leave this document with
  // nowhere to arrive, having already left the only window that could open it.
  //
  // One implementation for both gestures — the menu command and a dragged tab
  // differ only in where the document is going, and an explicit menu command
  // has no destination to resolve.
  const handOffDocument = useCallback(
    async (path: string, reserve: () => Promise<TabDragReservation>): Promise<boolean> => {
      if (!(await commitOrAbort())) return false;
      const held = await reserve();
      const handed = stateRef.current.files.get(path);
      const plan = planHandOff(reservationHolds(held), !!handed && isFileDirty(handed));
      if (!plan.hand) return false;
      // A destination that dies before it opens the document gives it back, and
      // the window it goes back to is this one. Recorded per path so the return
      // can be told apart from a document arriving from anywhere else: the tab
      // is still open here, and re-opening it would be a second copy.
      const flight = { returned: false };
      handOffsInFlight.current.set(path, flight);
      let moved: TabDragResult;
      try {
        if (plan.saveFirst && handed) {
          await file.saveAs(handed.workingPath, handed.path);
          dispatch({ type: 'MARK_SAVED', path });
        }
        moved = await tabDrag.commit(held.token);
      } catch (e) {
        // The write a move costs failed. The document is still held somewhere
        // else, and nothing will ever come for it.
        handOffsInFlight.current.delete(path);
        await tabDrag.release(held.token).catch(() => {});
        throw e;
      }
      handOffsInFlight.current.delete(path);
      // Nothing below this line awaits, so a return that arrives after the
      // check finds no flight and re-opens the document instead.
      if (!tabMoved(moved) || flight.returned) return false;
      // Closed WITHOUT a release — the path already belongs to the receiving
      // window, and releasing here would strip the claim off the window that
      // now holds it.
      dispatch({ type: 'CLOSE_FILE', path });
      return true;
    },
    [dispatch, commitOrAbort, isFileDirty],
  );

  const handleMoveToNewWindow = useCallback(async () => {
    const current = stateRef.current;
    const target = current.activeFileId ? current.files.get(current.activeFileId) : null;
    if (!target || target.importOnly) return;
    await handOffDocument(target.path, () => tabDrag.reserveNewWindow(target.path));
  }, [handOffDocument]);

  // A release that never left this window's own strip. Nothing crosses, so
  // Rust is not asked: the strip measured the gap itself, and the far side
  // would only answer from a rectangle this window published about geometry
  // this window measured.
  //
  // The commit gate still runs: a released tab flushes the page tier into the
  // WORKING copy, which is a different write from the one a hand-off makes
  // over the user's own file. The reorder itself is arrangement — no file is
  // written, nothing is marked saved, and no history is touched; marking a
  // document saved here would discard its undo chain for a tab that moved.
  const reorderTab = useCallback(
    async (path: string, index: number): Promise<boolean> => {
      if (!(await commitOrAbort())) return false;
      dispatch({ type: 'REORDER_FILE', path, index });
      // The document did not change hands: the tab is still here, in its new
      // place, and the caller must not close it.
      return false;
    },
    [commitOrAbort, dispatch],
  );

  // A released tab drag. The point is already in physical screen pixels; for
  // anything outside this window's own strip Rust decides from it whether it
  // is another window's strip or nowhere (a new window at the drop point).
  const handleTabDrop = useCallback(
    (path: string, point: PhysicalScreenPoint, reorderTo: number | null) =>
      reorderTo === null
        ? handOffDocument(path, () => tabDrag.reserve(path, point))
        : reorderTab(path, reorderTo),
    [handOffDocument, reorderTab],
  );

  // --- Command layer ----------------------------------------------------
  // Reading mode's Escape exit (I.6). An interceptor, not a keymap entry —
  // in-flight drags push their own interceptors ABOVE this one (LIFO), so Esc
  // still cancels a drag first, then leaves reading mode on the next press.
  const readingModeOn = state.ui.readingMode;
  useEffect(() => {
    if (!readingModeOn) return;
    const pop = pushEscapeInterceptor(() => {
      dispatch({ type: 'UI_TOGGLE_READING_MODE' });
      return true;
    });
    return pop;
  }, [readingModeOn, dispatch]);

  const commandHandlers: AppCommandHandlers = {
    openFiles: handleOpenFile,
    // The same open, minus the tab jump — the panels' "Open a PDF" button.
    openFilesInPlace: async () => {
      const paths = await openFiles();
      if (paths.length > 0) await openByPaths(paths, { focus: false });
    },
    // Pre-filled, never pre-fetched: opening the dialog is not a request.
    openFromWeb: (url) => setOpenWebUrl(url ?? ''),
    openPath: async (path) => { await openByPaths([path]); },
    openPathAtPage: async (path, pageNumber) => {
      await openByPaths([path], { focus: true });
      // The OPEN_FILE dispatch + index update land over the next renders, so
      // poll jumpToFilePage (idempotent, no-ops until the page resolves) and
      // stop on the first success. Bounded so a page that never indexes
      // (e.g. the file failed to open) doesn't loop forever.
      for (let i = 0; i < 15; i++) {
        if (getCanvasServices()?.jumpToFilePage(path, pageNumber)) return;
        await new Promise((r) => setTimeout(r, 120));
      }
    },
    save: handleSave,
    saveAs: handleSaveAs,
    sendToEmail: handleSendToEmail,
    exportDocument: handleExportDocument,
    closeFile: handleCloseFile,
    closeAll: handleCloseAll,
    undo: handleUndo,
    redo: handleRedo,
    applyPageEdits: commitAndReport,
    openPreferences: () => setShowSettings('general'),
    openProperties: () => setShowProperties(true),
    openPrint: () => setShowPrint(true),
    openBatchOcr: () => setShowBatchOcr(true),
    openDiskRedact: () => setShowDiskRedact(true),
    openFormPrepFolder: () => setShowFormPrepFolder(true),
    openFolderExport: () => setShowFolderExport(true),
    openFolderCreatePdf: () => setShowFolderCreatePdf(true),
    openFolderPreflight: () => setShowFolderPreflight(true),
    openScheduledRuns: () => setShowSchedules(true),
    openWatchedFolders: () => setShowWatchers(true),
    openCreatePdf: () => {
      setCreatePdfSeed([]);
      setCreatePdfAutoStart(null);
      setShowCreatePdf(true);
    },
    openCreatePdfFrom: (source) => {
      setCreatePdfSeed([]);
      setCreatePdfAutoStart(source);
      setShowCreatePdf(true);
    },
    // An append with nowhere to append to is a new document, not a disabled
    // menu item: the user asked to scan, and the destination is the part that
    // has no answer.
    openScan: (wanted) => setScanMode(wanted === 'append' && !insertAnchor(stateRef.current) ? 'new' : wanted),
    openExportImages: () => setShowExportImages(true),
    openExportDocument: (format) => setExportDocFormat(format),
    openPresentation: () => {
      const doc = stateRef.current.workspace.documents.find(
        (d) => d.path === stateRef.current.activeFileId,
      );
      if (!doc || doc.pages.length === 0) return;
      const cur = stateRef.current.ui.currentPageId;
      const idx = cur ? doc.pages.findIndex((pg) => pg.id === cur) : 0;
      setPresentation({ startIndex: idx < 0 ? 0 : idx });
    },
    insertBlankPage,
    insertPagesFromFile,
    combineFiles,
    openLicenses: () => setShowSettings('licenses'),
    openAbout: () => setShowAbout(true),
    openCustomizeToolbar: () => setShowCustomizeToolbar(true),
    checkForUpdates: () => setUpdateCheckSignal((n) => n + 1),
    exit: handleExit,
    minimizeToTray: async () => { await app.hideToTray(); },
    newWindow: async () => { await app.openNewWindow(); },
    moveToNewWindow: handleMoveToNewWindow,
    sanitizeDocument: handleSanitizeDocument,
    setFieldLock: handleSetFieldLock,
    setFieldActions: handleSetFieldActions,
    addLinks: (path, links) => runLinkEdit(path, 'add_links', { links }),
    retargetLink: (path, page, index, target) =>
      runLinkEdit(path, 'set_link_target', { page, index, target }),
    restyleLink: (path, page, index, appearance) =>
      runLinkEdit(path, 'set_link_appearance', { page, index, appearance }),
    removeLink: (path, page, index) => runLinkEdit(path, 'delete_link', { page, index }),
    confirmPageEdit,
  };
  const commandHandlersRef = useRef(commandHandlers);
  commandHandlersRef.current = commandHandlers;
  useEffect(() => {
    const h = commandHandlersRef;
    registerAppCommandHandlers({
      openFiles: () => h.current.openFiles(),
      openFilesInPlace: () => h.current.openFilesInPlace(),
      openFromWeb: (url) => h.current.openFromWeb(url),
      openPath: (path) => h.current.openPath(path),
      openPathAtPage: (path, pageNumber) => h.current.openPathAtPage(path, pageNumber),
      save: () => h.current.save(),
      saveAs: () => h.current.saveAs(),
      sendToEmail: () => h.current.sendToEmail(),
      exportDocument: (format) => h.current.exportDocument(format),
      closeFile: (path) => h.current.closeFile(path),
      closeAll: () => h.current.closeAll(),
      undo: () => h.current.undo(),
      redo: () => h.current.redo(),
      applyPageEdits: () => h.current.applyPageEdits(),
      openPreferences: () => h.current.openPreferences(),
      openProperties: () => h.current.openProperties(),
      openPrint: () => h.current.openPrint(),
      openBatchOcr: () => h.current.openBatchOcr(),
      openDiskRedact: () => h.current.openDiskRedact(),
      openFormPrepFolder: () => h.current.openFormPrepFolder(),
      openFolderExport: () => h.current.openFolderExport(),
      openFolderCreatePdf: () => h.current.openFolderCreatePdf(),
      openFolderPreflight: () => h.current.openFolderPreflight(),
      openScheduledRuns: () => h.current.openScheduledRuns(),
      openWatchedFolders: () => h.current.openWatchedFolders(),
      openCreatePdf: () => h.current.openCreatePdf(),
      openCreatePdfFrom: (source) => h.current.openCreatePdfFrom(source),
      openScan: (wanted) => h.current.openScan(wanted),
      openExportImages: () => h.current.openExportImages(),
      openExportDocument: (format) => h.current.openExportDocument(format),
      openPresentation: () => h.current.openPresentation(),
      insertBlankPage: () => h.current.insertBlankPage(),
      insertPagesFromFile: () => h.current.insertPagesFromFile(),
      combineFiles: () => h.current.combineFiles(),
      openLicenses: () => h.current.openLicenses(),
      openAbout: () => h.current.openAbout(),
      openCustomizeToolbar: () => h.current.openCustomizeToolbar(),
      checkForUpdates: () => h.current.checkForUpdates(),
      exit: () => h.current.exit(),
      minimizeToTray: () => h.current.minimizeToTray(),
      newWindow: () => h.current.newWindow(),
      moveToNewWindow: () => h.current.moveToNewWindow(),
      sanitizeDocument: (path, request) => h.current.sanitizeDocument(path, request),
      setFieldLock: (path, field, lock) => h.current.setFieldLock(path, field, lock),
      setFieldActions: (path, field, actions, data) =>
        h.current.setFieldActions(path, field, actions, data),
      addLinks: (path, links) => h.current.addLinks(path, links),
      retargetLink: (path, page, index, target) =>
        h.current.retargetLink(path, page, index, target),
      restyleLink: (path, page, index, appearance) =>
        h.current.restyleLink(path, page, index, appearance),
      removeLink: (path, page, index) => h.current.removeLink(path, page, index),
      confirmPageEdit: (paths, delta) => h.current.confirmPageEdit(paths, delta),
    });
    setCommandStateSource(() => ({ state: stateRef.current, dispatch }));
    return () => {
      registerAppCommandHandlers(null);
      setCommandStateSource(null);
    };
  }, [dispatch]);
  // The ONE window-level shortcut dispatcher.
  useKeymapDispatcher();

  const handleExtractFromCanvas = useCallback((path: string, page: number) => {
    dispatch({ type: 'SET_ACTIVE_FILE', path });
    setExtractPage(page);
    // Leaving the board commits, so the panel reads committed bytes.
    invokeCommand('tools.panel.extract_text');
  }, [dispatch]);

  // Keep refs to current state so the close handler always sees latest values
  const filesRef = useRef(state.files);
  filesRef.current = state.files;
  const pageDirtyRef = useRef(state.pageDirtyPaths);
  pageDirtyRef.current = state.pageDirtyPaths;

  // Close this window, and say so when it did not close.
  //
  // The last window out captures the session on its way down, and a capture
  // that did not reach disk calls the teardown off: the file still holds the
  // previous run's record, and destroying the window would exit having thrown
  // this session away with nothing left standing to capture it from. Silence
  // there reads as a dead close button.
  const closeOrReport = useCallback(
    async (minimizeToTray: boolean): Promise<void> => {
      if (await app.closeWindow(minimizeToTray)) return;
      await showNotice(tChrome('app.exit.abortedTitle'), tChrome('app.exit.aborted'));
    },
    [showNotice],
  );

  // The quit's PREPARE round: finish publishing this window's tab order and
  // say so, before the record is captured.
  //
  // The capture used to run first, so only the initiating window's own flush
  // was ever waited on and a reorder made HERE was sealed over whenever another
  // window hit Exit. This is the same flush-then-acknowledge prologue the close
  // request runs — nothing closes here, and a flush that did not land withholds
  // the receipt, which aborts the quit inside its own bounded wait.
  useEffect(() => {
    const unlisten = app.onPrepareClose(async (quitId) => {
      await sealBeforeClose(quitId, { flush: flushTabOrder, ack: app.quitAck });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Handle window close — Rust intercepts CloseRequested and emits app:beforeClose
  useEffect(() => {
    const unlisten = app.onBeforeClose(async (quitId) => {
      // Flush, THEN acknowledge — the ordering `lib/close-sequence` exists to
      // pin. The seal takes whatever order arrived last, and only the sealing
      // window used to flush, so a reorder made in THIS window was sealed over
      // when another one hit Exit. Publishing before the receipt closes that
      // seam inside the abort bound the quit already enforces: a flush that
      // never finishes withholds the receipt and the quit aborts, which is the
      // fail-closed outcome rather than a wedge.
      //
      // The receipt still precedes every DIALOG below: a prompt can take
      // minutes, and a receipt queued behind one reads to the quit as a dead
      // renderer. The flush is bounded by this window's own in-flight publish,
      // which is why it is the one thing allowed in front of it.
      //
      // False means the order did not land. The receipt is withheld rather than
      // given over a record this window has already superseded, and this window
      // stays open — the quit aborts on its own bounded wait. A plain window ×
      // is never refused this way: it has no quit to withhold from.
      if (!(await sealBeforeClose(quitId, { flush: flushTabOrder, ack: app.quitAck }))) return;
      const minimizeToTray = getSettings().minimizeToTray === true;
      const dirtyFiles = Array.from(filesRef.current.values()).filter(
        (f) => f.dirty || pageDirtyRef.current.includes(f.path),
      );
      // Rust decides between hiding and closing, because only it knows whether
      // this is the last workspace window: tray residency is an app-level
      // state, so a second window's × closes that window rather than hiding
      // the app behind the first window's unsaved work.
      if (dirtyFiles.length === 0) {
        await closeOrReport(minimizeToTray);
        return;
      }
      const names = dirtyFiles.map((f) => f.name).join(', ');
      const result = await showConfirm(tChrome('app.window.unsaved', { names }));
      // Every path that leaves this window standing also calls off a quit that
      // may have prompted it: an app Exit records the session and freezes the
      // record before any window is asked, and the app is still running. The
      // call is idempotent and harmless when this close was only a window ×.
      if (result === 'cancel') {
        await app.quitCancelled();
        return;
      }
      if (result === 'save') {
        try {
          await commitRef.current();
        } catch {
          await app.quitCancelled();
          return;
        }
        try {
          for (const f of dirtyFiles) {
            await file.saveAs(f.workingPath, f.path);
          }
        } catch (e) {
          await app.quitCancelled();
          throw e;
        }
      }
      await closeOrReport(minimizeToTray);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [showConfirm, closeOrReport]);

  // Leaving doc-tab-land commits pending page edits (the "in-memory edits
  // exist only while a document tab is focused" invariant — the Tools panels
  // and Home always see materialized state). Doc→doc switches don't commit
  // (the tier is workspace-global). On failure the banner shows and the tier
  // stays pending. Re-keyed from the old view-transition effect.
  const prevInDocRef = useRef(inDocTab);
  useEffect(() => {
    const prev = prevInDocRef.current;
    prevInDocRef.current = inDocTab;
    if (prev && !inDocTab) {
      void commitAndReport();
    }
  }, [inDocTab, commitAndReport]);

  // Focus a document's tab (tray/shell flows), or Home when nothing is open.
  const focusBoardOrHome = useCallback(() => {
    const firstDoc = tabFiles(stateRef.current)[0];
    dispatch({ type: 'UI_FOCUS_TAB', tab: firstDoc ? { doc: firstDoc.path } : 'home' });
  }, [dispatch]);

  // Handle tray actions (Quick Merge) — land on the document board, or
  // Home (its Open button) when nothing is open yet.
  useEffect(() => {
    const unlisten = app.onTrayAction((action: string) => {
      if (action === 'merge') focusBoardOrHome();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [focusBoardOrHome]);

  // Handle files opened via file association, context menu, or second instance.
  // openByPaths focuses the opened doc's tab (strips + merge-up ARE the merge
  // flow, 2o — a shell "merge" open lands there like any multi-open).
  // The payload is DRAINED from Rust rather than carried on the event: a
  // window created for a pop-out has no listener mounted when its open is
  // routed, and a queue that only this window can drain can neither lose the
  // open nor apply it twice.
  useEffect(() => {
    let cancelled = false;
    const drain = async (): Promise<void> => {
      for (const pending of await app.takePendingOpens()) {
        if (cancelled) return;
        // A dropped tab carries the gap its caret marked in the receiving
        // window; every other queued open carries none and appends.
        await openByPaths(
          pending.files,
          pending.index === null ? undefined : { index: pending.index },
        );
      }
    };
    void drain();
    const unlisten = app.onOpenFile(() => { void drain(); });
    return () => { cancelled = true; unlisten.then((fn) => fn()); };
  }, [openByPaths]);

  // A document coming back from a handover the receiving window died holding.
  // Ownership is already back here; what is left is where it should appear.
  //
  // Not a queued open, because the answer depends on what this window has
  // already done about the hand-off: one still in flight has a tab open that
  // it was about to close, and opening the document again would make a second
  // copy of it. One that has already closed its tab needs exactly that open.
  useEffect(() => {
    const unlisten = tabDrag.onReturned((path) => {
      const flight = handOffsInFlight.current.get(path);
      if (flight) {
        flight.returned = true;
        return;
      }
      void openByPaths([path]);
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [openByPaths]);

  // Test harness — only compiled in when VITE_E2E=1 was set at build time.
  const harnessListenersRef = useRef<Set<(s: TestStateSnapshot) => void>>(new Set());
  const harnessSnapshotRef = useRef<() => TestStateSnapshot>(() => ({
    view: 'welcome', focusedTab: 'home', activeOp: 'merge', tool: 'select', activeToolId: null,
    docViewMode: 'document', splitView: false, splitMode: 'off', currentPageId: null, fileCount: 0, activeFileId: null, activeFile: null,
  }));
  harnessSnapshotRef.current = () => ({
    view: viewOf(focusedTab),
    focusedTab,
    activeOp,
    tool: state.ui.tool,
    activeToolId: state.ui.activeToolId,
    docViewMode: state.ui.docViewMode,
    splitView: state.ui.splitView !== 'off',
    splitMode: state.ui.splitView,
    currentPageId: state.ui.currentPageId,
    fileCount: state.files.size,
    activeFileId: state.activeFileId,
    activeFile: activeFile
      ? {
          name: activeFile.name,
          path: activeFile.path,
          workingPath: activeFile.workingPath,
          pageCount: activeFile.pageCount,
          dirty: activeFile.dirty,
        }
      : null,
  });

  const harnessFirstPageRef = useRef<() => { docId: string; pageId: string } | null>(() => null);
  harnessFirstPageRef.current = () => {
    const doc = state.workspace.documents.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    return doc && page ? { docId: doc.id, pageId: page.id } : null;
  };

  const harnessFirstAnnotationRef = useRef<
    () => {
      docId: string;
      pageId: string;
      annotationId: string;
      kind: string;
      color: string;
      note?: string;
      markupType?: string;
      quadCount?: number;
      strokeCount?: number;
      hasImage?: boolean;
    } | null
  >(() => null);
  harnessFirstAnnotationRef.current = () => {
    const doc = state.workspace.documents.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    const annotation = page?.annotations?.[0];
    return doc && page && annotation
      ? {
          docId: doc.id,
          pageId: page.id,
          annotationId: annotation.id,
          kind: annotation.kind,
          color: annotation.color,
          note: annotation.note,
          markupType: annotation.markupType,
          quadCount: annotation.quads ? annotation.quads.length / 4 : undefined,
          strokeCount: annotation.strokes ? annotation.strokes.length : undefined,
          hasImage: annotation.imageData !== undefined,
        }
      : null;
  };

  // Map the legacy harness setView onto the tab model so legacy specs keep
  // working: welcome→Home; canvas→the active (or first) document's tab (a
  // no-op to Home when nothing is open); and 'operations'
  // becomes the NAME-COMPATIBLE BRIDGE: the Tools tab is gone, so it focuses
  // the showable doc tab and opens the right dock, which is where the ~30
  // legacy panel specs' panels actually render now. Their next setActiveOp
  // seats the panel exactly as before.
  const harnessSetView = useCallback(
    (v: 'welcome' | 'operations' | 'canvas') => {
      if (v === 'welcome') dispatch({ type: 'UI_FOCUS_TAB', tab: 'home' });
      else {
        const s = stateRef.current;
        // The shared rule, not a copy of it — the harness must answer "which
        // document is in front?" exactly as production does, or 16 e2e specs
        // silently drift from the app they're testing.
        const target = showableDoc(s) ?? tabFiles(s)[0]?.path ?? null;
        dispatch({ type: 'UI_FOCUS_TAB', tab: target ? { doc: target } : 'home' });
        if (v === 'operations') dispatch({ type: 'UI_SET_TOOL_DOCK_OPEN', open: true });
      }
    },
    [dispatch],
  );

  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    installTestHarness({
      openByPaths: async (paths) => { await openByPaths(paths); },
      setView: (v) => harnessSetView(v),
      focusTab: (tab) => dispatch({ type: 'UI_FOCUS_TAB', tab }),
      setActiveOp: (op) => setActiveOp(op as Operation),
      setTool: (tool) => dispatch({ type: 'UI_SET_TOOL', tool: tool as CanvasTool }),
      setDocViewMode: (mode) => dispatch({ type: 'UI_SET_DOC_VIEW_MODE', mode }),
      getStateSnapshot: () => harnessSnapshotRef.current(),
      subscribe: (listener) => {
        harnessListenersRef.current.add(listener);
        return () => harnessListenersRef.current.delete(listener);
      },
      getFirstPage: () => harnessFirstPageRef.current(),
      getActiveDocPages: () =>
        stateRef.current.workspace.documents
          .filter((d) => d.path === stateRef.current.activeFileId)
          .flatMap((d) => d.pages.map((p) => ({ id: p.id, width: p.width, height: p.height }))),
      getFirstPageAnnotation: () => harnessFirstAnnotationRef.current(),
      getPageAnnotations: (docId, pageId) => {
        const d = stateRef.current.workspace.documents.find((x) => x.id === docId);
        const p = d?.pages.find((x) => x.id === pageId);
        return (p?.annotations ?? []).map((a) => ({
          id: a.id,
          kind: a.kind,
          x: a.x,
          y: a.y,
          w: a.w,
          h: a.h,
          color: a.color,
          note: a.note,
          shapeType: a.shapeType,
          strokeWidth: a.strokeWidth,
          fillColor: a.fillColor,
          opacity: a.opacity,
          // Which pen drew an ink mark, and how many pen lifts it holds — a
          // freehand highlight and a pen stroke are the same `kind`, so a spec
          // asserting the highlighter placed a HIGHLIGHT needs this to tell
          // them apart at all.
          inkStyle: a.inkStyle,
          strokeCount: a.strokes?.length,
          // The VERTEX list. A snapped point is exact where a
          // raw pointer is not, so the spec's honest question is "is this
          // coordinate the geometry's own?" — which needs the points, not
          // the padded bbox they sit inside.
          points: a.points ? [...a.points] : undefined,
          // The count mark's group/symbol/sequence — spec 107
          // asserts the group RECONSTITUTES from the file, so it has to see
          // what the mark says it belongs to.
          countGroup: a.countGroup,
          countSymbol: a.countSymbol,
          countSeq: a.countSeq,
          // Which registry symbol a placed stamp / count marker
          // draws, and how many PARTS its carried geometry has — spec 108
          // asserts the artwork travels with the annotation, so "did the
          // geometry survive?" must be answerable without the geometry itself.
          symbolId: a.symbolId,
          symbolParts: a.symbolParts?.length,
        }));
      },
      dispatchAddAnnotation: (docId, pageId, annotation) =>
        dispatch({ type: 'ADD_ANNOTATION', docId, pageId, annotation }),
      dispatchRecolorAnnotation: (docId, pageId, annotationId, color) =>
        dispatch({ type: 'RECOLOR_ANNOTATION', docId, pageId, annotationId, color }),
      dispatchRemoveAnnotation: (docId, pageId, annotationId) =>
        dispatch({ type: 'REMOVE_ANNOTATION', docId, pageId, annotationId }),
      commitPendingEdits: () => commitRef.current(),
      closeAllFiles: () => {
        const paths = [...filesRef.current.values()].map((f) => f.path);
        for (const path of paths) dispatch({ type: 'CLOSE_FILE', path });
        void releasePaths(paths);
      },
      importPagesIntoDoc: (filePath, toDocId, toIndex) =>
        importFilesIntoDoc([filePath], toDocId, toIndex),
      exportActiveDocument: async (destPath, format, options) => {
        const af = stateRef.current.activeFileId
          ? stateRef.current.files.get(stateRef.current.activeFileId)
          : null;
        if (!af) throw new Error('exportActiveDocument: no active file');
        const soffice_path = await app.getSofficePath();
        return call('export_document', {
          file: af.workingPath, output: destPath, fmt: format, soffice_path,
          // Slides are the only format Ghostscript renders for; Word, Excel
          // and HTML are LibreOffice's alone, so an absent prerequisite
          // refuses ONE format instead of the export.
          gs_path: format === 'pptx' ? await requireGsPath() : await gsPathIfAvailable(),
          ...(options ?? {}),
        });
      },
    });
  }, [openByPaths, dispatch, importFilesIntoDoc, harnessSetView, setActiveOp, call]);

  // Notify harness subscribers on every state-relevant change.
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    const snap = harnessSnapshotRef.current();
    harnessListenersRef.current.forEach((l) => l(snap));
  }, [focusedTab, activeOp, state.ui.tool, state.ui.activeToolId, state.files, state.activeFileId, activeFile?.dirty, activeFile?.pageCount]);

  return (
    <OperationsProvider
      performOperation={performOperation}
      addFormFields={handleAddFormFields}
      confirmSignedEdit={confirmEditOfSignedDoc}
    >
    <DropZone
      onFilesDropped={handleFilesDropped}
      onUrlDropped={(url) => setOpenWebUrl(url)}
    >
    <div className="app-shell h-screen bg-neutral-900 text-neutral-100 flex flex-col overflow-hidden">
      <MenuBar />
      {!(state.ui.readingMode && isDocTab(state.ui.focusedTab)) && <MainToolbar />}

      <PortfolioAutoOpen />
      <UpdateBar checkSignal={updateCheckSignal} />

      {commitError && (
        <div data-testid="commit-error-bar" className="app-banner flex items-center gap-3 px-4 py-2 bg-red-600/20 border-b border-red-500/40 text-sm text-red-200 shrink-0">
          <span className="flex-1">{commitError}</span>
          <button
            onClick={() => void commitAndReport()}
            className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded font-medium"
          >
            {tChrome('app.commit.retry')}
          </button>
          <button
            onClick={() => setCommitError(null)}
            className="text-red-300 hover:text-red-100 text-xs"
          >
            {tChrome('app.commit.dismiss')}
          </button>
        </div>
      )}

      {!(state.ui.readingMode && isDocTab(state.ui.focusedTab)) && (
        <TabStrip onCloseFile={(path) => void handleCloseFile(path)} onTabDrop={handleTabDrop} />
      )}

      <div className="flex flex-1 overflow-hidden">
          <main className="app-content flex-1 flex flex-col overflow-hidden">
          {focusedTab === 'home' ? (
            <HomeTab
              recentFiles={recentFiles}
              onOpen={() => invokeCommand('file.open')}
              onOpenRecent={(entry) =>
                entry.sourceUrl
                  ? setOpenWebUrl(entry.sourceUrl)
                  : void openByPaths([entry.path])
              }
              onClearRecent={() => invokeCommand('file.clearRecent')}
              onRevealRecent={(path) => {
                void file.reveal(path).catch(() =>
                  showNotice(tChrome('chrome.home.recentFiles'), tChrome('chrome.recent.revealFailed')),
                );
              }}
              onOpenTool={(id) => invokeCommand(`tools.open.${id}`)}
            />
          ) : (
            <div className="flex-1 flex flex-row overflow-hidden">
              {/* Left navigation pane — thumbnails etc. for the active doc.
                  Hidden entirely in reading mode (I.6); navPane.open state is
                  untouched underneath, so exiting restores it exactly. */}
              {!state.ui.readingMode && <NavPane
                activeFile={activeFile ?? null}
                onOpenPage={(_docId, pageId) =>
                  // READ the page — the reading pane replaced the
                  // PageInspector. One implementation (the canvas's
                  // pending-jump path); a local mode-dispatch + jumpToPage
                  // here read a stale view ref and landed on page 1
                  // (regression).
                  getCanvasServices()?.openPageForReading(pageId)
                }
                onExtractText={handleExtractFromCanvas}
              />}
              <div className="flex-1 flex flex-col relative overflow-hidden">
                <WorkspaceCanvasView
                  onOpenFiles={() => void handleOpenFile()}
                  onCloseFile={(path) => void handleCloseFile(path)}
                  onExtractText={handleExtractFromCanvas}
                  onRedactFile={handleRedactFile}
                  onSaveRedactionMarks={handleSaveRedactionMarks}
                  onWidgetAction={handleWidgetAction}
                  onAddLinks={handleAddLinks}
                  onApplyOcrLayer={handleApplyOcrLayer}
                  onEditImage={handleEditImage}
                  onEditImagesGroup={handleEditImagesGroup}
                  onEditVector={handleEditVector}
                  onEditText={handleEditText}
                  onRestyleText={handleRestyleText}
                  onEditParagraph={handleEditParagraph}
                  onMergeParagraph={handleMergeParagraph}
                  onAddText={handleAddText}
                  onAddImage={handleAddImage}
                  onAddPages={handleAddPages}
                  onFillFormValues={handleFillFormValues}
                  onAddFormField={handleAddFormField}
                  onAddFormFields={handleAddFormFields}
                  onScriptAlert={(text) =>
                    void showNotice(tChrome('canvas.forms.scriptAlertTitle'), text)
                  }
                  dropResolverRef={dropResolverRef}
                />
              </div>
              {/* The right tool dock: ops panels beside the
                  document. Reading mode collapses it with the rest of the
                  chrome; toolDock.open is untouched underneath, so exiting
                  restores it (the navPane precedent). */}
              {!state.ui.readingMode && state.ui.toolDock.open && (
                <ToolDock
                  panels={panels}
                  extractPage={extractPage}
                  onConsumeExtractPage={() => setExtractPage(null)}
                />
              )}
            </div>
          )}
        </main>
      </div>

      {/* Operation queue */}
      <OperationQueue items={queue} onClear={clearQueue} />

      {/* Settings modal — accessible from Edit ▸ Preferences / Help ▸ Licenses */}
      {showSettings !== null && (
        <PreferencesModal category={showSettings} onClose={() => setShowSettings(null)} />
      )}
      {showProperties && <PropertiesDialog onClose={() => setShowProperties(false)} />}
      {showPrint && <PrintDialog onClose={() => setShowPrint(false)} />}
      {showBatchOcr && <BatchOcrDialog onClose={() => setShowBatchOcr(false)} />}
      {showDiskRedact && <DiskRedactDialog onClose={() => setShowDiskRedact(false)} />}
      {showFormPrepFolder && (
        <FolderFormPrepDialog
          onClose={() => setShowFormPrepFolder(false)}
          // The escalation goes through the ONE open funnel and then seats the
          // tool the way the docless-tool flow does: the reducer owns the rule
          // that arms a tool, and a command re-invoked here would re-read a
          // state React has not flushed yet and refuse itself. The dock opens
          // deliberately — the gesture asked for the review surface, which is
          // the panel.
          onReviewInApp={(path) => {
            void openByPaths([path]).then(() => {
              dispatch({ type: 'UI_SET_ACTIVE_OP', op: 'prepareform' });
              dispatch({ type: 'UI_SET_TOOL_DOCK_OPEN', open: true });
            });
          }}
        />
      )}
      {showFolderExport && <FolderExportDialog onClose={() => setShowFolderExport(false)} />}
      {showFolderPreflight && (
        <FolderPreflightDialog onClose={() => setShowFolderPreflight(false)} />
      )}
      {showFolderCreatePdf && (
        <FolderCreatePdfDialog onClose={() => setShowFolderCreatePdf(false)} />
      )}
      {showSchedules && <ScheduledRunsDialog onClose={() => setShowSchedules(false)} />}
      {showWatchers && <WatchedFoldersDialog onClose={() => setShowWatchers(false)} />}
      {scanMode && (
        <ScanDialog
          mode={scanMode}
          onClose={() => setScanMode(null)}
          onCreated={async (path) => { await openByPaths([path]); }}
          onAppend={insertAnchor(state) ? (path) => insertPagesFromScan(path) : null}
          appendDir={scanAppendDir}
        />
      )}
      {openWebUrl !== null && (
        <OpenFromWebDialog
          initialUrl={openWebUrl}
          onClose={() => setOpenWebUrl(null)}
          onDownloaded={openDownloadedFile}
        />
      )}
      {showCreatePdf && (
        <CreatePdfDialog
          initialPaths={createPdfSeed}
          autoStart={createPdfAutoStart}
          onClose={() => {
            setShowCreatePdf(false);
            setCreatePdfSeed([]);
            setCreatePdfAutoStart(null);
          }}
          onOpenResult={async (path) => { await openByPaths([path]); }}
        />
      )}
      {showCombine && (
        <CombineDialog
          initialPaths={combineSeed}
          destinations={combineDestinations}
          workingDirFor={combineWorkingDirFor}
          onAppend={appendCombined}
          onClose={() => {
            setShowCombine(false);
            setCombineSeed([]);
          }}
          onOpenResult={async (path) => { await openByPaths([path]); }}
        />
      )}
      {showExportImages && activeFile && (
        <ExportImagesDialog
          file={{ workingPath: activeFile.workingPath, name: activeFile.name }}
          onClose={() => setShowExportImages(false)}
        />
      )}
      {exportDocFormat && activeFile && (
        <ExportDocumentDialog
          file={{ workingPath: activeFile.workingPath, name: activeFile.name }}
          format={exportDocFormat}
          onClose={() => setExportDocFormat(null)}
          // The review is a surface, not a dialog step: it needs the page, so
          // the dialog closes and the dock opens on the panel that owns it.
          onReviewTables={() => {
            setExportDocFormat(null);
            dispatch({ type: 'UI_SET_ACTIVE_OP', op: 'tablereview' });
            dispatch({ type: 'UI_SET_TOOL_DOCK_OPEN', open: true });
          }}
        />
      )}
      {presentation && (() => {
        const doc = state.workspace.documents.find((d) => d.path === state.activeFileId);
        if (!doc || doc.pages.length === 0) return null;
        return (
          <PresentationView
            doc={doc}
            proxies={presentationProxies}
            startIndex={presentation.startIndex}
            onExit={(landedPageId) => {
              setPresentation(null);
              if (landedPageId) getCanvasServices()?.openPageForReading(landedPageId);
            }}
          />
        );
      })()}
      {showAbout && <AboutDialog version={appVersion} onClose={() => setShowAbout(false)} />}
      {showIccLicense && <IccLicenseDialog onClose={() => setShowIccLicense(false)} />}
      {showGsMissing && <GsMissingDialog onClose={() => setShowGsMissing(false)} />}
      {showCustomizeToolbar && (
        <CustomizeToolbarDialog onClose={() => setShowCustomizeToolbar(false)} />
      )}
      <ConfirmDialog
        open={confirmState !== null}
        message={confirmState?.message ?? ''}
        kind={confirmState?.kind}
        title={confirmState?.title}
        affirmLabel={confirmState?.affirmLabel}
        onResult={handleConfirmResult}
      />
      <PasswordDialog
        open={passwordState !== null}
        fileName={passwordState?.fileName ?? ''}
        error={passwordState?.error}
        onResult={handlePasswordResult}
      />
      <CertUnlockDialog
        open={certUnlockState !== null}
        fileName={certUnlockState?.fileName ?? ''}
        error={certUnlockState?.error}
        onResult={handleCertUnlockResult}
      />
      {submitConsentState ? (
        <SubmitConsentDialog
          fieldName={submitConsentState.fieldName}
          url={submitConsentState.url}
          format={submitConsentState.format}
          method={submitConsentState.method}
          preview={submitConsentState.preview}
          fieldCount={submitConsentState.fieldCount}
          onAnswer={handleSubmitConsent}
        />
      ) : null}
    </div>
    </DropZone>
    </OperationsProvider>
  );
}

export function App(): React.ReactElement {
  return (
    <QueueProvider>
      <AppStateProvider>
        <SearchProvider>
          <SeparationPreviewProvider>
            <FlattenerPreviewProvider>
              <AppContent />
            </FlattenerPreviewProvider>
          </SeparationPreviewProvider>
        </SearchProvider>
      </AppStateProvider>
    </QueueProvider>
  );
}
