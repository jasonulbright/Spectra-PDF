import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useAppState, useAppDispatch } from '../../state/AppStateProvider';
import { usePdfProxies } from '../../hooks/usePdfProxies';
import { computeLayout, computeDropTarget, betweenSlotY, BASE_PAGE_HEIGHT, MIN_DOC_WIDTH } from '../../canvas/layout';
import { usePageDrag } from '../../canvas/usePageDrag';
import { uniqueDocName } from '../../lib/doc-names';
import { primeSystemFonts } from '../../lib/system-fonts';
import { insetsFromBand, publishDrawnCrop, roundInsets } from '../../lib/crop-draw';
import { beadRectFromBand, publishDrawnBead } from '../../lib/article-beads';
import {
  hasCustomLabels,
  labelFor,
  resolvePageEntry,
  sanitizePageEntry,
} from '../../lib/page-labels';
import { getDocumentProxy } from '../../lib/pdfDocCache';
import { buildRedactionRegions } from '../../lib/redaction';
import { displayRectToPdf, pdfRectToDisplay } from '../../lib/pdfx-build';
import { sameRegion } from '../../lib/search-redact';
import {
  loadRedactionProperties,
  propertiesFromPayload,
  propertiesPayload,
} from '../../lib/redaction-properties';
import { buildLinkPayloads, type LinkSpec, type PageQuads } from '../../lib/text-selection-markup';
import type { PageGeometry, RedactionMark, RedactionRegion } from '../../lib/redaction';
import {
  buildFieldSpecs,
  candidatesFromDetection,
  moveCandidate,
  prunedCandidates,
  removeCandidate,
  type DetectionResult,
  type FieldCandidate,
} from '../../lib/form-candidates';
import {
  acceptedRegions,
  addColumn,
  exportRegions,
  moveColumn,
  moveRegionBounds,
  prunedRegions,
  quarter,
  regionsFromDetection,
  removeColumn,
  toggleRegion,
  type TableDetectionResult,
  type TableRegion,
  type TableReviewHandlers,
} from '../../lib/table-review';
import type { ExportDocumentResult } from '../../lib/export-targets';
import type { PageRef } from '../../state/types';
import { buildSignatureAppearance } from '../../lib/signature-placement';
import type { SignaturePlacement } from '../../lib/signature-placement';
import { captureSnapshot, type SnapshotPlacement } from '../../lib/snapshot-capture';
import { getSettings, saveSettings } from '../../lib/app-settings';
import { readingLocale, type PageReadAloud } from '../../lib/read-aloud';
import { useReadAloud, type ReadAloudTarget } from '../../hooks/useReadAloud';
import { ReadAloudBar } from './ReadAloudBar';
import {
  loadCustomWords,
  resolveSpellLanguage,
  type DictionaryEntry,
} from '../../lib/spellcheck';
import { useEngine } from '../../hooks/useEngine';
import { app, dialog, imageClipboard } from '../../lib/tauri-bridge';
import { SignerSourceFields, EMPTY_SIGNER_SOURCE, signerSourceParams } from '../SignerSourceFields';
import type { SignerSource } from '../SignerSourceFields';
import {
  certifyParams,
  lockNeedsFields,
  lockParams,
  CERTIFICATION_LEVEL_LABEL,
  CERTIFY_LEVELS,
  DEFAULT_CERTIFY,
  DEFAULT_LOCK,
  type CertificationLevel,
  type CertifyOptions,
  type LockOptions,
} from '../../lib/signatures';
import { FieldLockControl } from '../FieldLockControl';
import { sourceKeyOf } from '../../search/useSearchIndex';
import { useSearchContext } from '../../search/SearchProvider';
import { useFind } from '../../search/useFind';
import { normalizeQuery, highlightWords } from '../../search/normalize';
import type { SearchOptions } from '../../search/normalize';
import { FindBar } from './FindBar';
import { DocumentView } from './DocumentView';
import { buildOcrApplyPayload } from '../../lib/ocr-apply';
import type { OcrApplyPage } from '../../lib/ocr-apply';
import type { OcrWord } from '../../ocr/types';
import { fetchEditPlacements } from '../../lib/edit-images';
import { fetchEditVectors, type EditVectorObject } from '../../lib/edit-vectors';
import {
  fetchSnapGeometry,
  type PageSnapGeometry,
} from '../../lib/snap-geometry';
import {
  getSnapSettings,
  setSnapSettings,
  subscribeSnapSettings,
} from '../../lib/snap-settings';
import {
  countMarksOf,
  derivedGroups,
  mergeGroups,
  type CountGroup,
} from '../../lib/count-marks';
import {
  getTakeoffSettings,
  rememberGroup,
  subscribeTakeoffSettings,
} from '../../lib/takeoff-settings';
import {
  prunedToPages,
  withGuidePos,
  withoutGuide,
  withoutPaths,
  type GuideAxis,
  type PageGuide,
} from '../../lib/guides';
import type { EditImagePlacement } from '../../lib/edit-images';
import { EDIT_DECLINED } from '../../lib/edit-text';
import { pageIdAtSourceIndex } from '../../lib/durable-identity';
import { computeEditSpans, fetchEditTextListing, hexToRgb, relaxUnencodableSpans } from '../../lib/edit-paragraphs';
import type { EditTextListing, ParagraphEditOpts , MergeRestyle } from '../../lib/edit-paragraphs';
import { applyRotate, LOCAL_CORNERS, matMul, transformPoint } from '../../lib/image-transform';
import type { Mat } from '../../lib/image-transform';
import { workspacePageNumber } from '../../lib/workspace-commit';
import { runCommitGate } from '../../lib/commit-gate';

import { buildMergedPageRefs, pathBlockedFromClose } from '../../lib/merge-docs';
import { useWorkspaceForms } from '../../hooks/useWorkspaceForms';
import {
  computedValues,
  formatScriptOf,
  placementDocsCurrent,
  pruneFormValues,
  shownValue,
  valueShapeMatches,
} from '../../lib/form-overlay';
import type { OverlayWidget } from '../../lib/form-overlay';
import { readFormFields, type FormFieldValue } from '../../lib/forms';
import type { NewFieldSpec, NewFieldType } from '../../lib/form-authoring';
import { TEST_HARNESS_ENABLED, registerCanvasRedaction, registerCanvasSignature, registerCanvasCrop, registerCanvasSnapshot, registerCanvasOcr, registerCanvasSelection, registerCanvasForms, registerCanvasMerge, registerCanvasEditImages } from '../../testHarness';
import { invokeCommand, registerCanvasServices, pushEscapeInterceptor } from '../../commands/context';
import { buildPageContextMenu } from '../../lib/page-context-menu';
import { ContextMenu } from '../ContextMenu';
import type { MenuItem } from '../ContextMenu';
import { Canvas } from './Canvas';
import { DocLayer } from './DocLayer';
import { HeaderLayer } from './HeaderLayer';
import { AddDocGhost, GhostRow } from './DropGhost';
import { deriveDropGhosts } from './ghost-size';
import type { CanvasHandle } from '../../canvas/canvas-handle';
import type { PageAnnotation, PdfBuffer, ShapeType } from '../../state/types';
import type { CanvasTool, StampPreset } from './PageCell';
import { SecondaryToolbar } from './SecondaryToolbar';
import {
  DEFAULT_MEASURE_SCALE,
  MEASURE_UNITS,
  scaleFromCalibration,
  measureRatioLabel,
  polylineLengthPts,
  ringAreaPts2,
  type MeasureScale,
  type MeasureUnit,
} from '../../lib/measure';
import {
  alignEdits,
  distributeEdits,
  recomputedMeasureNote,
  rotateFlipEdits,
  sizeMatchEdits,
  nudgeDelta,
  translated,
  translatedBy,
  isTransformable,
  type AnnotationTransform,
  type AlignMode,
  type DistributeMode,
  type SizeMatchMode,
} from '../../lib/annotation-manipulation';
import { PropertiesBar } from './PropertiesBar';
import { CanvasStatusBar } from './CanvasStatusBar';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, tNumber, currentLanguage } from '../../i18n';

interface WorkspaceCanvasViewProps {
  onOpenFiles: () => void;
  onCloseFile: (path: string) => void;
  // Jump to the extract-text panel with the page pre-selected (same
  // workspace-position numbering; the engine gate commits before reading).
  onExtractText: (path: string, pageNumber: number) => void;
  // Run the engine's redact on one file — App routes this through
  // performOperation, so the commit gate flushes pending page edits, a
  // snapshot lands on the undo chain, and the buffer reloads after. Resolves
  // FALSE when the document's own signature policy declined the edit, which
  // is not a failure and must not clear the marks it did not apply.
  onRedactFile: (path: string, regions: RedactionRegion[]) => Promise<boolean>;
  // Persist the pending marks as the file's /Redact annotation set
  // (same performOperation shape — undoable; the reload re-seeds).
  onSaveRedactionMarks: (path: string, regions: RedactionRegion[]) => Promise<void>;
  // A pushbutton widget clicked in fill mode, with its classified /A.
  onFormButton: (path: string, fieldName: string, action: import('../../lib/forms').ButtonAction | null) => Promise<void>;
  // Author link regions from a text selection (same performOperation shape:
  // gate flush -> snapshot -> engine add_links -> reload, so it undoes).
  onAddLinks: (path: string, links: LinkSpec[]) => Promise<void>;
  // Persist OCR text layers into one file — same performOperation routing as
  // onRedactFile (gate flush -> snapshot -> engine apply_ocr_layer -> reload).
  onApplyOcrLayer: (path: string, pages: OcrApplyPage[]) => Promise<void>;
  // Edit ▸ Images: one handler, three actions, all App-routed (delete/
  // replace via the snapshot→engine→reload shape — undoable; extract = gated
  // read + save, resolving to a user-facing notice naming the real output).
  // `opts` is the harness's dialog bypass.
  onEditImage: (
    kind: 'delete' | 'replace' | 'extract' | 'transform' | 'crop' | 'opacity',
    path: string,
    page: number,
    index: number,
    opts?: {
      source?: { jpeg_path: string } | { raw_path: string; width: number; height: number; channels: 3 | 4 };
      outputPrefix?: string;
      matrix?: number[];
      rect?: [number, number, number, number];
      opacity?: number;
      blend?: string;
      mask?: import('../../lib/edit-images').EditImageMaskParam;
    },
  ) => Promise<string | void>;
  // Multi-select: group transform/delete — ONE engine call for N
  // placements (one snapshot, one undo entry). Same EDIT_DECLINED contract.
  onEditImagesGroup: (
    kind: 'transform' | 'delete',
    path: string,
    page: number,
    opts: { targets?: { index: number; matrix: number[] }[]; indexes?: number[] },
  ) => Promise<string | void>;
  // Edit ▸ Vectors: delete, transform, or restyle one vector path
  // object — same undoable App routing. EDIT_DECLINED on a refused signed-doc
  // warning, like the image/text handlers.
  onEditVector: (
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
  ) => Promise<string | void>;
  // Edit ▸ Text: replace one run's text — same one-snapshot,
  // undoable App routing (engine replace_text_run). Resolves EDIT_DECLINED
  // when the signed-doc warning was refused (the canvas restores its
  // listing and says so).
  onEditText: (
    path: string,
    page: number,
    index: number,
    newText: string,
    opts?: { convert?: boolean },
  ) => Promise<string | void>;
  /** Run-scoped size/color restyle (text unchanged) — same App routing
   * and EDIT_DECLINED contract as onEditText. */
  onRestyleText: (
    path: string,
    page: number,
    index: number,
    style: { size?: number; color?: [number, number, number] },
  ) => Promise<string | void>;
  // Edit ▸ Paragraphs: replace a paragraph's text and re-lay-out
  // inside its box — same one-snapshot, undoable App routing (engine
  // replace_paragraph_text), same EDIT_DECLINED contract. The canvas
  // supplies the fingerprint (member runs + logical text) and the
  // renderer-computed span mapping.
  onEditParagraph: (
    path: string,
    page: number,
    para: { index: number; runs: number[]; text: string },
    newText: string,
    spans: { start: number; end: number; run: number }[],
    opts?: ParagraphEditOpts,
  ) => Promise<string | void>;
  // merge: the engine validates BOTH fingerprints and refuses stale
  // views / cross-stream pairs; EDIT_DECLINED on the signed-doc refusal.
  onMergeParagraph: (
    path: string,
    page: number,
    prev: { index: number; runs: number[]; text: string },
    cur: { index: number; runs: number[]; text: string },
    opts?: {
      withNext?: boolean;
      overrideText?: string;
      overrideSpans?: { start: number; end: number; run: number }[];
      restyle?: MergeRestyle;
    },
  ) => Promise<string | void>;
  // Author a NEW text object: a rubber-band box + entered text become a
  // fresh Type0 run via the engine's add_text_box. `rect` is PDF user-space
  // points; the return mirrors onEditParagraph (EDIT_DECLINED on a signed-doc
  // refusal). Undoable.
  onAddText: (
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
      kern?: boolean;
      // OpenType features — ['small_caps'] and/or ['salt']; alt_index
      // picks the salt alternate.
      features?: string[];
      alt_index?: number;
    },
  ) => Promise<string | void>;
  // Embed a NEW image at a user-space rect. `source` is optional — the
  // App handler PICKS the file when it's absent; the harness injects it (the
  // native picker is undrivable). Undoable; EDIT_DECLINED on a signed-doc
  // refusal.
  onAddImage: (
    path: string,
    page: number,
    rect: [number, number, number, number] | null,
    source?:
      | { jpeg_path: string }
      | { raw_path: string; width: number; height: number; channels: 3 | 4 }
      | { svg_path: string },
    at?: [number, number],
  ) => Promise<string | void>;
  // Add-page ghost: pick file(s) and import their pages into a document
  // at an index (byte-only import machinery, undoable via the page tier).
  onAddPages: (docId: string, toIndex: number) => void;
  // Bake pending on-canvas form values into one file — App implements
  // the FormsPanel shape (snapshot(gate) → engine fill_form_fields → reload →
  // UPDATE_FILE), so it lands on the snapshot-undo chain.
  onFillFormValues: (path: string, values: Record<string, FormFieldValue>) => Promise<void>;
  // Author a new form field into one file — same whole-file-op shape.
  onAddFormField: (path: string, spec: NewFieldSpec) => Promise<void>;
  /** Author N fields as ONE undoable act — what an accepted candidate set uses. */
  onAddFormFields: (path: string, specs: readonly NewFieldSpec[]) => Promise<void>;
  // Per-position external drop: the canvas publishes a resolver here so
  // App's drop handler can map a drop point to the document + index under it
  // (returns null for a between/empty drop → App falls back to appending).
  dropResolverRef: React.MutableRefObject<CanvasDropResolver | null>;
}

export interface CanvasDropTarget {
  docId: string;
  index: number;
}
// clientX/clientY are webview CSS pixels (App converts the Tauri physical drop
// position). Returns the doc + insertion index under the point, or null when
// the point isn't over a document card.
export type CanvasDropResolver = (clientX: number, clientY: number) => CanvasDropTarget | null;

// Stable empties so the "no pending marks" hot path never breaks the layer
// components' memoization when unrelated state changes.
// Hand mode: a press on a page must NOT pick it up — and by not
// stopping propagation, the pointer falls through to the board's d3 pan, so
// hand drags the whole board from anywhere, page or background.
const HAND_SUPPRESSES_PICKUP = (): void => {};
const NO_MARKS: RedactionMark[] = [];
const NO_MARKS_BY_PAGE: ReadonlyMap<string, RedactionMark[]> = new Map();
const NO_CANDIDATES: FieldCandidate[] = [];
const NO_CANDIDATES_BY_PAGE: ReadonlyMap<string, FieldCandidate[]> = new Map();
const NO_TABLES: TableRegion[] = [];
const NO_TABLES_BY_PAGE: ReadonlyMap<string, TableRegion[]> = new Map();
const NO_ANNOTATIONS: readonly PageAnnotation[] = [];
const NO_ANNOTATION_IDS: readonly string[] = [];

// Rung 3: the right-click recalibrate popover — "this measures X unit" with
// two outcomes: set the toolbar scale for FUTURE measurements, or override
// THIS measurement's recorded factors (undoable edit).
function RecalibratePopover({
  x,
  y,
  measureKind,
  currentNote,
  onApply,
  onClose,
}: {
  x: number;
  y: number;
  measureKind: 'distance' | 'perimeter' | 'area';
  currentNote: string;
  onApply: (value: number, unit: MeasureUnit, mode: 'scale' | 'override') => void;
  onClose: () => void;
}): React.JSX.Element {
  useTranslation();
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState<MeasureUnit>('ft');
  const parsed = parseFloat(value);
  const valid = Number.isFinite(parsed) && parsed > 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div
      className="recal-popover"
      data-testid="recal-popover"
      style={{ left: Math.min(x, window.innerWidth - 280), top: Math.min(y, window.innerHeight - 120) }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="recal-popover-row recal-popover-title">
        {tChrome(
          measureKind === 'area' ? 'canvas.recal.areaTitle' : 'canvas.recal.distanceTitle',
        )}
        <span className="recal-popover-current" title={currentNote}>
          {tChrome('canvas.recal.now', { note: currentNote })}
        </span>
      </div>
      <div className="recal-popover-row">
        <input
          type="number"
          min={0}
          step="any"
          autoFocus
          data-testid="recal-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid) onApply(parsed, unit, 'override');
          }}
        />
        <select data-testid="recal-unit" value={unit} onChange={(e) => setUnit(e.target.value as MeasureUnit)}>
          {MEASURE_UNITS.map((u) => (
            <option key={u} value={u}>
              {measureKind === 'area' ? tChrome('canvas.recal.sqUnit', { unit: u }) : u}
            </option>
          ))}
        </select>
      </div>
      <div className="recal-popover-row">
        <button
          type="button"
          data-testid="recal-override"
          disabled={!valid}
          onClick={() => onApply(parsed, unit, 'override')}
        >
          {tChrome('canvas.recal.override')}
        </button>
        <button
          type="button"
          data-testid="recal-set-scale"
          disabled={!valid}
          onClick={() => onApply(parsed, unit, 'scale')}
        >
          {tChrome('canvas.recal.setScale')}
        </button>
        <button type="button" data-testid="recal-cancel" onClick={onClose}>
          {tChrome('canvas.common.cancel')}
        </button>
      </div>
    </div>
  );
}
const NO_EDIT_IMAGES: ReadonlyMap<string, EditImagePlacement[]> = new Map();
const NO_EDIT_VECTORS: ReadonlyMap<string, EditVectorObject[]> = new Map();
const NO_EDIT_GEOM: ReadonlyMap<string, PageGeometry> = new Map();
// Per-page snap geometry, and how many pages either side of the
// reading position get one.
const NO_SNAP_GEOM: ReadonlyMap<string, PageSnapGeometry> = new Map();
const SNAP_PAGE_WINDOW = 2;
// Stable empties, so a document with no guides hands PageCell the same
// identity every render and its memo holds (the NO_MARKS precedent).
const NO_GUIDES: PageGuide[] = [];
const NO_GUIDES_BY_PAGE: ReadonlyMap<string, PageGuide[]> = new Map();
const NO_EDIT_TEXT: ReadonlyMap<string, EditTextListing> = new Map();
const NO_PAGE_IDS: ReadonlySet<string> = new Set();
const NO_WORDS_BY_PAGE: ReadonlyMap<string, OcrWord[]> = new Map();
const NO_READ_ALOUD: ReadonlyMap<string, PageReadAloud> = new Map();
const NO_WIDGETS_BY_PAGE: ReadonlyMap<string, OverlayWidget[]> = new Map();
const NO_LOCK_NAMES: readonly string[] = [];
const NO_FORM_VALUES: ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>> = new Map();

export function WorkspaceCanvasView({
  onOpenFiles,
  onCloseFile,

  onExtractText,
  onRedactFile,
  onSaveRedactionMarks,
  onFormButton,
  onAddLinks,
  onApplyOcrLayer,
  onEditImage,
  onEditImagesGroup,
  onEditVector,
  onEditText,
  onRestyleText,
  onEditParagraph,
  onMergeParagraph,
  onAddText,
  onAddImage,
  onAddPages,
  onFillFormValues,
  onAddFormField,
  onAddFormFields,
  dropResolverRef,
}: WorkspaceCanvasViewProps): React.ReactElement {
  useTranslation();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const docs = state.workspace.documents;
  const proxies = usePdfProxies(state.files);
  const layout = useMemo(() => computeLayout(docs), [docs]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const canvasRef = useRef<CanvasHandle | null>(null);
  // Document view: its reading-mode CanvasHandle, and a ref-mirror of the
  // mode so the registered `canvas()` getter routes to the active view.
  const documentViewRef = useRef<CanvasHandle | null>(null);
  const docViewMode = state.ui.docViewMode;
  const docViewModeRef = useRef(docViewMode);
  docViewModeRef.current = docViewMode;
  // Split view uses a second DocumentView over the same
  // document, stacked under a draggable divider. Zoom and scroll are already
  // per-instance state in DocumentView, so the panes are independent for
  // free; what needs routing is (a) which pane camera commands address and
  // (b) which pane drives the page readout. Both use the active pane selected
  // by pointerdown.
  const documentViewRefB = useRef<CanvasHandle | null>(null);
  // The spreadsheet split's second row (quad mode): c = bottom-left,
  // d = bottom-right; a/b stay the top row.
  const documentViewRefC = useRef<CanvasHandle | null>(null);
  const documentViewRefD = useRef<CanvasHandle | null>(null);
  const splitMode = docViewMode === 'document' ? state.ui.splitView : 'off';
  const splitView = splitMode !== 'off';
  const splitViewRef = useRef(splitView);
  splitViewRef.current = splitView;
  const splitModeRef = useRef(splitMode);
  splitModeRef.current = splitMode;
  const [activePane, setActivePane] = useState<'a' | 'b' | 'c' | 'd'>('a');
  const activePaneRef = useRef(activePane);
  activePaneRef.current = activePane;
  // Divider ratios are session-local state. They survive
  // toggling split off/on and doc switches, reset on restart. splitRatio is
  // the row ratio in both modes; quadCol is the quad's column ratio.
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [quadCol, setQuadCol] = useState(0.5);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const quadContainerRef = useRef<HTMLDivElement | null>(null);
  // The CanvasHandle of whichever view is active — the board's d3 camera, or the
  // reading view's scroller. EVERY camera caller (find navigation, the zoom
  // buttons, the registered canvasServices) must route through this: the
  // board-only `canvasRef` is null while the reading view is mounted, so a
  // direct `canvasRef.current?.…` silently no-ops in Document mode. With split
  // view active, a bookmark, thumbnail, or Find jump lands in the pane the user
  // last touched. The callback has stable identity because it reads refs.
  const paneHandleOf = useCallback(
    (pane: 'a' | 'b' | 'c' | 'd'): CanvasHandle | null =>
      pane === 'a'
        ? documentViewRef.current
        : pane === 'b'
          ? documentViewRefB.current
          : pane === 'c'
            ? documentViewRefC.current
            : documentViewRefD.current,
    [],
  );
  // Marquee zoom: the gesture's DocumentView applied its own zoom+scroll;
  // sibling panes sync to the SAME zoom (quad's equal-zoom invariant — see
  // activeCanvasHandle's broadcast note below). Their scroll follows the
  // frozen-pane DOM links, exactly as with any active-pane navigation.
  const syncMarqueeZoom = useCallback(
    (z: number) => {
      if (splitModeRef.current === 'off') return;
      const active = paneHandleOf(activePaneRef.current);
      for (const p of ['a', 'b', 'c', 'd'] as const) {
        const h = paneHandleOf(p);
        if (h && h !== active) h.setZoomAbsolute?.(z);
      }
    },
    [paneHandleOf],
  );
  const activeCanvasHandle = useCallback((): CanvasHandle | null => {
    if (docViewModeRef.current !== 'document') return canvasRef.current;
    const mode = splitModeRef.current;
    if (mode === 'off') return documentViewRef.current;
    if (mode === 'two') {
      return activePaneRef.current === 'b' ? documentViewRefB.current : documentViewRef.current;
    }
    // Quad: ZOOM broadcasts to all four panes — linked scroll positions
    // under unequal zooms would misalign the frozen rows. Navigation stays
    // on the active pane; the scroll links carry a jump to its partners.
    const active = paneHandleOf(activePaneRef.current) ?? documentViewRef.current;
    if (!active) return null;
    const all = (): CanvasHandle[] =>
      (['a', 'b', 'c', 'd'] as const)
        .map(paneHandleOf)
        .filter((h): h is CanvasHandle => h !== null);
    return {
      zoomIn: () => all().forEach((h) => h.zoomIn()),
      zoomOut: () => all().forEach((h) => h.zoomOut()),
      reset: () => all().forEach((h) => h.reset()),
      actualSize: active.actualSize ? () => all().forEach((h) => h.actualSize?.()) : undefined,
      fitWidth: active.fitWidth ? () => all().forEach((h) => h.fitWidth?.()) : undefined,
      clientToWorld: (x, y) => active.clientToWorld(x, y),
      centerOn: (pid) => active.centerOn(pid),
    };
  }, [paneHandleOf]);
  // Which document the reading view shows (the board shows ALL docs, the
  // reading view exactly one). An explicit per-doc focus — set by a jump that
  // lands in another file or another `.pdfx` partition — wins; otherwise the
  // active file's FIRST document. The fallback is load-bearing: `focusedDocId`
  // holds a positional `OpenDocument.id`, so a reindex can retire it, and
  // resolving through the default then keeps the view on the active file
  // instead of blanking.
  // The `d.path === activeFileId` clause is a STRUCTURAL guard, not redundancy:
  // it makes "the reading view shows a document of the active file" true by
  // construction, so no future action can strand it on another file's document
  // by forgetting to clear the focus (regression via SET_ACTIVE_FILE, which
  // did exactly that — now also cleared, but the invariant no longer depends on
  // every writer remembering).
  const focusedDoc =
    (state.ui.focusedDocId
      ? docs.find((d) => d.id === state.ui.focusedDocId && d.path === state.activeFileId)
      : null) ??
    docs.find((d) => d.path === state.activeFileId) ??
    null;
  const focusedDocRef = useRef(focusedDoc);
  focusedDocRef.current = focusedDoc;
  // A jump whose target lives in a document the reading view isn't showing:
  // parked here until that document's view has mounted (see jumpToPage).
  const pendingJumpRef = useRef<string | null>(null);
  useEffect(() => {
    const pid = pendingJumpRef.current;
    if (!pid) return;
    // Only once the newly focused doc actually owns the target (refs are
    // populated during commit, so its handle is live by the time this runs).
    if (!focusedDoc?.pages.some((p) => p.id === pid)) return;
    pendingJumpRef.current = null;
    activeCanvasHandle()?.centerOn(pid);
  }, [focusedDoc, docViewMode, activeCanvasHandle]);
  // Reading-view page navigation: the current page (from DocumentView's
  // scroll tracking) + the editable page box. `pageBox` mirrors currentPage
  // except while the user is typing in it (so a scroll doesn't clobber a
  // half-typed number).
  const [currentPage, setCurrentPage] = useState(1);
  const [pageBox, setPageBox] = useState('1');
  const pageBoxRef = useRef<HTMLInputElement | null>(null);
  const pageBoxFocused = useRef(false);
  // Whether the box was actually EDITED since it gained focus — so a blur after
  // just focusing + wheel-scrolling (no typing) resyncs the readout instead of
  // teleporting back to the frozen number (regression).
  const pageBoxDirty = useRef(false);
  // Follow-on: the document's own page LABELS, so the readout counts the
  // way the printed thing does (i, ii, iii, then a body restarting at 1) and
  // typing "iv" goes where a reader means. Empty for a document with no
  // /PageLabels, which keeps every path below on the plain sheet number.
  const [pageLabels, setPageLabels] = useState<string[]>([]);
  const labelsCustom = hasCustomLabels(pageLabels);
  // (the fetch lives below, where the engine handle is in scope)
  useEffect(() => {
    if (!pageBoxFocused.current) setPageBox(labelFor(currentPage, pageLabels));
  }, [currentPage, pageLabels]);
  // Reset the readout when entering Read mode or switching the focused doc: a
  // fresh DocumentView starts at page 1, and until it reports back the box would
  // otherwise show the previous doc's page (e.g. "40 / 3") (regression).
  // useLayoutEffect, not useEffect: `page-nav-total` reads the NEW doc's page
  // count in the same render, so a passive effect would paint one frame of a
  // stale numerator against the new total — the very "40 / 3" this closes.
  // Unlike the mirror-effect above this deliberately writes even while the box
  // is FOCUSED: on a doc switch a half-typed number targets a document that is
  // no longer shown, so keeping it would be worse than replacing it. Clearing
  // `pageBoxDirty` with it is the load-bearing half — a guard-exempt Ctrl+Tab
  // can switch docs mid-edit without ever blurring the input, and a dirty flag
  // surviving that would make the next blur "navigate" on the stale edit.
  useLayoutEffect(() => {
    if (docViewMode === 'document') {
      setCurrentPage(1);
      setPageBox('1');
      pageBoxDirty.current = false;
    }
  }, [docViewMode, focusedDoc?.id]);

  // Publish the reading position so the Pages nav panel can highlight and
  // scroll-follow it. Resolved to a PageRef id here — the panel matches
  // ids, and reconstructing one from a number there would duplicate this view's
  // page-order knowledge. Null in Organize mode: the board shows every page at
  // once and has no "current" page, so the panel must not claim one.
  const currentPageId =
    docViewMode === 'document' ? (focusedDoc?.pages[currentPage - 1]?.id ?? null) : null;
  useEffect(() => {
    dispatch({ type: 'UI_SET_CURRENT_PAGE', pageId: currentPageId });
  }, [currentPageId, dispatch]);
  // ...and it belongs to this view: leaving it entirely must not strand a
  // highlight the panel would keep showing.
  useEffect(() => () => void dispatch({ type: 'UI_SET_CURRENT_PAGE', pageId: null }), [dispatch]);

  // Publish the external-drop resolver so App's drop handler can map a
  // drop point to the document + index under it. Reads live layout/canvas via
  // refs; an 'into' target imports, a 'between' target returns null so App
  // appends a new strip (today's behavior). The clientToWorld + computeDropTarget
  // path is the same tested math the page drag uses.
  useEffect(() => {
    dropResolverRef.current = (clientX, clientY) => {
      const w = canvasRef.current?.clientToWorld(clientX, clientY);
      if (!w) return null;
      const target = computeDropTarget(layoutRef.current, w.x, w.y, w.k, null, true);
      return target.kind === 'into' ? { docId: target.docId, index: target.index } : null;
    };
    return () => {
      dropResolverRef.current = null;
    };
  }, [dropResolverRef]);
  // Multi-select is view state (never the page-edit tier): a set of selected
  // page ids plus the anchor for shift-range selection. Batched page ops
  // (move/delete/rotate) act on the whole set as one undo step. It
  // lives in the ui slice so command enablement can read it;
  // buffer-identity invalidation moved into the reducer with it.
  const selectedPageIds = state.ui.selectedPageIds;
  const [renderVersion, setRenderVersion] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; docId: string; pageId: string } | null>(
    null,
  );
  // The armed interaction tool — ui slice too (the keymap's Escape chain and
  // the tools.* commands drive it).
  const tool = state.ui.tool;
  const setTool = useCallback(
    (t: CanvasTool) => dispatch({ type: 'UI_SET_TOOL', tool: t }),
    [dispatch],
  );
  // Color picker for the annotation tools: null keeps each tool's own default
  // (yellow highlight, dark freetext, blue ink); a pick applies to whichever
  // tool creates the next annotation, across tool switches.
  const [toolColor, setToolColor] = useState<string | null>(null);
  const [stampPreset, setStampPreset] = useState<StampPreset | null>(null);
  // Shape mode's figure picker (rung 2) — the stamp-preset pattern.
  const [shapeType, setShapeType] = useState<ShapeType>('rect');
  // Measure: the scale ratio the readouts apply, whether a
  // finished measurement lands as an ink markup, and the latest value shown
  // in the secondary toolbar. Session-scoped like toolColor.
  const [measureScale, setMeasureScale] = useState<MeasureScale>(DEFAULT_MEASURE_SCALE);
  const [measureLeaveMarkup, setMeasureLeaveMarkup] = useState(true);
  const [measureResult, setMeasureResult] = useState<string | null>(null);
  // Rung 3 — calibration: the dragged span (PDF points) awaiting its real
  // value in the toolbar; and the right-click recalibrate popover's target.
  const [calibration, setCalibration] = useState<number | null>(null);
  const [recalTarget, setRecalTarget] = useState<{
    docId: string;
    pageId: string;
    annotationId: string;
    x: number;
    y: number;
  } | null>(null);
  // Click-selected annotations (Select tool) — the properties bar's subject
  // and the manipulation group (rung 1). SAME-PAGE by design: align/
  // distribute/z-order are page-geometry operations, and a cross-page
  // "formation move" has no meaning — a gesture on another page starts a new
  // selection there. Transient view state like redaction marks: resolved
  // against the live workspace every render, pruned the moment members stop
  // resolving (commit bakes annotations and empties page.annotations, so no
  // staleness class).
  const [selectedAnnot, setSelectedAnnot] = useState<{
    docId: string;
    pageId: string;
    ids: string[];
  } | null>(null);
  // Pending redaction marks — transient view state, deliberately NOT the
  // page-edit tier (see lib/redaction.ts for why). They survive tool
  // switches and in-memory page edits, and die when their file's buffer
  // changes underneath them or the canvas unmounts.
  const [marks, setMarks] = useState<RedactionMark[]>([]);
  // Detected field candidates — the redaction-mark lifetime exactly: transient,
  // never the page tier, and invalidated on buffer identity. Nothing here has
  // touched the document; accepting a candidate is what does.
  const [fieldCandidates, setFieldCandidates] = useState<FieldCandidate[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  // Detected tables under review. Same lifetime as the candidates above and
  // one step further from the document: accepting a table writes nothing at
  // all, it only decides what the spreadsheet export reads.
  const [tableRegions, setTableRegions] = useState<TableRegion[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [confirmRedact, setConfirmRedact] = useState(false);
  const [redacting, setRedacting] = useState(false);
  const [redactError, setRedactError] = useState<string | null>(null);
  // Pending visible-signature placement — single, transient, same lifecycle
  // as redaction marks (see lib/signature-placement.ts).
  const [sigPlacement, setSigPlacement] = useState<SignaturePlacement | null>(null);
  // Sign-into-an-existing-field target — mutually exclusive with the
  // rubber-band placement; same transient lifecycle.
  const [sigFieldTarget, setSigFieldTarget] = useState<{ path: string; fieldName: string } | null>(
    null,
  );
  const [sigSource, setSigSource] = useState<SignerSource>(EMPTY_SIGNER_SOURCE);
  const [sigPassword, setSigPassword] = useState('');
  const [sigReason, setSigReason] = useState('');
  const [sigLocation, setSigLocation] = useState('');
  // Certification travels beside the signer source and the placement, never
  // inside either: it is orthogonal to both.
  const [sigCertify, setSigCertify] = useState<CertifyOptions>(DEFAULT_CERTIFY);
  // The field lock, on the same card. Independent of certification — a lock
  // binds with no certification present — so it is offered on every signature,
  // and the names come from the target document rather than from typing.
  const [sigLock, setSigLock] = useState<LockOptions>(DEFAULT_LOCK);
  const [sigLockFields, setSigLockFields] = useState<string[]>([]);
  // Whether the document the card targets could still take a certification.
  // Starts false so the offer only ever appears once the read has ANSWERED —
  // showing it first and withdrawing it is worse than showing it a beat late.
  const [sigCanCertify, setSigCanCertify] = useState(false);
  const [signingBusy, setSigningBusy] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signDone, setSignDone] = useState<{ signer: string | null; output: string; ok: boolean } | null>(null);
  const { call: engineCall, callRaw: engineCallRaw } = useEngine();
  // Prime the installed-font listing ONCE per session. It is a
  // property of the machine, not of any document, so it is fetched here
  // (where the engine handle lives) and read from the module cache by the
  // pickers deep in the page tree.
  useEffect(() => {
    primeSystemFonts(engineCall);
  }, [engineCall]);
  // Follow-on: fetch the focused document's page labels. Declared HERE
  // rather than beside `pageLabels` because the engine handle is only in
  // scope from this line down.
  const focusedPath = focusedDoc?.path;
  // Resolve to the working PATH — a stable string — and depend on that, never
  // on `state.files`. The Map gets a fresh identity on every dispatch, so a
  // `state.files` dependency re-fires this effect on every state change: it
  // put a `get_page_labels` in front of the STRICTLY SERIAL engine queue for
  // each one, and an image transform (which dispatches many times) starved
  // behind the flood — e2e 47 timed out at 30s waiting for a rotate that was
  // simply still queued. The engine is FIFO; an effect that fires per
  // dispatch is a denial of service on it.
  const focusedFile = focusedPath ? state.files.get(focusedPath) : undefined;
  const focusedWorkingPath = focusedFile?.workingPath;
  // ── the editor's own spell check ────────────────────────────────────────
  //
  // The paragraph editor renders its own glyph spans, so it draws its own
  // squiggles from THIS app's checker — the webview's cannot see the chosen
  // dictionary or the words the user has added, and two checkers over one
  // document would disagree about individual words.
  //
  // Everything the check needs is resolved lazily and cached: the vendored
  // directory is a Rust-owned constant, and the document's own /Lang costs a
  // file open, which must not happen until someone actually edits text.
  const spellDirsRef = useRef<Promise<{ bundled: string; user: string }> | null>(null);
  const spellLangRef = useRef<Map<string, string>>(new Map());
  const [spellLang, setSpellLang] = useState<string | undefined>(undefined);
  const resolveSpellDirs = useCallback((): Promise<{ bundled: string; user: string }> => {
    if (!spellDirsRef.current) {
      spellDirsRef.current = Promise.all([app.getDictionaryPath(), app.userDictionaryDir()]).then(
        ([bundled, user]) => ({ bundled, user }),
      );
    }
    return spellDirsRef.current;
  }, []);
  const resolveSpellLang = useCallback(
    async (workingPath: string, dirs: { bundled: string; user: string }): Promise<string> => {
      // Keyed on the PREFERENCE as well as the file: changing the dictionary
      // in the Spelling panel must change what the editor underlines, and a
      // cache keyed on the path alone would keep marking in the old language
      // until the document was replaced.
      const key = `${getSettings().spellLanguage} ${workingPath}`;
      const cached = spellLangRef.current.get(key);
      if (cached) return cached;
      const listing = (await engineCall('list_dictionaries', {
        dictionary_dir: dirs.bundled,
        user_dictionary_dir: dirs.user,
      })) as unknown as { dictionaries: DictionaryEntry[] };
      // A document that cannot be read for its /Lang is not an error here —
      // the ladder simply carries on to the interface language.
      let docLang: string | null;
      try {
        const res = (await engineCall('document_language', { file: workingPath })) as unknown as {
          language: string | null;
        };
        docLang = res.language;
      } catch {
        docLang = null;
      }
      const resolved = resolveSpellLanguage(
        getSettings().spellLanguage,
        docLang,
        currentLanguage(),
        listing.dictionaries ?? [],
      );
      spellLangRef.current.set(key, resolved);
      setSpellLang(resolved.replace('_', '-'));
      return resolved;
    },
    [engineCall],
  );
  const handleCheckSpelling = useCallback(
    async (text: string): Promise<Array<{ start: number; end: number }>> => {
      if (!getSettings().spellCheckAsYouType) return [];
      const workingPath = focusedWorkingPath;
      if (!workingPath || !text.trim()) return [];
      const dirs = await resolveSpellDirs();
      const language = await resolveSpellLang(workingPath, dirs);
      const res = (await engineCall('check_text', {
        text,
        language,
        dictionary_dir: dirs.bundled,
        user_dictionary_dir: dirs.user,
        custom_words: loadCustomWords(),
      })) as unknown as { misspelled: Array<{ start: number; end: number }> };
      return res.misspelled ?? [];
    },
    [engineCall, resolveSpellDirs, resolveSpellLang, focusedWorkingPath],
  );
  // BUFFER IDENTITY is the refresh trigger, the workspace's own rule: any
  // edit that could re-number the pages replaces the buffer object, and
  // nothing else does. Page count alone would miss a labels EDIT (the Page
  // Labels panel rewrites the ranges without touching the page count).
  const focusedBuffer = focusedFile?.buffer;
  useEffect(() => {
    let stale = false;
    setPageLabels([]);
    if (!focusedWorkingPath) return;
    // Read-only, so it rides the ungated method list; a document with no
    // /PageLabels answers with the plain numbers and `hasCustomLabels`
    // says no, which keeps every path on the shipped sheet-number readout.
    void engineCall('get_page_labels', { file: focusedWorkingPath })
      .then((res) => {
        const labels = (res as unknown as { labels?: unknown }).labels;
        if (!stale && Array.isArray(labels)) {
          setPageLabels(labels.map((l) => (typeof l === 'string' ? l : '')));
        }
      })
      .catch(() => {
        /* Labels are a convenience — a document that cannot answer keeps
           the sheet-number readout it has always had. */
      });
    return () => {
      stale = true;
    };
    // The page COUNT is a dependency deliberately: deleting or inserting
    // pages re-numbers the labels, and a stale list would send the reader to
    // the wrong sheet (`resolvePageEntry` refuses an out-of-range one, but
    // an in-range wrong one it cannot see).
  }, [focusedWorkingPath, focusedBuffer, engineCall]);

  // ── Read Out Loud ───────────────────────────────────────────────────────
  //
  // The reader is transient view state bound to BYTES: its blocks and their
  // rectangles were listed from one buffer, so the target list is keyed on the
  // page ids AND the buffer identity, and the hook stops the moment either
  // moves. `state.files` is deliberately absent from the deps — the Map is
  // rebuilt on every dispatch, and depending on it would stop the reader on
  // every keystroke elsewhere in the app (the page-labels lesson).
  const readAloudFilesRef = useRef(state.files);
  readAloudFilesRef.current = state.files;
  const focusedWorkingPathRef = useRef(focusedWorkingPath);
  focusedWorkingPathRef.current = focusedWorkingPath;
  const readAloudKey =
    docViewMode === 'document' && focusedDoc
      ? `${focusedDoc.id}|${focusedDoc.pages.map((p) => p.id).join(',')}`
      : '';
  const readAloudTargets = useMemo<ReadAloudTarget[]>(() => {
    const doc = focusedDocRef.current;
    if (!readAloudKey || !doc) return [];
    const out: ReadAloudTarget[] = [];
    for (const page of doc.pages) {
      const file = readAloudFilesRef.current.get(page.sourceDocId);
      if (!file?.workingPath) continue;
      out.push({
        pageId: page.id,
        workingPath: file.workingPath,
        pageNumber: page.sourcePageIndex + 1,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readAloudKey, focusedBuffer]);
  const readAloudGeometry = useCallback(async (target: ReadAloudTarget) => {
    const doc = focusedDocRef.current;
    const page = doc?.pages.find((p) => p.id === target.pageId);
    if (!page) throw new Error('page gone');
    const file = readAloudFilesRef.current.get(page.sourceDocId);
    if (!file?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
    const proxy = await getDocumentProxy(page.sourceDocId, file.buffer);
    const p = await proxy.getPage(page.sourcePageIndex + 1);
    const [vx0, vy0, vx1, vy1] = p.view;
    return {
      box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
      bakedRotate: p.rotate,
    };
  }, []);
  // The document's own /Lang, read ONCE per document and only when a reading
  // run actually starts. Cached on the working path, so a second run on the
  // same document costs nothing.
  const readAloudLangRef = useRef<Map<string, string>>(new Map());
  const resolveReadingLocale = useCallback(async (): Promise<string> => {
    const workingPath = focusedWorkingPathRef.current;
    if (!workingPath) return readingLocale(null, currentLanguage());
    const cached = readAloudLangRef.current.get(workingPath);
    if (cached !== undefined) return cached;
    let docLang: string | null = null;
    try {
      const res = (await engineCall('document_language', { file: workingPath })) as unknown as {
        language: string | null;
      };
      docLang = res.language;
    } catch {
      // A document that cannot be read for its /Lang is not an error here —
      // the ladder simply carries on to the interface language.
    }
    const resolved = readingLocale(docLang, currentLanguage());
    readAloudLangRef.current.set(workingPath, resolved);
    return resolved;
  }, [engineCall]);
  const reader = useReadAloud({
    engineCall,
    targets: readAloudTargets,
    geometryOf: readAloudGeometry,
    currentIndex: currentPage - 1,
    resetKey: readAloudKey,
    resolveLocale: resolveReadingLocale,
    onShowPage: (pageId) => activeCanvasHandle()?.centerOn(pageId),
    onPersist: ({ voice, rate }) => {
      const settings = getSettings();
      saveSettings({
        ...settings,
        ...(voice !== undefined ? { readAloudVoice: voice } : {}),
        ...(rate !== undefined ? { readAloudRate: rate } : {}),
      });
    },
    initialVoice: getSettings().readAloudVoice,
    initialRate: getSettings().readAloudRate,
  });
  const readerRef = useRef(reader);
  readerRef.current = reader;
  // One entry, always — the reader speaks one block at a time. Shaped as a
  // per-page map so it rides the SAME plumbing the find-word boxes do rather
  // than threading a second kind of overlay through four components.
  const readAloudByPage = useMemo(() => {
    const highlight = reader.highlight;
    if (!highlight) return NO_READ_ALOUD;
    return new Map([
      [
        highlight.pageId,
        { block: highlight.block, sentence: highlight.sentence, word: highlight.word },
      ],
    ]);
  }, [reader.highlight]);

  // Find/OCR: the ONE workspace search index, lifted to a provider so the
  // Search nav panel shares it (double-instantiating would
  // double the OCR work and desync results). Ctrl+F opens the bar.
  const searchIndex = useSearchContext();
  // The Search & Redact panel's OCR arm reads the index through
  // the services seam, which is registered once — so it reaches the CURRENT
  // index through a ref rather than a captured one.
  const searchIndexRef = useRef(searchIndex);
  searchIndexRef.current = searchIndex;
  // A jump that lands in a document the current view isn't showing. The board
  // renders every doc, so it can always centre directly; the reading view shows
  // exactly ONE, so a match in another file (or another `.pdfx` partition) has
  // to bring that document to the front FIRST and centre once it has mounted —
  // otherwise `centerOn` finds no such page and returns silently while Find's
  // "N of M" counter has already advanced (regression).
  //
  // This is THE jump entry point for every caller that can name a page in any
  // open document — Find/Search, the comments sidebar, and the Pages/Bookmarks
  // nav panels (which list every partition of the active file, so they hit the
  // same blindness; regression: they were still calling `centerOn` directly
  // and silently no-oped into a partition the reading view wasn't showing).
  // Only the reading view's own page box may bypass it — it is scoped to the
  // shown document by definition.
  const jumpToPage = useCallback(
    (pageId: string) => {
      const owner = docsRef.current.find((d) => d.pages.some((p) => p.id === pageId));
      if (!owner) return;
      if (docViewModeRef.current === 'document' && owner.id !== focusedDocRef.current?.id) {
        pendingJumpRef.current = pageId;
        dispatch({ type: 'UI_FOCUS_DOC', docId: owner.id });
        return; // the flush effect centres once that doc's view is mounted
      }
      activeCanvasHandle()?.centerOn(pageId);
    },
    [activeCanvasHandle, dispatch],
  );
  const find = useFind(searchIndex.search, searchIndex.version, docs, jumpToPage);
  const [applyingOcr, setApplyingOcr] = useState(false);
  const [ocrApplyError, setOcrApplyError] = useState<string | null>(null);

  // On-canvas forms: per-file field reads + widget projections, and
  // the pending-values map. Pending values are NAME-keyed per file —
  // deliberately not the positional-id lifecycle of marks/selection: a field
  // name survives page edits and commits, so half-typed values survive an
  // Apply-changes; they are PRUNED against every settled re-read instead
  // (name gone / no longer editable / shape mismatch / file closed).
  const workspaceForms = useWorkspaceForms(state.files, engineCall);
  const [pendingFormValues, setPendingFormValues] =
    useState<ReadonlyMap<string, ReadonlyMap<string, FormFieldValue>>>(NO_FORM_VALUES);
  const [fillingForms, setFillingForms] = useState(false);
  const [formsError, setFormsError] = useState<string | null>(null);
  useEffect(() => {
    const formsByPath = new Map([...workspaceForms].map(([p, info]) => [p, info.fields]));
    setPendingFormValues((prev) => pruneFormValues(prev, formsByPath));
  }, [workspaceForms]);

  const onSetFormValue = useCallback((path: string, fieldName: string, value: FormFieldValue) => {
    setPendingFormValues((prev) => {
      const next = new Map(prev);
      const inner = new Map(next.get(path) ?? []);
      inner.set(fieldName, value);
      next.set(path, inner);
      return next;
    });
  }, []);

  const clearFormValues = useCallback(() => setPendingFormValues(NO_FORM_VALUES), []);

  // What the widgets DRAW: the values the user typed plus the dependents the
  // document's own /CO computes from them. The computed half is derived here
  // rather than written into `pendingFormValues`, because the fill names what
  // that map holds and a calculated Total is routinely read-only — which the
  // engine's fill refuses by name. The engine runs the same pass over the same
  // /CO when the fill lands, so the previewed value and the saved one come
  // from one rule either way.
  const formDisplayValues = useMemo(() => {
    if (workspaceForms.size === 0) return pendingFormValues;
    let changed = false;
    const next = new Map<string, ReadonlyMap<string, FormFieldValue>>(pendingFormValues);
    for (const [path, info] of workspaceForms) {
      const computed = computedValues(info.calculation, info.fields, pendingFormValues.get(path));
      if (computed.size === 0) continue;
      const merged = new Map<string, FormFieldValue>(next.get(path) ?? []);
      for (const [name, value] of computed) merged.set(name, value);
      next.set(path, merged);
      changed = true;
    }
    return changed ? next : pendingFormValues;
  }, [workspaceForms, pendingFormValues]);

  // pageId -> widgets, resolved through (sourceDocId, sourcePageIndex) — an
  // in-memory moved page keeps its widgets because both travel with the ref.
  const formWidgetsByPage = useMemo(() => {
    if (workspaceForms.size === 0) return NO_WIDGETS_BY_PAGE;
    const map = new Map<string, OverlayWidget[]>();
    for (const doc of docs) {
      for (const page of doc.pages) {
        const widgets = workspaceForms.get(page.sourceDocId)?.widgetsByPage.get(page.sourcePageIndex);
        if (widgets && widgets.length > 0) map.set(page.id, widgets);
      }
    }
    return map.size > 0 ? map : NO_WIDGETS_BY_PAGE;
  }, [workspaceForms, docs]);

  const pendingFormCount = useMemo(() => {
    let n = 0;
    for (const [, values] of pendingFormValues) n += values.size;
    return n;
  }, [pendingFormValues]);

  // Add-field sub-mode: while armed, forms mode draws a placement
  // band. The placement itself is transient view state with the
  // signature-placement lifecycle: single (drawing again replaces), dies on
  // buffer-identity change or when its page leaves the workspace.
  const [newFieldPlacement, setNewFieldPlacement] = useState<SignaturePlacement | null>(null);
  const [nfName, setNfName] = useState('');
  const [nfType, setNfType] = useState<NewFieldType>('text');
  const [nfOptions, setNfOptions] = useState('');
  const [nfMultiline, setNfMultiline] = useState(false);
  // The `/Lock` seed a new SIGNATURE field is authored with — what whoever
  // signs it later is bound by, placed without the preparer signing anything.
  const [nfLock, setNfLock] = useState<LockOptions>(DEFAULT_LOCK);
  const [creatingField, setCreatingField] = useState(false);
  const [nfError, setNfError] = useState<string | null>(null);
  const onSetNewFieldRect = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      // Anchor only to CURRENT ids: docs indexed from a
      // superseded buffer are about to be re-identified (fresh generation),
      // so a placement drawn against them is stillborn — refuse it rather
      // than arm a box that dies at SET_WORKSPACE_DOCUMENTS moments later.
      if (!placementDocsCurrent(state.files, docs, doc.path)) return;
      setNewFieldPlacement({ id: crypto.randomUUID(), path: doc.path, pageId, rect, rotationAtDraw });
      setSigPlacement(null); // one placement card at a time (see onSetSignaturePlacement)
      setAddTextPlacement(null); // …including the Add-Text card
      setNfError(null);
    },
    [docs, state.files],
  );
  const onClearNewFieldPlacement = useCallback(() => setNewFieldPlacement(null), []);

  // The names a new signature field's lock can choose from: the placement
  // document's own fillable fields. Read from the workspace forms index rather
  // than through a fresh engine call — it is the same read, already settled.
  const newFieldLockNames = useMemo(() => {
    const path = newFieldPlacement?.path;
    if (!path) return NO_LOCK_NAMES;
    return (workspaceForms.get(path)?.fields ?? [])
      .filter((f) => f.type !== 'signature')
      .map((f) => f.name);
  }, [newFieldPlacement, workspaceForms]);

  // Placement whose page still exists (mirrors liveSigPlacement).
  const liveNewFieldPlacement = useMemo(() => {
    if (!newFieldPlacement) return null;
    return docs.some((d) => d.pages.some((p) => p.id === newFieldPlacement.pageId))
      ? newFieldPlacement
      : null;
  }, [newFieldPlacement, docs]);

  // Create the placed field via App's whole-file op. The display→PDF
  // conversion is buildSignatureAppearance verbatim — a placement is a
  // placement; it returns the file path, the 1-based committed-order page,
  // and the PDF user-space rect the authoring lib expects. Takes explicit
  // params (not the card's state) so the harness can drive the same path
  // without racing React batching; rejects on failure so callers see it.
  const creatingFieldRef = useRef(false);
  const createFieldFromPlacement = useCallback(
    async (params: {
      name: string;
      type: NewFieldType;
      options?: string[];
      multiline?: boolean;
      lock?: LockOptions;
    }): Promise<void> => {
      if (creatingFieldRef.current) return; // re-entry: the button is disabled while creating
      const placement = liveNewFieldPlacement;
      // The placement is transient view state that dies with its page id; a
      // buffer change between place and create kills it, and while that
      // change's reindex is still in flight the surviving ids are about to
      // rotate — converting sourcePageIndex against the new bytes could land
      // the field on the wrong page. Silently resolving here made a skipped
      // create indistinguishable from a done one (the 18-canvas-forms load
      // flake: a 30s wait for a field that was never created) — reject.
      if (!placement || !placementDocsCurrent(state.files, docs, placement.path)) {
        const msg = tChrome('canvas.newfield.pageChanged');
        setNfError(msg);
        throw new Error(msg);
      }
      creatingFieldRef.current = true;
      setCreatingField(true);
      setNfError(null);
      try {
        const built = await buildSignatureAppearance(docs, placement, async (page) => {
          const f = state.files.get(page.sourceDocId);
          if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
          const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
        });
        if (!built) throw new Error(tChrome('canvas.newfield.pageGone'));
        await onAddFormField(built.path, {
          name: params.name.trim(),
          type: params.type,
          pageIndex: built.appearance.page - 1,
          rect: built.appearance.rect,
          ...(params.options && params.options.length > 0 ? { options: params.options } : {}),
          ...(params.type === 'text' && params.multiline ? { multiline: true } : {}),
          // Only a signature field carries one, and only the two list actions
          // carry names — `all` ignores them, so sending them would discard
          // what was chosen (the write refuses that pair).
          ...(params.type === 'signature' && params.lock && params.lock.action !== null
            ? {
                lock: {
                  action: params.lock.action,
                  fields: lockNeedsFields(params.lock.action) ? params.lock.fields : [],
                },
              }
            : {}),
        });
        // Created — reset the authoring surfaces; stay in forms mode so the
        // new field is immediately fillable.
        setNewFieldPlacement(null);
        setNfName('');
        setNfOptions('');
        setNfMultiline(false);
        setNfLock(DEFAULT_LOCK);
        // Stay in Prepare Form's own mode, ready to place the next field.
        //
        // NOT 'select' (the widget renders nothing outside a form mode, so the
        // field the user just placed would VANISH — the popup promises it is
        // "fillable right away"), and NOT 'forms': that is Fill & Sign's mode,
        // so the secondary toolbar's title would flip to another tool mid-task
        // and the rubber band would die — `formfields` is what draws it, so the
        // next field couldn't be placed at all, with nothing on screen saying
        // why. `showsFormWidgets` covers both modes, so the promise holds here.
        dispatch({ type: 'UI_SET_TOOL', tool: 'formfields' });
      } catch (err) {
        setNfError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        creatingFieldRef.current = false;
        setCreatingField(false);
      }
    },
    [liveNewFieldPlacement, docs, state.files, onAddFormField, dispatch],
  );
  const createPlacedField = useCallback(async (): Promise<void> => {
    const options =
      nfType === 'radio' || nfType === 'dropdown' || nfType === 'optionlist'
        ? nfOptions.split(/[\n,]/).map((o) => o.trim()).filter(Boolean)
        : undefined;
    await createFieldFromPlacement({
      name: nfName,
      type: nfType,
      ...(options ? { options } : {}),
      multiline: nfMultiline,
      lock: nfLock,
    }).catch(() => undefined); // surfaced via nfError; the card stays open
  }, [createFieldFromPlacement, nfName, nfType, nfOptions, nfMultiline, nfLock]);

  // --- Add Text ------------------------------------------------------
  // Same placement lifecycle as the new-field card (single, transient, dies
  // when its page leaves). The band draws the box; this card collects the
  // text/size/colour/family; commit runs the display→PDF rect conversion
  // (buildSignatureAppearance, verbatim) and routes onAddText.
  const [addTextPlacement, setAddTextPlacement] = useState<SignaturePlacement | null>(null);
  const [atText, setAtText] = useState('');
  const [atSize, setAtSize] = useState(12);
  // Per-span styling — spans over atText's character positions,
  // captured from the textarea's live selection. Any TEXT change clears
  // them (positions would silently drift under arbitrary edits; a visible
  // reset is the predictable rule) — the card notes it.
  const [atSpans, setAtSpans] = useState<
    { start: number; end: number; size?: number; color?: [number, number, number]; bold?: boolean; italic?: boolean }[]
  >([]);
  const [atSpanSize, setAtSpanSize] = useState('');
  const [atSpanColor, setAtSpanColor] = useState<string | null>(null);
  const [atSpanBold, setAtSpanBold] = useState(false);
  const [atSpanItalic, setAtSpanItalic] = useState(false);
  const atTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Authoring-time rotation (90-deg steps; sticky like size/family).
  // Any finite degree value — the step button cycles quarters, the
  // number field takes free angles.
  const [atRotate, setAtRotate] = useState<number>(0);
  // Whole-box style toggles (sticky) + the live fit result
  // (null = unknown/measuring; the notice shows only on a definite no).
  const [atBold, setAtBold] = useState(false);
  const [atItalic, setAtItalic] = useState(false);
  // OpenType features (sticky like the other style toggles). Authoring
  // renders in a bundled face, so a feature switches to Libertinus Serif;
  // alternates picks its glyph by index.
  const [atSmallCaps, setAtSmallCaps] = useState(false);
  const [atAlternates, setAtAlternates] = useState(false);
  const [atAltIndex, setAtAltIndex] = useState(0);
  // Pair kerning, ON by default (correct typography is the right
  // default and is what the fit measurement assumes); the toggle is an
  // opt-OUT, and only that opt-out is ever sent.
  const [atKern, setAtKern] = useState(true);
  const [atFits, setAtFits] = useState<boolean | null>(null);
  const [atColor, setAtColor] = useState('#000000');
  const [atFamily, setAtFamily] = useState<'sans' | 'serif' | 'mono'>('sans');
  const [atError, setAtError] = useState<string | null>(null);
  const [creatingText, setCreatingText] = useState(false);
  const onSetAddTextRect = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      // Anchor only to CURRENT ids — the onSetNewFieldRect rule:
      // The sibling flows shared the silent-no-op
      // pattern without the guard). A placement drawn against docs indexed
      // from a superseded buffer dies at SET_WORKSPACE_DOCUMENTS — refuse.
      if (!placementDocsCurrent(state.files, docs, doc.path)) return;
      setAddTextPlacement({
        id: crypto.randomUUID(),
        path: doc.path,
        pageId,
        rect,
        rotationAtDraw,
        rotate: atRotate,
      });
      setSigPlacement(null); // one placement card at a time…
      setNewFieldPlacement(null);
      setSigFieldTarget(null); // …including the sign-into-field card (renders on sigFieldTarget)
      setAtText('');
      setAtError(null);
    },
    [docs, state.files, atRotate],
  );
  // --- Crop draw ------------------------------------------------------
  // The band is the region to KEEP. Nothing commits here: the insets are
  // computed where the page's own view box and baked rotation are reachable,
  // then published to the Page Boxes panel, which owns Apply — so a drawn
  // crop and a typed one go through the identical `set_page_boxes` call and a
  // mis-drag costs a redraw rather than an undo. The placement card is the
  // same transient, single, page-anchored lifecycle as Add-Text's.
  const [cropPlacement, setCropPlacement] = useState<SignaturePlacement | null>(null);
  const onSetCropRect = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      const page = doc?.pages.find((p) => p.id === pageId);
      if (!doc || !page) return;
      // Anchor only to CURRENT ids — the onSetNewFieldRect rule.
      if (!placementDocsCurrent(state.files, docs, doc.path)) return;
      const f = state.files.get(page.sourceDocId);
      if (!f?.buffer) return;
      const buffer = f.buffer;
      void (async () => {
        const proxy = await getDocumentProxy(page.sourceDocId, buffer);
        const p = await proxy.getPage(page.sourcePageIndex + 1);
        const [vx0, vy0, vx1, vy1] = p.view;
        // The band was drawn on the page AS DISPLAYED, so the conversion
        // measures against the displayed extents — which swap under a
        // quarter turn. `rotationAtDraw` is the in-memory delta; the baked
        // /Rotate is already in `p.view`'s orientation via the same
        // composition every placement uses.
        const turned = rotationAtDraw === 90 || rotationAtDraw === 270;
        const dw = turned ? vy1 - vy0 : vx1 - vx0;
        const dh = turned ? vx1 - vx0 : vy1 - vy0;
        const insets = insetsFromBand(rect, dw, dh, rotationAtDraw);
        if (!insets) return; // a click, not a crop
        // The page NUMBER and the target path are the workspace doc's — the
        // panel crops `activeFile`, which is that file, not the file an
        // imported page's bytes happen to come from. Only the geometry read
        // above uses sourceDocId.
        const number = workspacePageNumber(docs, doc, page.id);
        if (number === null) return;
        publishDrawnCrop({ ...roundInsets(insets), page: number, path: doc.path });
        setCropPlacement({ id: crypto.randomUUID(), path: doc.path, pageId, rect, rotationAtDraw });
      })();
    },
    [docs, state.files],
  );
  const onClearCropPlacement = useCallback(() => setCropPlacement(null), []);
  // --- Article bead draw ----------------------------------------------
  // The crop draw's contract, one derivation over: the band becomes a rect in
  // the page's own user space and is PUBLISHED to the Articles panel, which
  // owns Save. Nothing reaches the document here, so a mis-drag costs a
  // redraw rather than an undo — and the geometry read is the same one the
  // crop uses, so a turned page cannot mean two different things.
  const onSetBeadRect = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      const page = doc?.pages.find((p) => p.id === pageId);
      if (!doc || !page) return;
      if (!placementDocsCurrent(state.files, docs, doc.path)) return;
      const f = state.files.get(page.sourceDocId);
      if (!f?.buffer) return;
      const buffer = f.buffer;
      void (async () => {
        const proxy = await getDocumentProxy(page.sourceDocId, buffer);
        const p = await proxy.getPage(page.sourcePageIndex + 1);
        const view = p.view as [number, number, number, number];
        const bead = beadRectFromBand(rect, view, rotationAtDraw);
        if (!bead) return; // a click, not a box
        const number = workspacePageNumber(docs, doc, page.id);
        if (number === null) return;
        publishDrawnBead({ page: number, rect: bead, path: doc.path });
      })();
    },
    [docs, state.files],
  );
  // --- Snapshot -------------------------------------------------------
  // The band's contract again, with one difference that matters: the capture
  // runs on release rather than waiting for an Apply. There is nothing to
  // confirm — the document is not touched, and a clipboard write the reader
  // did not want costs them one more copy. What is left behind is the card,
  // carrying the raster so *Save image…* writes the SAME pixels the
  // clipboard holds rather than re-rendering a second, possibly different,
  // one.
  const [snapshotPlacement, setSnapshotPlacement] = useState<SnapshotPlacement | null>(null);
  const snapshotPlacementRef = useRef<SnapshotPlacement | null>(null);
  snapshotPlacementRef.current = snapshotPlacement;
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const capturingRef = useRef(false);
  const onSetSnapshotRect = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      const page = doc?.pages.find((p) => p.id === pageId);
      if (!doc || !page) return;
      if (!placementDocsCurrent(state.files, docs, doc.path)) return;
      const f = state.files.get(page.sourceDocId);
      if (!f?.buffer) return;
      const buffer = f.buffer;
      // One capture at a time: a second band while the first is still
      // rendering would race two writers for one clipboard.
      if (capturingRef.current) return;
      capturingRef.current = true;
      void (async () => {
        try {
          const proxy = await getDocumentProxy(page.sourceDocId, buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const shot = await captureSnapshot(p, rect, rotationAtDraw, getSettings().snapshotDpi);
          if (!shot) return; // a click, not a capture
          setSnapshotError(null);
          setSnapshotPlacement({
            id: crypto.randomUUID(),
            path: doc.path,
            pageId,
            rect,
            rotationAtDraw,
            width: shot.clipboard.width,
            // A positive DIB height means bottom-up rows, which is what is
            // written; the card reports the extent either way.
            height: Math.abs(shot.clipboard.height),
            formats: shot.clipboard.formats,
            png: shot.png,
          });
        } catch (e: unknown) {
          setSnapshotPlacement(null);
          setSnapshotError(e instanceof Error ? e.message : String(e));
        } finally {
          capturingRef.current = false;
        }
      })();
    },
    [docs, state.files],
  );
  const onClearSnapshotPlacement = useCallback(() => {
    setSnapshotPlacement(null);
    setSnapshotError(null);
  }, []);
  // The write, separate from the dialog that chooses where: the dialog is
  // OS-modal and unreachable from a spec, and this is what the button does
  // once it has an answer.
  const writeSnapshotTo = useCallback(
    async (dest: string): Promise<string> => {
      const shot = snapshotPlacementRef.current;
      if (!shot) throw new Error('no capture is on the page');
      const path = /\.png$/i.test(dest) ? dest : `${dest}.png`;
      return imageClipboard.savePng(shot.png, path);
    },
    [],
  );
  const onSaveSnapshot = useCallback(() => {
    if (!snapshotPlacement) return;
    void (async () => {
      try {
        const dest = await dialog.saveImageFile('snapshot.png');
        if (!dest) return;
        await writeSnapshotTo(dest);
      } catch (e: unknown) {
        setSnapshotError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [snapshotPlacement, writeSnapshotTo]);
  // The card dies with its page, like every other placement.
  const liveSnapshotPlacement = useMemo(() => {
    if (!snapshotPlacement) return null;
    return docs.some((d) => d.pages.some((p) => p.id === snapshotPlacement.pageId))
      ? snapshotPlacement
      : null;
  }, [snapshotPlacement, docs]);
  // Placement whose page still exists (mirrors liveAddTextPlacement).
  const liveCropPlacement = useMemo(() => {
    if (!cropPlacement) return null;
    return docs.some((d) => d.pages.some((p) => p.id === cropPlacement.pageId))
      ? cropPlacement
      : null;
  }, [cropPlacement, docs]);
  const onClearAddTextPlacement = useCallback(() => {
    setAddTextPlacement(null);
    setAtError(null);
  }, []);

  // Placement whose page still exists (mirrors liveNewFieldPlacement).
  const liveAddTextPlacement = useMemo(() => {
    if (!addTextPlacement) return null;
    return docs.some((d) => d.pages.some((p) => p.id === addTextPlacement.pageId))
      ? addTextPlacement
      : null;
  }, [addTextPlacement, docs]);

  // Author the placed text via App's engine op. Display→PDF is
  // buildSignatureAppearance verbatim; explicit params so the harness can
  // drive the same path without racing React batching.
  const creatingTextRef = useRef(false);
  const commitAddText = useCallback(
    async (params: {
      text: string;
      size?: number;
      color?: [number, number, number];
      family?: 'sans' | 'serif' | 'mono';
      rotate?: number;
      bold?: boolean;
      italic?: boolean;
      /** Pair kerning — ON by default engine-side, so only `false`
       * travels. */
      kern?: boolean;
      /** OpenType features. */
      smallCaps?: boolean;
      alternates?: boolean;
      altIndex?: number;
      /** Per-span styling over the text's character positions. */
      spans?: {
        start: number;
        end: number;
        size?: number;
        color?: [number, number, number];
        bold?: boolean;
        italic?: boolean;
      }[];
    }): Promise<void> => {
      if (creatingTextRef.current) return; // re-entry: the button is disabled while creating
      const placement = liveAddTextPlacement;
      // Same reject-loudly rule as createFieldFromPlacement:
      // a buffer change between place and commit kills the placement, and
      // while its reindex is in flight the surviving ids are about to rotate
      // — converting sourcePageIndex against the new bytes could land the
      // text on the wrong page. Silently resolving made a skipped commit
      // indistinguishable from a done one — reject.
      if (!placement || !placementDocsCurrent(state.files, docs, placement.path)) {
        const msg = tChrome('canvas.addtext.pageChanged');
        setAtError(msg);
        throw new Error(msg);
      }
      if (!params.text.trim()) {
        setAtError(tChrome('canvas.addtext.enterText'));
        return;
      }
      creatingTextRef.current = true;
      setCreatingText(true);
      setAtError(null);
      try {
        const built = await buildSignatureAppearance(docs, placement, async (page) => {
          const f = state.files.get(page.sourceDocId);
          if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
          const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
        });
        if (!built) throw new Error(tChrome('canvas.addtext.pageGone'));
        const result = await onAddText(
          built.path,
          built.appearance.page,
          built.appearance.rect,
          params.text,
          {
            ...(params.size !== undefined ? { size: params.size } : {}),
            ...(params.color !== undefined ? { color: params.color } : {}),
            ...(params.family !== undefined ? { family: params.family } : {}),
            // rotate=0 sends NOTHING — the engine's no-param path is pinned
            // byte-identical to an unrotated authored box. The
            // style toggles share the rule (false sends nothing).
            ...(params.rotate ? { rotate: params.rotate } : {}),
            ...(params.bold ? { bold: true } : {}),
            ...(params.italic ? { italic: true } : {}),
            // Inverts the send-nothing rule: kerning is ON by default,
            // so only an explicit opt-OUT travels.
            ...(params.kern === false ? { kern: false } : {}),
            // Features (send-nothing when off, byte-identical no-feature
            // path). alt_index travels only with alternates.
            ...(params.smallCaps || params.alternates
              ? {
                  features: [
                    ...(params.smallCaps ? ['small_caps'] : []),
                    ...(params.alternates ? ['salt'] : []),
                  ],
                  ...(params.alternates ? { alt_index: params.altIndex ?? 0 } : {}),
                }
              : {}),
            // Per-span styling (send-nothing when unstyled — the
            // spanless path stays byte-identical).
            ...(params.spans && params.spans.length > 0 ? { spans: params.spans } : {}),
          },
        );
        // Signed-doc refusal — keep the card open (the user can cancel).
        if (result === EDIT_DECLINED) return;
        setAddTextPlacement(null);
        setAtText('');
        setAtSpans([]);
      } catch (err) {
        setAtError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        creatingTextRef.current = false;
        setCreatingText(false);
      }
    },
    [liveAddTextPlacement, docs, state.files, onAddText],
  );
  // The live fit indicator — measure_text_box is the SAME
  // layout pass the author op runs (one shared engine function), called
  // debounced so the card can warn before commit. Non-blocking by design
  // (the box is a guide, not a clip); errors just clear the notice (the
  // commit path surfaces real failures).
  useEffect(() => {
    const placement = liveAddTextPlacement;
    if (!placement || !atText.trim()) {
      setAtFits(null);
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const built = await buildSignatureAppearance(docs, placement, async (page) => {
            const f = state.files.get(page.sourceDocId);
            if (!f?.buffer) throw new Error('no buffer');
            const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
            const p = await proxy.getPage(page.sourcePageIndex + 1);
            const [vx0, vy0, vx1, vy1] = p.view;
            return {
              box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
              bakedRotate: p.rotate,
            };
          });
          if (!built || stale) return;
          const f = state.files.get(built.path);
          if (!f) return;
          const res = (await engineCall('measure_text_box', {
            file: f.workingPath,
            page: built.appearance.page,
            rect: built.appearance.rect,
            text: atText,
            size: atSize,
            font_path: await app.getEditFontPath(),
            family: atFamily,
            ...(atRotate ? { rotate: atRotate } : {}),
            ...(atBold ? { bold: true } : {}),
            ...(atItalic ? { italic: true } : {}),
            // The fit indicator MUST measure with the same kerning the commit
            // will use, or the card could promise a fit the commit breaks.
            ...(atKern ? {} : { kern: false }),
            // Measure with the SAME features the commit applies — small
            // caps change advances, so a plain measurement could promise a fit
            // the small-caps commit then breaks (the kerning discipline).
            ...(atSmallCaps || atAlternates
              ? {
                  features: [
                    ...(atSmallCaps ? ['small_caps'] : []),
                    ...(atAlternates ? ['salt'] : []),
                  ],
                  ...(atAlternates ? { alt_index: atAltIndex } : {}),
                }
              : {}),
            // The fit indicator measures with the SAME spans the commit
            // sends (mixed sizes change line heights — the discipline).
            ...(atSpans.length > 0 ? { spans: atSpans } : {}),
          })) as { fits?: boolean };
          if (!stale) setAtFits(typeof res?.fits === 'boolean' ? res.fits : null);
        } catch {
          if (!stale) setAtFits(null);
        }
      })();
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [
    liveAddTextPlacement,
    atText,
    atSize,
    atFamily,
    atRotate,
    atBold,
    atItalic,
    atKern,
    atSmallCaps,
    atAlternates,
    atAltIndex,
    atSpans,
    docs,
    state.files,
    engineCall,
  ]);

  const createPlacedText = useCallback(async (): Promise<void> => {
    await commitAddText({
      text: atText,
      size: atSize,
      color: hexToRgb(atColor) ?? [0, 0, 0],
      family: atFamily,
      rotate: atRotate,
      bold: atBold,
      italic: atItalic,
      kern: atKern,
      smallCaps: atSmallCaps,
      alternates: atAlternates,
      altIndex: atAltIndex,
      ...(atSpans.length > 0 ? { spans: atSpans } : {}),
    }).catch(() => undefined); // surfaced via atError; the card stays open
  }, [
    atSpans,
    commitAddText,
    atText,
    atSize,
    atColor,
    atFamily,
    atRotate,
    atBold,
    atItalic,
    atKern,
    atSmallCaps,
    atAlternates,
    atAltIndex,
  ]);

  // Bake pending values file by file through App's fill op. Reentrancy-ref'd
  // like applyMarks (two clicks in one tick both read a stale busy flag).
  const fillingRef = useRef(false);
  const applyFormValues = useCallback(async (): Promise<string[]> => {
    if (fillingRef.current) return [];
    const snapshot = pendingFormValues;
    if (snapshot.size === 0) return [];
    fillingRef.current = true;
    setFillingForms(true);
    setFormsError(null);
    try {
      const failures: string[] = [];
      for (const [path, values] of snapshot) {
        try {
          await onFillFormValues(path, Object.fromEntries(values));
          // Applied — drop this file's pending values (the re-read will show
          // them as the fields' current values).
          setPendingFormValues((prev) => {
            if (!prev.has(path)) return prev;
            const next = new Map(prev);
            next.delete(path);
            return next;
          });
        } catch (err) {
          const name = path.split(/[\\/]/).pop() || path;
          failures.push(
            tChrome('canvas.common.fileFailure', {
              name,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
      if (failures.length > 0) {
        setFormsError(tChrome('canvas.forms.fillFailed', { reasons: failures.join('; ') }));
      }
      return failures;
    } finally {
      fillingRef.current = false;
      setFillingForms(false);
    }
  }, [pendingFormValues, onFillFormValues]);

  // Workspace-flattened page order (doc order, then page order) — the basis
  // for workspace-order group moves (selection semantics themselves moved
  // into the reducer with the ui slice). Refs keep the harness registration
  // stable while reading the latest order/selection.
  const flatOrder = useMemo(() => docs.flatMap((d) => d.pages.map((p) => p.id)), [docs]);
  const flatOrderRef = useRef(flatOrder);
  flatOrderRef.current = flatOrder;
  const selectionRef = useRef(selectedPageIds);
  selectionRef.current = selectedPageIds;

  // Keyboard shortcuts (Escape chain, Ctrl+F, select-all/delete/rotate/zoom)
  // are owned by the app-level keymap dispatcher now (commands/keymap.ts) —
  // the canvas registers its camera + find services for the commands instead
  // of its own window listeners.
  const findRef = useRef(find);
  findRef.current = find;
  const jumpToPageRef = useRef(jumpToPage);
  jumpToPageRef.current = jumpToPage;
  const docsForJumpRef = useRef(docs);
  docsForJumpRef.current = docs;
  const openPageForReadingRef = useRef<(pageId: string) => void>(() => {});
  useEffect(() => {
    registerCanvasServices({
      canvas: () => activeCanvasHandle(),
      // Cross-document-aware jump. Panels MUST use this rather than
      // `canvas().centerOn` — the reading view shows one document, so centring
      // a page in another one silently does nothing.
      jumpToPage: (pageId) => jumpToPageRef.current(pageId),
      // Number → id resolution lives HERE, against live docs (ids
      // are opaque; only workspace state knows the page). Resolution is
      // by SOURCE identity — a bookmark's number addresses the file's
      // on-disk order, so the jump lands on that physical page even
      // while a reorder is pending (regression: array-order counting
      // silently jumped to the wrong page).
      jumpToFilePage: (path, pageNumber) => {
        const id = pageIdAtSourceIndex(docsForJumpRef.current, path, pageNumber);
        if (id) jumpToPageRef.current(id);
        return !!id;
      },
      // The Signatures PANEL's "visible signature" hand-off — arm the
      // placement mode and seed the canvas sign card with the panel's
      // signer details, so nothing is typed twice.
      startVisibleSignature: (prefill, certification, fieldLock) => {
        if (prefill) setSigSource(prefill);
        setSigCertify(certification ?? DEFAULT_CERTIFY);
        setSigLock(fieldLock ?? DEFAULT_LOCK);
        invokeCommand('tools.signature');
      },
      openPageForReading: (pageId) => openPageForReadingRef.current(pageId),
      find: {
        isOpen: () => findRef.current.open,
        open: () => findRef.current.openFind(),
        openWith: (q, pageId, options) => findRef.current.openWith(q, pageId, options),
        close: () => findRef.current.closeFind(),
        next: () => findRef.current.next(),
        prev: () => findRef.current.prev(),
      },
      readAloud: {
        isReading: () => readerRef.current.open,
        isPaused: () => readerRef.current.status === 'paused',
        readPage: () => readerRef.current.start('page'),
        readDocument: () => readerRef.current.start('document'),
        togglePause: () => {
          const active = readerRef.current;
          if (active.status === 'paused') active.resume();
          else if (active.status === 'speaking') active.pause();
        },
        stop: () => readerRef.current.stop(),
      },
      goToPage: () => {
        const el = pageBoxRef.current;
        if (!el) return false;
        el.focus();
        return true;
      },
      // View ▸ Clear Guides. Guides are canvas-owned VIEW state, so unlike the
      // other three drafting toggles (which are persisted preferences and go
      // through the snap-settings store) this one has to route through the
      // services seam — the same reason the find bar does.
      clearGuides: () => clearGuidesRef.current(),
      // Every method reaches the live implementation through a
      // ref — the registration happens once at mount, while `docs`, the mark
      // set and the search index all change under it.
      redaction: {
        addMarks: async (requests) => {
          const service = redactionServiceRef.current;
          if (!service) return { added: 0, duplicates: 0, skipped: requests.length };
          return service.addMarksFromRects(requests);
        },
        markedRects: async () => redactionServiceRef.current?.markedRects() ?? [],
        count: () => liveMarksRef.current.length,
        subscribe: (listener) => {
          markSubscribersRef.current.add(listener);
          return () => {
            markSubscribersRef.current.delete(listener);
          };
        },
        searchOcrPage: async (path, page, query, options) =>
          redactionServiceRef.current?.searchOcrPage(path, page, query, options) ?? [],
      },
      formCandidates: {
        publish: async (path, result) =>
          candidateServiceRef.current?.publish(path, result) ?? {
            shown: 0,
            skipped: result.candidates.length,
          },
        list: () => [...liveCandidatesRef.current],
        accept: async (ids) =>
          candidateServiceRef.current?.accept(ids) ?? { created: 0, skipped: ids.length },
        update: (next) => candidateServiceRef.current?.update(next),
        clear: () => candidateServiceRef.current?.clear(),
        focus: (candidateId) => candidateServiceRef.current?.focus(candidateId),
        subscribe: (listener) => {
          candidateSubscribersRef.current.add(listener);
          return () => {
            candidateSubscribersRef.current.delete(listener);
          };
        },
      },
      tableReview: {
        publish: async (path, result) =>
          tableServiceRef.current?.publish(path, result) ?? {
            shown: 0,
            skipped: result.regions.length,
          },
        list: () => [...liveTableRegionsRef.current],
        update: (next) => tableServiceRef.current?.update(next),
        clear: () => tableServiceRef.current?.clear(),
        focus: (regionId) => tableServiceRef.current?.focus(regionId),
        exportTo: async (output, options) => {
          const service = tableServiceRef.current;
          if (!service) throw new Error(tChrome('panel.tableReview.documentGone'));
          return service.exportTo(output, options);
        },
        subscribe: (listener) => {
          tableSubscribersRef.current.add(listener);
          return () => {
            tableSubscribersRef.current.delete(listener);
          };
        },
      },
    });
    return () => registerCanvasServices(null);
  }, [activeCanvasHandle]);

  const clearSelection = useCallback(
    () => dispatch({ type: 'UI_CLEAR_SELECTION' }),
    [dispatch],
  );

  // e2e harness for multi-select: modifier-click selection and the
  // pointer-capture group drag aren't reliably WebDriver-drivable, so the
  // canvas registers selection setters/readers + the batched delete/rotate
  // command paths here, mirroring the redaction/signature/OCR hooks.
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasSelection({
      selectPageIds: (ids) =>
        dispatch({ type: 'UI_SET_SELECTION', pageIds: ids, anchor: ids[ids.length - 1] ?? null }),
      getSelectedPageIds: () => [...selectionRef.current],
      getWorkspacePageIds: () => [...flatOrderRef.current],
      deleteSelected: () => void invokeCommand('document.deleteSelection'),
      rotateSelected: (delta) =>
        void invokeCommand(
          delta === 90 ? 'document.rotateSelectionCW' : 'document.rotateSelectionCCW',
        ),
    });
    return () => registerCanvasSelection(null);
  }, [dispatch]);

  const onAddAnnotation = useCallback(
    (docId: string, pageId: string, annotation: PageAnnotation) =>
      dispatch({ type: 'ADD_ANNOTATION', docId, pageId, annotation }),
    [dispatch],
  );

  const onUpdateAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string, note: string) =>
      dispatch({ type: 'UPDATE_ANNOTATION', docId, pageId, annotationId, note }),
    [dispatch],
  );

  const onRecolorAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string, color: string) =>
      dispatch({ type: 'RECOLOR_ANNOTATION', docId, pageId, annotationId, color }),
    [dispatch],
  );

  const onRemoveAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string) =>
      dispatch({ type: 'REMOVE_ANNOTATION', docId, pageId, annotationId }),
    [dispatch],
  );

  const onSelectAnnotation = useCallback(
    (docId: string, pageId: string, annotationId: string | null, additive: boolean) =>
      setSelectedAnnot((prev) => {
        if (annotationId === null) return additive ? prev : null;
        // A non-additive gesture, or one on another page/doc, starts fresh
        // (same-page selection by design — see the state's comment).
        if (!additive || !prev || prev.docId !== docId || prev.pageId !== pageId)
          return { docId, pageId, ids: [annotationId] };
        // Additive on the same page toggles membership; the last member
        // toggling off clears.
        if (prev.ids.includes(annotationId)) {
          const ids = prev.ids.filter((i) => i !== annotationId);
          return ids.length === 0 ? null : { ...prev, ids };
        }
        return { ...prev, ids: [...prev.ids, annotationId] };
      }),
    [],
  );

  const onMarqueeSelect = useCallback(
    (docId: string, pageId: string, annotationIds: string[], additive: boolean) =>
      setSelectedAnnot((prev) => {
        if (annotationIds.length === 0) return prev;
        if (!additive || !prev || prev.docId !== docId || prev.pageId !== pageId)
          return { docId, pageId, ids: annotationIds };
        const merged = [...prev.ids, ...annotationIds.filter((i) => !prev.ids.includes(i))];
        return { ...prev, ids: merged };
      }),
    [],
  );

  // The count mode's Ctrl-marquee re-files the marks it covered
  // into the armed group. The reducer renumbers them (a sequence is unique per
  // group across the whole document), so all this passes is the group.
  const onRegroupCountMarks = useCallback(
    (docId: string, pageId: string, annotationIds: string[], group: CountGroup) =>
      dispatch({
        type: 'REGROUP_COUNT_MARKS',
        docId,
        pageId,
        annotationIds,
        group: group.name,
        color: group.color,
        symbol: group.symbol,
      }),
    [dispatch],
  );

  const onTransformAnnotations = useCallback(
    (docId: string, edits: AnnotationTransform[]) =>
      dispatch({ type: 'TRANSFORM_ANNOTATIONS', docId, edits }),
    [dispatch],
  );

  // The selection resolved against the LIVE workspace — the annotations'
  // data always comes from here, never from a captured copy, so recolors
  // show instantly and vanished members (commit, undo, page delete, doc
  // close) drop out.
  const resolvedAnnots = useMemo(() => {
    if (!selectedAnnot) return null;
    for (const d of docs) {
      if (d.id !== selectedAnnot.docId) continue;
      for (let i = 0; i < d.pages.length; i++) {
        const p = d.pages[i];
        if (p.id !== selectedAnnot.pageId) continue;
        const byId = new Map((p.annotations ?? []).map((a) => [a.id, a]));
        const annotations = selectedAnnot.ids
          .map((id) => byId.get(id))
          .filter((a): a is PageAnnotation => !!a);
        if (annotations.length === 0) return null;
        return {
          docId: d.id,
          docPath: d.path,
          pageId: p.id,
          pageNumber: i + 1,
          annotations,
          pageWidth: p.width,
          pageHeight: p.height,
          rotation: p.rotation,
        };
      }
      return null;
    }
    return null;
  }, [selectedAnnot, docs]);

  // The properties bar's single subject — exactly one selected.
  const resolvedAnnot = useMemo(
    () =>
      resolvedAnnots && resolvedAnnots.annotations.length === 1
        ? {
            docId: resolvedAnnots.docId,
            pageId: resolvedAnnots.pageId,
            pageNumber: resolvedAnnots.pageNumber,
            annotation: resolvedAnnots.annotations[0],
            pageWidth: resolvedAnnots.pageWidth,
            pageHeight: resolvedAnnots.pageHeight,
          }
        : null,
    [resolvedAnnots],
  );

  // Prune the stored ids to the survivors (a commit/undo/delete may take
  // some, not all), so a dead member can't linger and rebind (the
  // transient-view-state discipline).
  useEffect(() => {
    if (!selectedAnnot) return;
    if (!resolvedAnnots) {
      setSelectedAnnot(null);
      return;
    }
    if (resolvedAnnots.annotations.length !== selectedAnnot.ids.length) {
      const alive = new Set(resolvedAnnots.annotations.map((a) => a.id));
      setSelectedAnnot({ ...selectedAnnot, ids: selectedAnnot.ids.filter((i) => alive.has(i)) });
    }
  }, [selectedAnnot, resolvedAnnots]);

  // Escape clears the selection first (LIFO — registered while one exists, so
  // an in-flight drag's own interceptor still wins over this one).
  useEffect(() => {
    if (!selectedAnnot) return;
    return pushEscapeInterceptor(() => {
      setSelectedAnnot(null);
      return true;
    });
  }, [selectedAnnot]);

  // ── Group operations on the selection (rung 1) ───────────────────────
  // Each is one dispatch = one undo step. The align/distribute/size math is
  // pure (lib/annotation-manipulation); measure notes recompute from their
  // captured factors inside sizeMatchEdits.
  const groupMembers = useMemo(
    () =>
      resolvedAnnots
        ? resolvedAnnots.annotations.map((annotation) => ({
            annotation,
            pageId: resolvedAnnots.pageId,
          }))
        : [],
    [resolvedAnnots],
  );
  const groupPageDims = useMemo(
    () =>
      resolvedAnnots
        ? new Map([
            [
              resolvedAnnots.pageId,
              {
                width: resolvedAnnots.pageWidth,
                height: resolvedAnnots.pageHeight,
                rotation: resolvedAnnots.rotation,
              },
            ],
          ])
        : new Map<string, { width: number; height: number; rotation: number }>(),
    [resolvedAnnots],
  );
  const onAlignSelection = useCallback(
    (mode: AlignMode) => {
      if (!resolvedAnnots) return;
      const edits = alignEdits(groupMembers, mode);
      if (edits.length > 0) onTransformAnnotations(resolvedAnnots.docId, edits);
    },
    [resolvedAnnots, groupMembers, onTransformAnnotations],
  );
  const onDistributeSelection = useCallback(
    (mode: DistributeMode) => {
      if (!resolvedAnnots) return;
      const edits = distributeEdits(groupMembers, mode);
      if (edits.length > 0) onTransformAnnotations(resolvedAnnots.docId, edits);
    },
    [resolvedAnnots, groupMembers, onTransformAnnotations],
  );
  const onSizeMatchSelection = useCallback(
    (mode: SizeMatchMode) => {
      if (!resolvedAnnots) return;
      const edits = sizeMatchEdits(groupMembers, mode, groupPageDims);
      if (edits.length > 0) onTransformAnnotations(resolvedAnnots.docId, edits);
    },
    [resolvedAnnots, groupMembers, groupPageDims, onTransformAnnotations],
  );
  const onReorderSelection = useCallback(
    (direction: 'front' | 'back' | 'forward' | 'backward') => {
      if (!resolvedAnnots) return;
      dispatch({
        type: 'REORDER_ANNOTATIONS',
        docId: resolvedAnnots.docId,
        pageId: resolvedAnnots.pageId,
        annotationIds: resolvedAnnots.annotations.map((a) => a.id),
        direction,
      });
    },
    [resolvedAnnots, dispatch],
  );
  const onRecolorSelection = useCallback(
    (color: string) => {
      if (!resolvedAnnots) return;
      dispatch({
        type: 'RECOLOR_ANNOTATIONS',
        docId: resolvedAnnots.docId,
        pageId: resolvedAnnots.pageId,
        annotationIds: resolvedAnnots.annotations.map((a) => a.id),
        color,
      });
    },
    [resolvedAnnots, dispatch],
  );
  // ── Rung 3: calibration + per-measurement recalibration ──────────────
  const onCalibrate = useCallback((lengthPts: number) => setCalibration(lengthPts), []);
  const onMeasureContextMenu = useCallback(
    (docId: string, pageId: string, annotationId: string, x: number, y: number) =>
      setRecalTarget({ docId, pageId, annotationId, x, y }),
    [],
  );
  const applyCalibration = useCallback(
    (value: number, unit: MeasureUnit) => {
      if (calibration === null || !(value > 0)) return;
      setMeasureScale(scaleFromCalibration(calibration, value, unit));
      setCalibration(null);
    },
    [calibration],
  );
  /** The recal popover's target measurement, resolved live with its page. */
  const recalAnnot = useMemo(() => {
    if (!recalTarget) return null;
    for (const d of docs) {
      if (d.id !== recalTarget.docId) continue;
      for (const p of d.pages) {
        if (p.id !== recalTarget.pageId) continue;
        const annotation = (p.annotations ?? []).find((a) => a.id === recalTarget.annotationId);
        if (!annotation || annotation.kind !== 'measure' || !annotation.points) return null;
        return { annotation, page: p };
      }
      return null;
    }
    return null;
  }, [recalTarget, docs]);
  useEffect(() => {
    if (recalTarget && !recalAnnot) setRecalTarget(null);
  }, [recalTarget, recalAnnot]);
  const applyRecalibration = useCallback(
    (value: number, unit: MeasureUnit, mode: 'scale' | 'override') => {
      if (!recalTarget || !recalAnnot || !(value > 0)) return;
      const { annotation: a, page: p } = recalAnnot;
      const swapped = p.rotation === 90 || p.rotation === 270;
      const dispW = swapped ? p.height : p.width;
      const dispH = swapped ? p.width : p.height;
      // The measurement's own geometric magnitude — linear points for
      // distance/perimeter, an equivalent-side length for area (so one
      // linear factor serves both the /C entries and the ratio label).
      const linearPts =
        a.measureKind === 'area'
          ? Math.sqrt(ringAreaPts2(a.points!, dispW, dispH))
          : polylineLengthPts(a.points!, dispW, dispH);
      const linearValue = a.measureKind === 'area' ? Math.sqrt(value) : value;
      if (linearPts <= 0) return;
      if (mode === 'scale') {
        setMeasureScale(scaleFromCalibration(linearPts, linearValue, unit));
      } else {
        const factor = linearValue / linearPts;
        const scale = scaleFromCalibration(linearPts, linearValue, unit);
        const note =
          recomputedMeasureNote(
            { ...a, measureUnitsPerPt: factor, measureUnit: unit },
            a.points!,
            p.width,
            p.height,
            p.rotation,
          ) ?? a.note ?? '';
        dispatch({
          type: 'RECALIBRATE_ANNOTATION',
          docId: recalTarget.docId,
          pageId: recalTarget.pageId,
          annotationId: recalTarget.annotationId,
          measureUnitsPerPt: factor,
          measureUnit: unit,
          measureRatio: measureRatioLabel(scale),
          note,
        });
      }
      setRecalTarget(null);
    },
    [recalTarget, recalAnnot, dispatch],
  );

  const onRestyleSelection = useCallback(
    (style: {
      strokeWidth?: number;
      fillColor?: string | null;
      opacity?: number;
      lineEndings?: [string, string];
      cloudIntensity?: number;
    }) => {
      if (!resolvedAnnots) return;
      dispatch({
        type: 'RESTYLE_ANNOTATIONS',
        docId: resolvedAnnots.docId,
        pageId: resolvedAnnots.pageId,
        annotationIds: resolvedAnnots.annotations.map((a) => a.id),
        style,
      });
    },
    [resolvedAnnots, dispatch],
  );
  // residual: quarter-turn / mirror for the vertex kinds — one dispatch,
  // one undo step, same TRANSFORM machinery as align/size-match.
  const onRotateFlipSelection = useCallback(
    (op: { rotate: 'cw' | 'ccw' } | { flip: 'h' | 'v' }) => {
      if (!resolvedAnnots) return;
      const edits = rotateFlipEdits(groupMembers, op, groupPageDims);
      if (edits.length > 0) onTransformAnnotations(resolvedAnnots.docId, edits);
    },
    [resolvedAnnots, groupMembers, groupPageDims, onTransformAnnotations],
  );
  const onRemoveSelection = useCallback(() => {
    if (!resolvedAnnots) return;
    dispatch({
      type: 'REMOVE_ANNOTATIONS',
      docId: resolvedAnnots.docId,
      pageId: resolvedAnnots.pageId,
      annotationIds: resolvedAnnots.annotations.map((a) => a.id),
    });
    setSelectedAnnot(null);
  }, [resolvedAnnots, dispatch]);

  // Keyboard on the selection: Delete removes, arrows nudge 1pt (Shift:
  // 10pt) — skipped while typing in any editable surface.
  useEffect(() => {
    if (!resolvedAnnots || tool !== 'select') return;
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      )
        return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onRemoveSelection();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const movable = resolvedAnnots.annotations.filter(isTransformable);
        if (movable.length === 0) return;
        e.preventDefault();
        // Arrows are SCREEN directions. Stored geometry lives in the page's
        // real-rotation frame; Rotate View projects it by
        // viewRotation for display — so the screen vector un-projects by the
        // inverse view rotation before it can be a stored-frame delta.
        // (Vector form of rotateNormalizedPoint: translation cancels.)
        const { dx, dy } = nudgeDelta(
          e.key,
          e.shiftKey,
          resolvedAnnots.pageWidth,
          resolvedAnnots.pageHeight,
        );
        const vr = state.ui.viewRotationByPath[resolvedAnnots.docPath] ?? 0;
        const inv = (360 - vr) % 360;
        const [sdx, sdy] =
          inv === 90 ? [-dy, dx] : inv === 180 ? [-dx, -dy] : inv === 270 ? [dy, -dx] : [dx, dy];
        const lead = translated(movable[0], sdx, sdy);
        const edits: AnnotationTransform[] = movable.map((m) => {
          const t2 = m.id === movable[0].id ? lead : translatedBy(m, lead.dx, lead.dy);
          return {
            pageId: resolvedAnnots.pageId,
            annotationId: m.id,
            x: t2.x,
            y: t2.y,
            w: m.w,
            h: m.h,
            ...(t2.points ? { points: t2.points } : {}),
          };
        });
        if (lead.dx !== 0 || lead.dy !== 0) onTransformAnnotations(resolvedAnnots.docId, edits);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [resolvedAnnots, tool, onRemoveSelection, onTransformAnnotations, state.ui.viewRotationByPath]);

  // Marks whose page still exists in the workspace — a deleted page's marks
  // drop out of the count and the apply payload rather than being guessed at.
  const liveMarks = useMemo(() => {
    if (marks.length === 0) return NO_MARKS;
    return marks.filter((m) => docs.some((d) => d.pages.some((p) => p.id === m.pageId)));
  }, [marks, docs]);
  // Declared HERE, above the services registration that reads them, and
  // populated further down where the mark machinery lives — the registration
  // effect runs after render, so both are always filled by the time a caller
  // arrives. Same shape as `docsRef`/`filesRef`, which the seed already
  // reads from above their own declarations.
  const markSubscribersRef = useRef(new Set<() => void>());
  const redactionServiceRef = useRef<{
    addMarksFromRects: (
      requests: { path: string; page: number; rect: [number, number, number, number] }[],
    ) => Promise<{ added: number; duplicates: number; skipped: number }>;
    markedRects: () => Promise<
      { path: string; page: number; rect: [number, number, number, number] }[]
    >;
    searchOcrPage: (
      path: string,
      page: number,
      query: string,
      options: SearchOptions,
    ) => Promise<{ text: string; rect: [number, number, number, number] }[]>;
  } | null>(null);

  // Pruned against the CURRENT page set before anything reads it: a dead
  // generation-tagged id must never reach a gesture or an accept payload.
  const liveCandidates = useMemo(() => {
    if (fieldCandidates.length === 0) return NO_CANDIDATES;
    const live = new Set<string>();
    for (const d of docs) for (const p of d.pages) live.add(p.id);
    const kept = prunedCandidates(fieldCandidates, live);
    return kept.length === fieldCandidates.length ? fieldCandidates : kept;
  }, [fieldCandidates, docs]);
  const liveCandidatesRef = useRef<FieldCandidate[]>(NO_CANDIDATES);
  liveCandidatesRef.current = liveCandidates;
  const candidateSubscribersRef = useRef(new Set<() => void>());
  const candidateServiceRef = useRef<{
    publish: (path: string, result: DetectionResult) => Promise<{ shown: number; skipped: number }>;
    accept: (ids: readonly string[]) => Promise<{ created: number; skipped: number }>;
    update: (next: readonly FieldCandidate[]) => void;
    clear: () => void;
    focus: (candidateId: string) => void;
  } | null>(null);

  const fieldCandidatesByPage = useMemo(() => {
    if (liveCandidates.length === 0) return NO_CANDIDATES_BY_PAGE;
    const map = new Map<string, FieldCandidate[]>();
    for (const c of liveCandidates) {
      const arr = map.get(c.pageId);
      if (arr) arr.push(c);
      else map.set(c.pageId, [c]);
    }
    return map;
  }, [liveCandidates]);

  const onRemoveCandidate = useCallback((candidateId: string) => {
    setFieldCandidates((prev) => removeCandidate(prev, candidateId));
    setSelectedCandidateId((prev) => (prev === candidateId ? null : prev));
  }, []);

  // The same prune, for the same reason: a region bound to a retired page id
  // would export a table from a page the document no longer has.
  const liveTableRegions = useMemo(() => {
    if (tableRegions.length === 0) return NO_TABLES;
    const live = new Set<string>();
    for (const d of docs) for (const p of d.pages) live.add(p.id);
    const kept = prunedRegions(tableRegions, live);
    return kept.length === tableRegions.length ? tableRegions : kept;
  }, [tableRegions, docs]);
  const liveTableRegionsRef = useRef<TableRegion[]>(NO_TABLES);
  liveTableRegionsRef.current = liveTableRegions;
  const tableSubscribersRef = useRef(new Set<() => void>());
  const tableServiceRef = useRef<{
    publish: (
      path: string,
      result: TableDetectionResult,
    ) => Promise<{ shown: number; skipped: number }>;
    update: (next: readonly TableRegion[]) => void;
    clear: () => void;
    focus: (regionId: string) => void;
    exportTo: (
      output: string,
      options: { sheetPer: string; includeUntabled: boolean },
    ) => Promise<ExportDocumentResult>;
  } | null>(null);

  const tableRegionsByPage = useMemo(() => {
    if (liveTableRegions.length === 0) return NO_TABLES_BY_PAGE;
    const map = new Map<string, TableRegion[]>();
    for (const r of liveTableRegions) {
      const arr = map.get(r.pageId);
      if (arr) arr.push(r);
      else map.set(r.pageId, [r]);
    }
    return map;
  }, [liveTableRegions]);

  const tableReviewHandlers = useMemo<TableReviewHandlers>(
    () => ({
      selectedId: selectedTableId,
      onSelect: setSelectedTableId,
      onToggle: (id) => setTableRegions((prev) => toggleRegion(prev, id)),
      onMoveBounds: (id, rect) => setTableRegions((prev) => moveRegionBounds(prev, id, rect)),
      onMoveColumn: (id, index, fraction) =>
        setTableRegions((prev) => moveColumn(prev, id, index, fraction)),
      onAddColumn: (id, fraction) => setTableRegions((prev) => addColumn(prev, id, fraction)),
      onRemoveColumn: (id, index) => setTableRegions((prev) => removeColumn(prev, id, index)),
    }),
    [selectedTableId],
  );

  const onMoveCandidate = useCallback(
    (
      candidateId: string,
      rect: { x: number; y: number; w: number; h: number },
      _rotationAtDraw: 0 | 90 | 180 | 270,
    ) => setFieldCandidates((prev) => moveCandidate(prev, candidateId, rect)),
    [],
  );

  const redactionMarksByPage = useMemo(() => {
    if (liveMarks.length === 0) return NO_MARKS_BY_PAGE;
    const map = new Map<string, RedactionMark[]>();
    for (const m of liveMarks) {
      const arr = map.get(m.pageId);
      if (arr) arr.push(m);
      else map.set(m.pageId, [m]);
    }
    return map;
  }, [liveMarks]);

  const onAddRedactionMark = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      setMarks((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          path: doc.path,
          pageId,
          rect,
          rotationAtDraw,
          // A band drawn by hand takes the SAME properties the
          // Search & Redact panel's marks take, read at draw time. One
          // setting, both producers — the properties are how the user works,
          // not something a second surface gets its own copy of.
          props: loadRedactionProperties(),
        },
      ]);
    },
    [docs],
  );

  const onRemoveRedactionMark = useCallback(
    (markId: string) => setMarks((prev) => prev.filter((m) => m.id !== markId)),
    [],
  );

  // ── Ruler guides ──────────────────────────────────────────────────────
  // Per-document view state with the redaction-mark lifetime: never written
  // into the file, invalidated on buffer
  // identity, and pruned to pages that still exist so a dead generation-tagged
  // id can never be offered to a gesture (the id-holder rule).
  const [guides, setGuides] = useState<PageGuide[]>(NO_GUIDES);
  const liveGuides = useMemo(() => {
    if (guides.length === 0) return NO_GUIDES;
    const live = new Set<string>();
    for (const d of docs) for (const p of d.pages) live.add(p.id);
    const kept = prunedToPages(guides, live);
    return kept.length === guides.length ? guides : kept;
  }, [guides, docs]);
  const guidesByPage = useMemo(() => {
    if (liveGuides.length === 0) return NO_GUIDES_BY_PAGE;
    const map = new Map<string, PageGuide[]>();
    for (const g of liveGuides) {
      const arr = map.get(g.pageId);
      if (arr) arr.push(g);
      else map.set(g.pageId, [g]);
    }
    return map;
  }, [liveGuides]);

  const onAddGuide = useCallback(
    (pageId: string, axis: GuideAxis, pos: number, rotationAtDraw: 0 | 90 | 180 | 270) => {
      const doc = docs.find((d) => d.pages.some((p) => p.id === pageId));
      if (!doc) return;
      setGuides((prev) => [
        ...prev,
        { id: crypto.randomUUID(), path: doc.path, pageId, axis, pos, rotationAtDraw },
      ]);
    },
    [docs],
  );
  const onMoveGuide = useCallback(
    (guideId: string, axis: GuideAxis, pos: number, rotationAtDraw: 0 | 90 | 180 | 270) =>
      // A moved guide is a freshly placed one: it takes the frame it landed
      // in, so the projection stays a single quarter-turn from where the user
      // last put it rather than an accumulating chain.
      setGuides((prev) =>
        withGuidePos(prev, guideId, pos).map((g) =>
          g.id === guideId ? { ...g, axis, rotationAtDraw } : g,
        ),
      ),
    [],
  );
  const onRemoveGuide = useCallback(
    (guideId: string) => setGuides((prev) => withoutGuide(prev, guideId)),
    [],
  );
  const clearGuidesRef = useRef<() => void>(() => {});
  clearGuidesRef.current = () => setGuides(NO_GUIDES);

  // Single pending placement — drawing again anywhere replaces it. Placement
  // gestures are mutually exclusive: starting a signature placement clears a
  // pending new-field placement (and vice versa) so only one bottom-left
  // card is ever live.
  const onSetSignaturePlacement = useCallback(
    (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      // Anchor only to CURRENT ids — the onSetNewFieldRect rule:
      // a placement drawn against docs indexed from
      // a superseded buffer is stillborn — refuse rather than arm it.
      if (!placementDocsCurrent(state.files, docs, doc.path)) return;
      setSigPlacement({ id: crypto.randomUUID(), path: doc.path, pageId, rect, rotationAtDraw });
      setNewFieldPlacement(null);
      setAddTextPlacement(null); // one placement card at a time
      setSigFieldTarget(null);
      setSignDone(null);
      setSignError(null);
    },
    [docs, state.files],
  );
  const onClearSignaturePlacement = useCallback(() => setSigPlacement(null), []);

  // Clicking an empty signature widget in forms mode targets it. The
  // early pending-page-edits notice mirrors the hard check in applySignature.
  const onSignFieldRequest = useCallback(
    (path: string, fieldName: string) => {
      setSigFieldTarget({ path, fieldName });
      setSigPlacement(null);
      setNewFieldPlacement(null);
      setAddTextPlacement(null); // one card at a time — incl. the Add-Text card
      setSignDone(null);
      setSignError(
        state.pageDirtyPaths.includes(path)
          ? tChrome('canvas.sign.applyEditsFirst')
          : null,
      );
    },
    [state.pageDirtyPaths],
  );

  // Placement whose page still exists (a deleted page's placement is inert,
  // surfaced as such rather than guessed at).
  const liveSigPlacement = useMemo(() => {
    if (!sigPlacement) return null;
    return docs.some((d) => d.pages.some((p) => p.id === sigPlacement.pageId)) ? sigPlacement : null;
  }, [sigPlacement, docs]);

  // Can the card's target still take a certification? A certification must be
  // a document's FIRST signature, so this is a structural read of what is
  // already there.
  const sigTargetPath = sigFieldTarget?.path ?? liveSigPlacement?.path ?? null;
  useEffect(() => {
    if (!sigTargetPath) {
      setSigCanCertify(false);
      setSigLockFields([]);
      return;
    }
    const workingPath = state.files.get(sigTargetPath)?.workingPath;
    if (!workingPath) {
      setSigCanCertify(false);
      setSigLockFields([]);
      return;
    }
    let cancelled = false;
    void engineCall('signature_policy', { path: workingPath })
      .then((policy) => {
        if (cancelled) return;
        const { signed } = policy as unknown as { signed: boolean };
        setSigCanCertify(!signed);
        // A document that cannot be certified must not carry a certify
        // request left over from an earlier card.
        if (signed) setSigCertify(DEFAULT_CERTIFY);
      })
      .catch(() => {
        if (!cancelled) setSigCanCertify(false);
      });
    // The names a lock can choose from; signature fields are not among them.
    void readFormFields(engineCall, workingPath)
      .then(({ fields }) => {
        if (cancelled) return;
        setSigLockFields(fields.filter((f) => f.type !== 'signature').map((f) => f.name));
      })
      .catch(() => {
        if (!cancelled) setSigLockFields([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sigTargetPath, state.files, engineCall]);

  // Invalidate marks when their file's bytes change underneath them (commit,
  // whole-file op, undo, reopen) or the file closes. PageRef ids are
  // positional (`path#pN`), so after a reindex a surviving mark could bind to
  // a DIFFERENT physical page — for a destructive tool, dropping the marks is
  // the only safe answer. Buffer identity is exactly what the indexer keys
  // on, so this fires precisely when the workspace is about to be rebuilt.
  // Re-seed: a file's stored /Redact set loads back into transient
  // marks whenever its buffer SETTLES (open, commit, whole-file op, undo —
  // the very moments the invalidation below clears them). Marks and file
  // agree by construction: the transient set is always a projection of the
  // stored one plus this session's unsaved drawing. `callRaw`, documented:
  // this is a read of the just-settled working file — a gated call would
  // queue a visible operation (and re-run the gate) on every settle.
  const seedSeqRef = useRef(new Map<string, number>());
  const pendingSeedRef = useRef<Set<string>>(new Set());

  // ONE page-space → mark conversion, shared by the seed and the
  // Search & Redact panel. Both take the same payload shape
  // `list_redact_annotations` returns and `save_redaction_marks` accepts —
  // `{page, rect}` in the page's own point space — so the stored marks, the
  // searched ones and the applied regions cannot disagree about geometry.
  // A page this view cannot resolve is COUNTED, never guessed at: the
  // engine refusal one layer down would be pointless if the conversion silently
  // dropped what it could not place.
  const marksFromFileRects = useCallback(
    async (
      path: string,
      entries: (Record<string, unknown> & {
        page: number;
        rect: [number, number, number, number];
      })[],
    ): Promise<{ marks: RedactionMark[]; orphaned: number }> => {
      const f = filesRef.current.get(path);
      if (!f?.buffer) return { marks: [], orphaned: entries.length };
      const pages = docsRef.current.filter((d) => d.path === path).flatMap((d) => d.pages);
      const marks: RedactionMark[] = [];
      let orphaned = 0;
      for (const entry of entries) {
        const pageRef = pages[entry.page - 1];
        if (!pageRef) {
          orphaned += 1;
          continue;
        }
        const proxy = await getDocumentProxy(pageRef.sourceDocId, f.buffer);
        const p = await proxy.getPage(pageRef.sourcePageIndex + 1);
        const [vx0, vy0, vx1, vy1] = p.view;
        const composed = ((p.rotate + pageRef.rotation) % 360) as 0 | 90 | 180 | 270;
        const rect = pdfRectToDisplay(
          entry.rect,
          { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
          composed,
        );
        marks.push({
          id: crypto.randomUUID(),
          path,
          pageId: pageRef.id,
          rect,
          rotationAtDraw: pageRef.rotation,
          // The entry's own properties when it HAS them (a mark
          // seeded from the file carries the fill and overlay it was saved
          // with), else the ones the user is currently working with (a mark
          // the panel just made). `propertiesFromPayload` never invents a
          // value the file did not state.
          props: propertiesFromPayload(entry as Record<string, unknown>),
        });
      }
      return { marks, orphaned };
    },
    [],
  );

  const seedMarksFromFile = useCallback(
    async (path: string) => {
      const f = filesRef.current.get(path);
      if (!f?.buffer) return;
      const seq = (seedSeqRef.current.get(path) ?? 0) + 1;
      seedSeqRef.current.set(path, seq);
      try {
        const listed = (await engineCallRaw('list_redact_annotations', {
          file: f.workingPath,
        })) as unknown as {
          // Widened the listing: a stored mark reports its
          // REDACTION PROPERTIES beside its rect, and the seed carries them
          // back onto the transient mark so a saved fill/overlay survives a
          // reopen.
          marks: (Record<string, unknown> & {
            page: number;
            rect: [number, number, number, number];
          })[];
        };
        if (seedSeqRef.current.get(path) !== seq) return; // superseded
        if (!listed.marks?.length) return;
        const { marks: seeded, orphaned } = await marksFromFileRects(path, listed.marks);
        if (seedSeqRef.current.get(path) !== seq) return;
        markPathsEverRef.current.add(path);
        setMarks((prev) => [...prev.filter((m) => m.path !== path), ...seeded]);
        if (orphaned > 0) {
          setRedactError(
            tChromeCount('canvas.redact.seedOrphaned', orphaned, {
              name: path.split(/[\\/]/).pop() || path,
            }),
          );
        }
      } catch (err) {
        if (seedSeqRef.current.get(path) !== seq) return; // superseded
        // The listing REFUSES when the file carries marks it cannot
        // account for. Swallowing that put the silence back one layer up —
        // the user would draw over a document whose stored marks were only
        // partly shown and apply a redaction that misses bands they marked.
        setRedactError(
          tChrome('canvas.redact.seedFailed', {
            name: path.split(/[\\/]/).pop() || path,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    },
    [engineCallRaw, marksFromFileRects],
  );

  const lastBuffersRef = useRef<Map<string, PdfBuffer | null>>(new Map());
  useEffect(() => {
    const current = new Map<string, PdfBuffer | null>();
    for (const [path, f] of state.files) current.set(path, f.buffer);
    const prev = lastBuffersRef.current;
    lastBuffersRef.current = current;
    const invalidated = new Set<string>();
    for (const [path, buf] of current) {
      if (prev.has(path) && prev.get(path) !== buf) invalidated.add(path);
    }
    for (const path of prev.keys()) {
      if (!current.has(path)) invalidated.add(path); // closed — a later reopen reuses the same positional ids
    }
    // Queue a mark re-seed for newly-opened files and still-open files
    // whose buffer changed. QUEUED, not run: the workspace reindex is
    // async, and seeding against the OLD PageRefs would bind marks to ids
    // a non-authored rebuild is about to kill. The docs effect below
    // drains the queue once the fresh pages exist.
    for (const path of current.keys()) {
      if (!prev.has(path) || (invalidated.has(path) && current.get(path))) {
        pendingSeedRef.current.add(path);
      }
    }
    if (invalidated.size > 0) {
      setMarks((prevMarks) => prevMarks.filter((m) => !invalidated.has(m.path)));
      // A candidate names a region of bytes that no longer exist. After a
      // create the whole list is stale by construction, so it goes rather than
      // pointing at a document that no longer matches it.
      setFieldCandidates((prev) => prev.filter((c) => !invalidated.has(c.path)));
      // Guides share the mark's lifetime exactly — same invalidation, same
      // reason (a rebuilt file's pages are new objects; a guide bound to a
      // dead page id is a guide pointing at nothing).
      setGuides((prev) => {
        const kept = withoutPaths(prev, invalidated);
        return kept.length === prev.length ? prev : kept;
      });
      setSigPlacement((prev) => (prev && invalidated.has(prev.path) ? null : prev));
      // New-field placement shares the positional-id hazard — same lifecycle.
      setNewFieldPlacement((prev) => (prev && invalidated.has(prev.path) ? null : prev));
      // A buffer change can rename/remove fields — a name-keyed sign target
      // must not survive it (the user re-clicks the widget, which re-reads).
      setSigFieldTarget((prev) => (prev && invalidated.has(prev.path) ? null : prev));
      // Add-Text placement: the SAME `bakedRotate + rotationAtDraw`
      // hazard the sig/new-field placements are cleared for. rotationAtDraw is
      // frozen at draw; bakedRotate is re-fetched fresh at commit. A page-tier
      // rotate that gets baked into /Rotate by a commit changes bakedRotate
      // underneath a placement whose rotationAtDraw is stale — so the authored
      // text would land at the wrong orientation. Durable identity keeps the
      // pageId alive across the authored commit (so `liveAddTextPlacement`'s
      // existence check does NOT drop it — this is the one placement that
      // survives), which is exactly why it must be force-cleared here.
      setAddTextPlacement((prev) => (prev && invalidated.has(prev.path) ? null : prev));
      // (Selection shares the positional-id hazard; it lives in the ui slice
      // now and the reducer clears it wherever buffers change.)
    }
  }, [state.files]);

  // drain: run queued mark seeds once the workspace's docs reflect the
  // settled buffer (the reindex is async — seeding earlier would bind marks
  // to PageRefs a rebuild is about to kill).
  useEffect(() => {
    if (pendingSeedRef.current.size === 0) return;
    const present = new Set(docs.map((d) => d.path));
    for (const path of [...pendingSeedRef.current]) {
      if (!present.has(path)) continue;
      pendingSeedRef.current.delete(path);
      void seedMarksFromFile(path);
    }
  }, [docs, seedMarksFromFile]);

  // Find overlays: matching pages, and per-word boxes where OCR words exist.
  const findMatchPageIds = find.active ? find.result.pageIds : NO_PAGE_IDS;
  const findWordsByPage = useMemo(() => {
    if (!find.active || find.result.pageIds.size === 0) return NO_WORDS_BY_PAGE;
    if (!normalizeQuery(find.matchedQuery)) return NO_WORDS_BY_PAGE;
    const map = new Map<string, OcrWord[]>();
    for (const doc of docs) {
      for (const page of doc.pages) {
        if (!find.result.pageIds.has(page.id)) continue;
        const words = searchIndex.getOcrWords(sourceKeyOf(page));
        if (!words) continue;
        // Per-token match (multi-word queries would never match a single
        // whitespace-free OCR word otherwise).
        const hits = highlightWords(words, find.matchedQuery, find.matchedOptions);
        if (hits.length > 0) map.set(page.id, hits);
      }
    }
    return map.size > 0 ? map : NO_WORDS_BY_PAGE;
  }, [find.active, find.result, find.matchedQuery, find.matchedOptions, docs, searchIndex]);

  const ocrReady = searchIndex.ocrReadySources();

  const applyingOcrRef = useRef(false);
  const handleApplyOcr = useCallback(async (): Promise<string[]> => {
    if (applyingOcrRef.current) return [];
    applyingOcrRef.current = true;
    setApplyingOcr(true);
    setOcrApplyError(null);
    try {
      const sources = searchIndex.ocrReadySources();
      const { files: payloads, skippedSources } = await buildOcrApplyPayload(
        docs,
        sources,
        searchIndex.getOcrWords,
        async (page) => {
          const f = state.files.get(page.sourceDocId);
          if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
          const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
        },
      );
      const failures: string[] = [];
      for (const payload of payloads) {
        try {
          await onApplyOcrLayer(payload.path, payload.pages);
        } catch (err) {
          const name = payload.path.split(/[\\/]/).pop() || payload.path;
          failures.push(
            tChrome('canvas.common.fileFailure', {
              name,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
      // A source dropped between the ready-snapshot and its turn (page
      // closed/moved, or its OCR invalidated mid-run) must be surfaced, not
      // silently skipped — the user thinks every scanned page was persisted.
      if (skippedSources.length > 0) {
        failures.push(tChromeCount('canvas.ocr.skipped', skippedSources.length));
      }
      if (payloads.length === 0 && skippedSources.length === 0) {
        failures.push(tChrome('canvas.ocr.noReadyPages'));
      }
      if (failures.length > 0) {
        setOcrApplyError(tChrome('canvas.ocr.applyFailed', { reasons: failures.join('; ') }));
      }
      return failures;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOcrApplyError(tChrome('canvas.ocr.applyFailed', { reasons: msg }));
      return [msg];
    } finally {
      applyingOcrRef.current = false;
      setApplyingOcr(false);
    }
  }, [docs, state.files, searchIndex, onApplyOcrLayer]);

  // --- Edit ▸ Images: placements + selection --------------------------------
  // Placements come from the engine per page of the FOCUSED document (the
  // reading view's document; the board shows its outlines too — the
  // documented scope). The mode's entry flushes pending page edits so the
  // engine's committed order matches what's displayed, then listings load
  // incrementally (one cheap engine call per page) under a token that drops
  // stale batches — the batch-OCR selectSource race lesson, applied here from
  // the start. Buffer identity in the deps refetches after every edit/undo.
  const [editImagesByPage, setEditImagesByPage] =
    useState<ReadonlyMap<string, EditImagePlacement[]>>(NO_EDIT_IMAGES);
  // Per-page vector path objects, filled by the same edit-listing pass.
  const [editVectorsByPage, setEditVectorsByPage] =
    useState<ReadonlyMap<string, EditVectorObject[]>>(NO_EDIT_VECTORS);
  // The selected vector object (one at a time), or null. Its own state —
  // decoupled from the image transform selection (`editSel`).
  const [selectedVector, setSelectedVector] = useState<{ pageId: string; index: number } | null>(
    null,
  );
  // Per-page {box, bakedRotate} for the image pages — the transform gesture
  // needs it to convert pointer↔user space; filled alongside editImagesByPage.
  const [editGeomByPage, setEditGeomByPage] =
    useState<ReadonlyMap<string, PageGeometry>>(NO_EDIT_GEOM);
  const [editTextByPage, setEditTextByPage] =
    useState<ReadonlyMap<string, EditTextListing>>(NO_EDIT_TEXT);
  // ONE selection across all edit-object kinds — the secondary toolbar's
  // actions key off the kind. 'para' is the primary text surface;
  // 'text' survives for runs outside any editable paragraph. The image arm
  // carries `indexes` (multi-select): `index` stays the anchor (last
  // clicked) so single-selection consumers read it unchanged; a group is
  // simply indexes.length > 1, same page by construction.
  const [editSel, setEditSel] = useState<
    | { kind: 'image'; pageId: string; index: number; indexes: number[] }
    | { kind: 'text' | 'para'; pageId: string; index: number }
    | null
  >(null);
  // The ONE open inline editor — a run's or a paragraph's; the input
  // itself lives in PageCell (local value state, validated live).
  const [editingText, setEditingText] = useState<{
    kind: 'text' | 'para';
    pageId: string;
    index: number;
  } | null>(null);
  const editFetchTokenRef = useRef(0);
  // Non-zero while a listing pass is in flight (its token). A consumer that
  // reads the maps mid-pass sees a TRANSIENT empty page — indistinguishable
  // from "this page really has no images" — so the honest question is not
  // "is the map empty?" but "is the map settled AND empty?". Exposed to the
  // harness (specs asserted a delete against an unsettled listing and would
  // have passed a no-op); no product code branches on it.
  const editListingPendingRef = useRef(0);
  const editBuffer = focusedDoc ? state.files.get(focusedDoc.path)?.buffer : undefined;
  // The DESTRUCTIVE clears (selection + the open editor with the user's
  // typed text) fire only when the edit context truly changed — tool,
  // focused document, or ITS buffer. `docs`/`state.files` are whole-
  // workspace identities that churn when ANY open file reindexes or
  // reloads; an unconditional clear on every rerun silently destroyed an
  // in-progress edit because of an unrelated file's op (regression
  // CRITICAL). Those reruns still refetch listings (ordering can shift);
  // they just stop closing the editor.
  const prevEditCtxRef = useRef<{ tool: unknown; docId: unknown; buffer: unknown; path: unknown }>(
    { tool: null, docId: null, buffer: null, path: null },
  );
  // Keep selection across a transform: count-PRESERVING image
  // ops (transform/rotate/crop/opacity/replace) stash {pageNumber, indexes}
  // at commit; when the post-op refetch lands (page ids regenerated —
  // the non-authored-rebuild rule), the effect below re-selects the same
  // placement(s) so chained nudges need no re-click. Delete/extract never
  // stash (the index dies / nothing changes); declines and failures
  // clear it. The stash carries the whole group; restore is
  // all-or-nothing (count-preserving ops keep every member alive).
  const imageReselectRef = useRef<{ pageNumber: number; indexes: number[] } | null>(null);
  // The same reselect stash for a vector transform — a
  // whole-file op regenerates every page id, so the pre-op selectedVector id
  // is dead; this re-selects the object on its page once the fresh listing
  // lands, so chained move/resize/rotate (and a follow-up delete) need no
  // re-click. Same lifecycle as imageReselectRef.
  const vectorReselectRef = useRef<{ pageNumber: number; index: number } | null>(null);
  useEffect(() => {
    const token = ++editFetchTokenRef.current;
    const prev = prevEditCtxRef.current;
    const ctxChanged =
      prev.tool !== tool || prev.docId !== (focusedDoc?.id ?? null) || prev.buffer !== editBuffer;
    // The reselect stash dies ONLY on a tool or FILE (path) change. Not
    // on buffer identity, not on doc id: a commit lands as TWO passes
    // here (bytes first with the old id, then the reindex's regenerated
    // id with the same bytes — instrumented, not assumed), so any rule
    // keyed on those terms kills the stash mid-flight (e2e regression, three
    // designs deep — buffer term, docId term, then a bytes-vs-id
    // discriminator that the two-pass anatomy defeats). Path is the
    // durable file identity across generations (ids stay opaque — never
    // parsed); the manifest-partition corner this leaves open is safe
    // because `workspacePageNumber` is FILE-level — same-path partitions
    // occupy disjoint number ranges, so a lingering stash can only ever
    // re-match its own physical page.
    const toolOrPathChanged = prev.tool !== tool || prev.path !== (focusedDoc?.path ?? null);
    prevEditCtxRef.current = {
      tool,
      docId: focusedDoc?.id ?? null,
      buffer: editBuffer,
      path: focusedDoc?.path ?? null,
    };
    if (ctxChanged) {
      setEditSel(null);
      setEditingText(null);
      if (toolOrPathChanged) imageReselectRef.current = null;
    }
    if (toolOrPathChanged) {
      setSelectedVector(null);
      vectorReselectRef.current = null;
    }
    // The id-holder rule applied to the EDIT LISTINGS. These maps are
    // keyed by generation-tagged page ids, and a whole-file op REBUILDS the
    // file: `docs` rotates to a fresh generation one render before the
    // refetch below can publish anything (the two-pass anatomy described
    // above). In that window the PUBLISHED maps still name DEAD pages — and
    // everything that starts a selection reads them: a click on a
    // still-drawn box, the harness's pageIds(). The selection then holds an
    // id `workspacePageNumber` can no longer resolve, so the very next
    // action refuses (e2e regression, deterministic: a group delete issued right
    // after an undo never applied). Prune to what still exists
    // SYNCHRONOUSLY, before the first await, so a dead id is never offered.
    // Prune, not adopt: a non-authored rebuild is precisely the case where
    // nothing survives, and the reselect stashes below are the adoption
    // channel that puts the selection back onto the fresh ids.
    if (focusedDoc) {
      const liveIds = new Set(focusedDoc.pages.map((p) => p.id));
      const dropStale = <V,>(prev: ReadonlyMap<string, V>): ReadonlyMap<string, V> => {
        let stale = false;
        for (const k of prev.keys()) {
          if (!liveIds.has(k)) {
            stale = true;
            break;
          }
        }
        if (!stale) return prev; // identity preserved → React bails out
        const next = new Map<string, V>();
        for (const [k, v] of prev) if (liveIds.has(k)) next.set(k, v);
        return next;
      };
      setEditImagesByPage(dropStale);
      setEditGeomByPage(dropStale);
      setEditVectorsByPage(dropStale);
      setEditTextByPage(dropStale);
      setEditSel((prev) => (prev && !liveIds.has(prev.pageId) ? null : prev));
      setSelectedVector((prev) => (prev && !liveIds.has(prev.pageId) ? null : prev));
      setEditingText((prev) => (prev && !liveIds.has(prev.pageId) ? null : prev));
    }
    if (tool !== 'edit' || !focusedDoc || !editBuffer) {
      setEditImagesByPage(NO_EDIT_IMAGES);
      setEditVectorsByPage(NO_EDIT_VECTORS);
      setEditGeomByPage(NO_EDIT_GEOM);
      setEditTextByPage(NO_EDIT_TEXT);
      setSelectedVector(null);
      if (ctxChanged) setEditNotice(null);
      editListingPendingRef.current = 0;
      return;
    }
    const doc = focusedDoc;
    editListingPendingRef.current = token;
    const runListingPass = async (): Promise<void> => {
      try {
        await runCommitGate();
      } catch {
        return; // gate failure surfaces on the commit banner; no overlays
      }
      if (editFetchTokenRef.current !== token) return;
      const f = state.files.get(doc.path);
      if (!f?.buffer) return;
      const proxy = await getDocumentProxy(doc.path, f.buffer);
      // Seed from the CURRENT listings when the context did NOT change:
      // rebuilding from empty published a gap window per page (two engine
      // round-trips each), during which an OPEN editor's page had no
      // listing — React unmounted the editor and re-seeded it from
      // pre-edit text, silently discarding the user's typing
      // (regression; the ctxChanged guard alone only stopped
      // the explicit clears). Stale-by-a-pass entries are safe here
      // precisely because ctxChanged=false means these bytes didn't
      // change; a REAL context change still starts empty (the
      // stale-index discipline). Per-page deletes below prune pages
      // whose fresh listing came back empty.
      const validIds = new Set(doc.pages.map((p) => p.id));
      const seed = <V,>(current: ReadonlyMap<string, V>): Map<string, V> => {
        const m = new Map<string, V>();
        for (const [k, v] of current) if (validIds.has(k)) m.set(k, v);
        return m;
      };
      const nextImages = ctxChanged
        ? new Map<string, EditImagePlacement[]>()
        : seed(editImagesRef.current);
      const nextVectors = ctxChanged
        ? new Map<string, EditVectorObject[]>()
        : seed(editVectorsRef.current);
      const nextText = ctxChanged
        ? new Map<string, EditTextListing>()
        : seed(editTextRef.current);
      // Geometry is derived (not user state), so it's rebuilt fresh each pass —
      // no seeding needed; a page's entry lands the moment its placements do.
      const nextGeom = new Map<string, PageGeometry>();
      for (const page of doc.pages) {
        if (editFetchTokenRef.current !== token) return;
        const pageNumber = workspacePageNumber(docs, doc, page.id);
        if (pageNumber == null) continue;
        try {
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          const geometry = {
            box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
            bakedRotate: p.rotate,
          };
          const call = (m: string, params: Record<string, unknown>): Promise<unknown> =>
            engineCall(m, params);
          const placements = await fetchEditPlacements(call, f.workingPath, pageNumber, geometry);
          if (editFetchTokenRef.current !== token) return;
          const vectors = await fetchEditVectors(call, f.workingPath, pageNumber, geometry);
          if (editFetchTokenRef.current !== token) return;
          const listing = await fetchEditTextListing(call, f.workingPath, pageNumber, geometry);
          if (editFetchTokenRef.current !== token) return;
          if (placements.length > 0) {
            nextImages.set(page.id, placements);
            nextGeom.set(page.id, geometry);
          } else {
            nextImages.delete(page.id);
            nextGeom.delete(page.id);
          }
          if (vectors.length > 0) nextVectors.set(page.id, vectors);
          else nextVectors.delete(page.id);
          // Geometry is needed whenever EITHER images or vectors exist.
          if (vectors.length > 0) nextGeom.set(page.id, geometry);
          setEditImagesByPage(new Map(nextImages)); // incremental fill
          setEditVectorsByPage(new Map(nextVectors));
          setEditGeomByPage(new Map(nextGeom));
          // Restore the stashed selection when ITS page's fresh
          // listing lands. Matched on sourcePageIndex, NOT the recomputed
          // tier position — a concurrent page-strip drag reorders tier
          // positions mid-flight while sourcePageIndex stays the physical
          // file slot. The stash PERSISTS across passes
          // (a commit's buffer pass and its reindex pass
          // each wipe editSel; a one-shot consume restored on the first
          // pass only for the second to wipe it) — restoring is idempotent
          // (the functional ?? keeps any user pick), and the stash dies on
          // tool/path change, decline/error, a USER selection (the
          // handleSelect*/open-editor/harness kills), or its target index
          // vanishing from its page.
          const stash = imageReselectRef.current;
          if (stash && page.sourcePageIndex === stash.pageNumber - 1) {
            const present = new Set(placements.map((pl) => pl.index));
            if (stash.indexes.every((i) => present.has(i))) {
              setEditSel(
                (prevSel) =>
                  prevSel ?? {
                    kind: 'image' as const,
                    pageId: page.id,
                    index: stash.indexes[stash.indexes.length - 1],
                    indexes: [...stash.indexes],
                  },
              );
            } else {
              imageReselectRef.current = null;
            }
          }
          // The same idempotent reselect for a vector
          // transform — restore selectedVector to the moved object on its
          // fresh-id page (the functional ?? keeps any user pick).
          const vstash = vectorReselectRef.current;
          if (vstash && page.sourcePageIndex === vstash.pageNumber - 1) {
            if (vectors.some((v) => v.index === vstash.index)) {
              setSelectedVector((prev) => prev ?? { pageId: page.id, index: vstash.index });
            } else {
              vectorReselectRef.current = null;
            }
          }
          if (listing.runBoxes.length > 0 || listing.paragraphs.length > 0) {
            nextText.set(page.id, listing);
          } else {
            nextText.delete(page.id);
          }
          setEditTextByPage(new Map(nextText));
        } catch {
          // One page's listing failing (odd stream) must not kill the mode —
          // that page simply offers no outlines.
        }
      }
      if (editFetchTokenRef.current === token) {
        setEditImagesByPage(new Map(nextImages));
        setEditGeomByPage(new Map(nextGeom));
        setEditTextByPage(new Map(nextText));
      }
    };
    // Only the CURRENT pass may report settled: a superseded pass bailing
    // out early must not clear the newer one's flag, and neither must it
    // clear the `-1` an in-flight action set while dropping a page's boxes.
    void runListingPass().finally(() => {
      if (editListingPendingRef.current === token) editListingPendingRef.current = 0;
    });
  }, [tool, focusedDoc, editBuffer, docs, state.files, engineCall]);

  // A mutation's status line (neutral notice or red error) + in-flight flag.
  // Renderer-side failures (decode, IO) would otherwise vanish as unhandled
  // rejections with zero UI — engine failures already surface via the op
  // queue, this covers the rest (regression).
  const [editNotice, setEditNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  // Ref, not state: two commits in one tick (the unmount-blur refire when
  // React removes the focused input) both read a STALE editBusy closure —
  // the applyingRef/signingRef rule this file already follows everywhere
  // else (regression). Declared here because the OPEN handlers gate on
  // it too (no new editor while a commit is in flight).
  const committingTextRef = useRef(false);

  const handleSelectEditImage = useCallback(
    (pageId: string, index: number, additive?: boolean) => {
      imageReselectRef.current = null; // a user pick owns selection now
      setEditNotice(null);
      setEditingText(null);
      setEditSel((prev) => {
        // Shift/Ctrl-click grows or shrinks a same-page group. A different page
        // starts fresh because a cross-page group has no coherent frame.
        if (additive && prev?.kind === 'image' && prev.pageId === pageId) {
          const has = prev.indexes.includes(index);
          const indexes = has
            ? prev.indexes.filter((i) => i !== index)
            : [...prev.indexes, index];
          if (indexes.length === 0) return null;
          return {
            kind: 'image',
            pageId,
            index: has ? indexes[indexes.length - 1] : index,
            indexes,
          };
        }
        // Plain click toggles a lone selection off or collapses a group to the
        // clicked member.
        if (
          prev?.kind === 'image' &&
          prev.pageId === pageId &&
          prev.index === index &&
          prev.indexes.length === 1
        ) {
          return null;
        }
        return { kind: 'image', pageId, index, indexes: [index] };
      });
    },
    [],
  );

  const handleSelectEditText = useCallback((pageId: string, index: number) => {
    imageReselectRef.current = null; // a user pick owns selection now
    setEditNotice(null);
    setEditingText(null);
    setEditSel((prev) =>
      prev?.kind === 'text' && prev.pageId === pageId && prev.index === index
        ? null
        : { kind: 'text', pageId, index },
    );
  }, []);

  // Select a vector object (toggle off on re-click). Its own selection
  // state, independent of the image/text `editSel`.
  const handleSelectEditVector = useCallback((pageId: string, index: number) => {
    setEditNotice(null);
    vectorReselectRef.current = null; // a user pick owns selection now
    setSelectedVector((prev) =>
      prev && prev.pageId === pageId && prev.index === index ? null : { pageId, index },
    );
  }, []);

  // Delete the selected vector object (undoable, App-routed). On success
  // the selection clears — the object is gone and the surviving ordinals
  // renumber, so a stale index must never linger.
  const handleDeleteVector = useCallback(async () => {
    if (!selectedVector || !focusedDoc || editBusy) return;
    const { pageId, index } = selectedVector;
    const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
    if (pageNumber == null) return;
    vectorReselectRef.current = null; // the object vanishes; ordinals renumber
    setEditBusy(true);
    setEditNotice(null);
    try {
      const notice = await onEditVector('delete', focusedDoc.path, pageNumber, index);
      if (notice === EDIT_DECLINED) {
        setEditNotice({ text: tChrome('canvas.edit.cancelled'), error: false });
      } else {
        setSelectedVector(null);
      }
    } catch (err) {
      setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setEditBusy(false);
    }
  }, [selectedVector, focusedDoc, docs, onEditVector, editBusy]);

  // Commit a move/resize/rotate — the transform overlay produces the
  // target placement matrix M' (device space). The whole-file op rebuilds the
  // page, so re-fetch drops the selection like every other vector op; a second
  // gesture re-derives from the re-listed bbox (the "rebuild → re-select"
  // shape). No committingTextRef churn — the overlay's own busy gate blocks a
  // second gesture mid-commit.
  const commitVectorTransform = useCallback(
    async (pageId: string, index: number, matrix: number[]): Promise<void> => {
      if (!focusedDoc || editBusy) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      if (pageNumber == null) return;
      setEditBusy(true);
      setEditNotice(null);
      // Stash for the post-op reselect (the rebuild regenerates page ids).
      vectorReselectRef.current = { pageNumber, index };
      try {
        const notice = await onEditVector('transform', focusedDoc.path, pageNumber, index, {
          matrix,
        });
        if (notice === EDIT_DECLINED) {
          setEditNotice({
            text: tChrome('canvas.edit.cancelled'),
            error: false,
          });
        }
      } catch (err) {
        setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, onEditVector, editBusy],
  );

  // Recolour / re-width a vector object. The whole-file op rebuilds the
  // page, so it reselects like a transform (the same stash).
  const commitVectorRestyle = useCallback(
    async (
      pageId: string,
      index: number,
      opts: {
        fill?: [number, number, number];
        stroke?: [number, number, number];
        lineWidth?: number;
      },
    ): Promise<void> => {
      if (!focusedDoc || editBusy) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      if (pageNumber == null) return;
      setEditBusy(true);
      setEditNotice(null);
      vectorReselectRef.current = { pageNumber, index };
      try {
        const notice = await onEditVector('restyle', focusedDoc.path, pageNumber, index, opts);
        if (notice === EDIT_DECLINED) {
          setEditNotice({
            text: tChrome('canvas.edit.cancelled'),
            error: false,
          });
        }
      } catch (err) {
        setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, onEditVector, editBusy],
  );

  const handleOpenTextEditor = useCallback(
    (pageId: string, index: number) => {
      // Same busy gate as the paragraph editor (see its comment).
      if (editBusy || committingTextRef.current) return;
      const run = editTextByPage.get(pageId)?.runBoxes.find((r) => r.index === index);
      if (!run) return;
      imageReselectRef.current = null; // a user pick owns selection now
      if (!run.editable) {
        // The refusal SELECTS the run too — the toolbar must reflect what
        // was just clicked, not a previous image selection (regression).
        setEditSel({ kind: 'text', pageId, index });
        setEditNotice({
          text: run.reason ?? tChrome('canvas.edit.textNotEditable'),
          error: true,
        });
        return;
      }
      setEditNotice(null);
      setEditSel({ kind: 'text', pageId, index });
      setEditingText({ kind: 'text', pageId, index });
    },
    [editTextByPage, editBusy],
  );

  const handleSelectEditParagraph = useCallback((pageId: string, index: number) => {
    imageReselectRef.current = null; // a user pick owns selection now
    setEditNotice(null);
    setEditingText(null);
    setEditSel((prev) =>
      prev?.kind === 'para' && prev.pageId === pageId && prev.index === index
        ? null
        : { kind: 'para', pageId, index },
    );
  }, []);

  const handleOpenParagraphEditor = useCallback(
    (pageId: string, index: number) => {
      // While a commit is in flight a NEW editor's Enter would be
      // silently swallowed by committingTextRef — refuse to open one
      // instead (regression; the busy hint is already visible).
      if (editBusy || committingTextRef.current) return;
      const para = editTextByPage.get(pageId)?.paragraphs.find((p) => p.index === index);
      if (!para) return; // only editable paragraphs are listed
      imageReselectRef.current = null; // a user pick owns selection now
      setEditNotice(null);
      setEditSel({ kind: 'para', pageId, index });
      setEditingText({ kind: 'para', pageId, index });
    },
    [editTextByPage, editBusy],
  );

  const handleCancelTextEdit = useCallback(() => setEditingText(null), []);

  // Split view: per-pane page reporting + activation. Each pane always
  // records its own latest page (so activating a pane can refresh the
  // readout instantly), but only the active pane drives the toolbar box and
  // ui.currentPageId; inactive panes scroll without changing global state.
  const lastPanePages = useRef<Record<'a' | 'b' | 'c' | 'd', number>>({ a: 1, b: 1, c: 1, d: 1 });
  const panePageChange = useCallback(
    (pane: 'a' | 'b' | 'c' | 'd') => (n: number) => {
      lastPanePages.current[pane] = n;
      const drives =
        pane === 'a'
          ? !splitViewRef.current || activePaneRef.current === 'a'
          : splitViewRef.current && activePaneRef.current === pane;
      if (drives) setCurrentPage(n);
    },
    [],
  );
  const onPaneAPageChange = useMemo(() => panePageChange('a'), [panePageChange]);
  const onPaneBPageChange = useMemo(() => panePageChange('b'), [panePageChange]);
  const onPaneCPageChange = useMemo(() => panePageChange('c'), [panePageChange]);
  const onPaneDPageChange = useMemo(() => panePageChange('d'), [panePageChange]);
  const activatePane = useCallback((pane: 'a' | 'b' | 'c' | 'd') => {
    if (activePaneRef.current === pane) return;
    // Switching panes CANCELS an open text/paragraph editor (same as Esc):
    // the editor renders only in the active pane, and letting a hidden
    // instance survive would let a stale draft clobber a later commit.
    setEditingText(null);
    setActivePane(pane);
    setCurrentPage(lastPanePages.current[pane]);
  }, []);
  // Toggling split off (or dropping quad → two while c/d was active) returns
  // the readout to a SURVIVING pane.
  useEffect(() => {
    const surviving =
      splitMode === 'off' ? 'a' : splitMode === 'two' && (activePaneRef.current === 'c' || activePaneRef.current === 'd') ? 'a' : null;
    if (surviving) {
      setActivePane(surviving);
      setCurrentPage(lastPanePages.current[surviving]);
    }
  }, [splitMode]);

  // Quad mode's frozen-pane scroll links: panes in a ROW share vertical
  // scroll, panes in a COLUMN share horizontal scroll. Wired at the DOM
  // (DocumentView's root IS its scroller); the syncing flag stops the
  // mirrored assignment's own scroll event from echoing forever.
  useEffect(() => {
    if (splitMode !== 'quad') return;
    const root = quadContainerRef.current;
    if (!root) return;
    const panes = ['a', 'b', 'c', 'd'] as const;
    const scrollers = new Map<string, HTMLElement>();
    for (const p of panes) {
      const el = root.querySelector<HTMLElement>(
        `[data-testid="doc-pane-${p}"] [data-testid="document-view"]`,
      );
      if (!el) return; // a pane not mounted yet — the next effect run wires it
      scrollers.set(p, el);
    }
    const rowOf: Record<string, string> = { a: 'b', b: 'a', c: 'd', d: 'c' };
    const colOf: Record<string, string> = { a: 'c', c: 'a', b: 'd', d: 'b' };
    let syncing = false;
    const cleanups: (() => void)[] = [];
    for (const p of panes) {
      const el = scrollers.get(p)!;
      const onScroll = (): void => {
        if (syncing) return;
        syncing = true;
        scrollers.get(rowOf[p])!.scrollTop = el.scrollTop;
        scrollers.get(colOf[p])!.scrollLeft = el.scrollLeft;
        requestAnimationFrame(() => {
          syncing = false;
        });
      };
      el.addEventListener('scroll', onScroll);
      cleanups.push(() => el.removeEventListener('scroll', onScroll));
    }
    return () => cleanups.forEach((fn) => fn());
  }, [splitMode, focusedDoc?.id]);
  // The divider: a plain pointer drag with WINDOW-level listeners (the
  // canvas-drag idiom — synthetic React pointermove does not deliver
  // reliably in the webview). Ratio clamped so neither pane can collapse.
  const onDividerPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const el = splitContainerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const onMove = (ev: PointerEvent): void => {
      const r = (ev.clientY - rect.top) / Math.max(rect.height, 1);
      setSplitRatio(Math.min(0.85, Math.max(0.15, r)));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);
  // The quad's two dividers (same window-listener idiom, against the quad
  // container): rows reuse splitRatio, columns drive quadCol.
  const onQuadDividerDown = useCallback((axis: 'row' | 'col', e: React.PointerEvent) => {
    e.preventDefault();
    const el = quadContainerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const onMove = (ev: PointerEvent): void => {
      if (axis === 'row') {
        const r = (ev.clientY - rect.top) / Math.max(rect.height, 1);
        setSplitRatio(Math.min(0.85, Math.max(0.15, r)));
      } else {
        const c = (ev.clientX - rect.left) / Math.max(rect.width, 1);
        setQuadCol(Math.min(0.85, Math.max(0.15, c)));
      }
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const handleCommitTextEdit = useCallback(
    async (
      pageId: string,
      index: number,
      newText: string,
      opts?: { convert?: boolean },
    ): Promise<void> => {
      if (!focusedDoc || committingTextRef.current) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      if (pageNumber == null) return;
      committingTextRef.current = true;
      setEditingText(null);
      setEditSel(null);
      setEditBusy(true);
      setEditNotice(null);
      // Same stale-window discipline as image mutations: this page's runs
      // are about to change identity — drop them synchronously, but keep
      // the old value so a DECLINED signed-doc warning (no buffer change,
      // no refetch) can put it back instead of leaving the run invisibly
      // gone (regression: indistinguishable from success).
      const previousListing = editTextByPage.get(pageId);
      setEditTextByPage((prev) => {
        const next = new Map(prev);
        next.delete(pageId);
        return next;
      });
      try {
        const result = await onEditText(focusedDoc.path, pageNumber, index, newText, opts);
        if (result === EDIT_DECLINED) {
          if (previousListing) {
            setEditTextByPage((prev) => {
              const next = new Map(prev);
              next.set(pageId, previousListing);
              return next;
            });
          }
          setEditNotice({ text: tChrome('canvas.edit.cancelled'), error: false });
        }
      } catch (err) {
        if (previousListing) {
          setEditTextByPage((prev) => {
            const next = new Map(prev);
            next.set(pageId, previousListing);
            return next;
          });
        }
        setEditNotice({
          text: err instanceof Error ? err.message : String(err),
          error: true,
        });
      } finally {
        committingTextRef.current = false;
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, editTextByPage, onEditText],
  );

  // The run editor's style commit — same stale-window + restore-on-
  // decline discipline as the text commit above, engine restyle_text_run.
  const handleRestyleTextEdit = useCallback(
    async (
      pageId: string,
      index: number,
      style: { size?: number; color?: [number, number, number] },
    ): Promise<void> => {
      if (!focusedDoc || committingTextRef.current) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      if (pageNumber == null) return;
      committingTextRef.current = true;
      setEditingText(null);
      setEditSel(null);
      setEditBusy(true);
      setEditNotice(null);
      const previousListing = editTextByPage.get(pageId);
      setEditTextByPage((prev) => {
        const next = new Map(prev);
        next.delete(pageId);
        return next;
      });
      try {
        const result = await onRestyleText(focusedDoc.path, pageNumber, index, style);
        if (result === EDIT_DECLINED) {
          if (previousListing) {
            setEditTextByPage((prev) => {
              const next = new Map(prev);
              next.set(pageId, previousListing);
              return next;
            });
          }
          setEditNotice({ text: tChrome('canvas.edit.cancelled'), error: false });
        }
      } catch (err) {
        if (previousListing) {
          setEditTextByPage((prev) => {
            const next = new Map(prev);
            next.set(pageId, previousListing);
            return next;
          });
        }
        setEditNotice({
          text: err instanceof Error ? err.message : String(err),
          error: true,
        });
      } finally {
        committingTextRef.current = false;
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, editTextByPage, onRestyleText],
  );

  const handleCommitParagraphEdit = useCallback(
    async (
      pageId: string,
      index: number,
      newText: string,
      opts?: ParagraphEditOpts,
    ): Promise<void> => {
      if (!focusedDoc || committingTextRef.current) return;
      const para = editTextByPage.get(pageId)?.paragraphs.find((p) => p.index === index);
      if (!para) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      if (pageNumber == null) return;
      committingTextRef.current = true;
      setEditingText(null);
      setEditSel(null);
      setEditBusy(true);
      setEditNotice(null);
      // The commit applies the SAME position-aware relaxation the
      // editor validated with (one implementation — the mappings cannot
      // disagree). Substitution/feature commits skip it, exactly as the
      // editor's validation does (the member inventories no longer govern).
      const spans0 = computeEditSpans(para.text, newText, para.spans);
      const relaxing = !(
        opts?.family !== undefined ||
        opts?.bold !== undefined ||
        opts?.italic !== undefined ||
        (opts?.features?.length ?? 0) > 0
      );
      const spans = relaxing
        ? relaxUnencodableSpans(newText, spans0, para.encodableByRun, para.sequencesByRun).spans
        : spans0;
      const previousListing = editTextByPage.get(pageId);
      setEditTextByPage((prev) => {
        const next = new Map(prev);
        next.delete(pageId);
        return next;
      });
      try {
        const result = await onEditParagraph(
          focusedDoc.path,
          pageNumber,
          { index: para.index, runs: para.runs, text: para.text },
          newText,
          spans,
          opts,
        );
        if (result === EDIT_DECLINED) {
          if (previousListing) {
            setEditTextByPage((prev) => {
              const next = new Map(prev);
              next.set(pageId, previousListing);
              return next;
            });
          }
          setEditNotice({ text: tChrome('canvas.edit.cancelled'), error: false });
        }
      } catch (err) {
        if (previousListing) {
          setEditTextByPage((prev) => {
            const next = new Map(prev);
            next.set(pageId, previousListing);
            return next;
          });
        }
        setEditNotice({
          text: err instanceof Error ? err.message : String(err),
          error: true,
        });
      } finally {
        committingTextRef.current = false;
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, editTextByPage, onEditParagraph],
  );

  // Merge the edited paragraph into the one above (fires only from an
  // unchanged editor at caret 0 — the editor enforces that). Same commit
  // shape as handleCommitParagraphEdit: close editor, drop the page's stale
  // listing synchronously, restore on decline/error.
  // Generalized core: `anchor` keeps its box, `merging` folds into it.
  // The shipped Backspace path is anchor=index−1/merging=index (upward);
  // the Delete path is anchor=index (the selected)/merging=index+1. An
  // edited editor's text rides as the SELECTED side's override (the
  // selected paragraph is `merging` upward, `anchor` on the next path).
  const mergeParagraphs = useCallback(
    async (
      pageId: string,
      anchorIdx: number,
      mergingIdx: number,
      withNext: boolean,
      editedText?: string,
      restyle?: MergeRestyle,
    ): Promise<void> => {
      if (!focusedDoc || committingTextRef.current) return;
      const listing = editTextByPage.get(pageId);
      const anchor = listing?.paragraphs.find((p) => p.index === anchorIdx);
      const merging = listing?.paragraphs.find((p) => p.index === mergingIdx);
      if (!anchor || !merging) return;
      const selectedPara = withNext ? anchor : merging;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      if (pageNumber == null) return;
      committingTextRef.current = true;
      setEditingText(null);
      setEditSel(null);
      setEditBusy(true);
      setEditNotice(null);
      const previousListing = editTextByPage.get(pageId);
      setEditTextByPage((prevMap) => {
        const next = new Map(prevMap);
        next.delete(pageId);
        return next;
      });
      try {
        const result = await onMergeParagraph(
          focusedDoc.path,
          pageNumber,
          { index: anchor.index, runs: anchor.runs, text: anchor.text },
          { index: merging.index, runs: merging.runs, text: merging.text },
          {
            ...(restyle ? { restyle } : {}),
            ...(withNext ? { withNext: true } : {}),
            ...(editedText !== undefined && editedText !== selectedPara.text
              ? {
                  overrideText: editedText,
                  overrideSpans: computeEditSpans(
                    selectedPara.text,
                    editedText,
                    selectedPara.spans,
                  ),
                }
              : {}),
          },
        );
        if (result === EDIT_DECLINED) {
          if (previousListing) {
            setEditTextByPage((prevMap) => {
              const next = new Map(prevMap);
              next.set(pageId, previousListing);
              return next;
            });
          }
          setEditNotice({ text: tChrome('canvas.edit.cancelled'), error: false });
        } else if (typeof result === 'string') {
          setEditNotice({ text: result, error: false });
        }
      } catch (err) {
        if (previousListing) {
          setEditTextByPage((prevMap) => {
            const next = new Map(prevMap);
            next.set(pageId, previousListing);
            return next;
          });
        }
        setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        committingTextRef.current = false;
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, editTextByPage, onMergeParagraph],
  );
  const handleMergeParagraphPrev = useCallback(
    (pageId: string, index: number, editedText?: string, restyle?: MergeRestyle) =>
      mergeParagraphs(pageId, index - 1, index, false, editedText, restyle),
    [mergeParagraphs],
  );
  const handleMergeParagraphNext = useCallback(
    (pageId: string, index: number, editedText?: string, restyle?: MergeRestyle) =>
      mergeParagraphs(pageId, index, index + 1, true, editedText, restyle),
    [mergeParagraphs],
  );

  const runEditAction = useCallback(
    async (
      kind: 'delete' | 'replace' | 'extract' | 'crop' | 'opacity',
      opts?: Parameters<typeof onEditImage>[4],
    ): Promise<void> => {
      if (!editSel || editSel.kind !== 'image' || !focusedDoc || editBusy) return;
      const pageNumber = workspacePageNumber(docs, focusedDoc, editSel.pageId);
      // The selection outlived its page (its generation-tagged id no longer
      // resolves — a rebuild landed between the click and the action). Refuse
      // LOUDLY: a silent return is a menu item that does nothing, which is
      // how this shipped broken.
      if (pageNumber == null) {
        setEditSel(null);
        setEditNotice({ text: tChrome('canvas.edit.imagePageGone'), error: true });
        return;
      }
      const target = editSel;
      setEditBusy(true);
      setEditNotice(null);
      // Count-preserving kinds re-select after the rebuild; delete's
      // index dies with the placement and extract changes nothing.
      imageReselectRef.current =
        kind === 'replace' || kind === 'crop' || kind === 'opacity'
          ? { pageNumber, indexes: [...target.indexes] }
          : null;
      const previousPlacements = editImagesByPage.get(target.pageId);
      if (kind !== 'extract') {
        // Indexes shift under a delete; the refetch is a per-page engine
        // round-trip away. Drop this page's stale boxes SYNCHRONOUSLY so a
        // click in the window can't target the wrong image (regression:
        // delete index 0 of three, click the still-drawn old box for what
        // is now a different placement).
        setEditSel(null);
        setEditImagesByPage((prev) => {
          const next = new Map(prev);
          next.delete(target.pageId);
          return next;
        });
        // A refetch is now OWED: the map is deliberately missing a page that
        // still has images. Anything asking "is this page empty?" must not
        // read this window as an answer (the sentinel is replaced by the
        // refetch pass's own token; the decline/error arms below clear it
        // when no refetch will come).
        editListingPendingRef.current = -1;
      }
      try {
        // A group delete is ONE engine call (one undo entry) — every
        // other action stays single-target (the toolbar restricts them to
        // N=1; the anchor is the honest target if one slips through).
        const notice =
          kind === 'delete' && target.indexes.length > 1
            ? await onEditImagesGroup('delete', focusedDoc.path, pageNumber, {
                indexes: [...target.indexes],
              })
            : await onEditImage(kind, focusedDoc.path, pageNumber, target.index, opts);
        if (notice === EDIT_DECLINED) {
          imageReselectRef.current = null;
          // Declined signed-doc warning: no buffer change, no refetch —
          // restore the synchronously-dropped placements and say so
          // (regression: silence read as success).
          if (kind !== 'extract' && previousPlacements) {
            setEditImagesByPage((prev) => {
              const next = new Map(prev);
              next.set(target.pageId, previousPlacements);
              return next;
            });
          }
          setEditNotice({ text: tChrome('canvas.edit.cancelled'), error: false });
          if (editListingPendingRef.current === -1) editListingPendingRef.current = 0;
        } else if (typeof notice === 'string') {
          setEditNotice({ text: notice, error: false });
        }
      } catch (err) {
        imageReselectRef.current = null;
        // A failed op left the file untouched, so no refetch is coming —
        // put the boxes back (the decline arm's rule) instead of leaving
        // the page silently box-less until the next unrelated pass.
        if (kind !== 'extract' && previousPlacements) {
          setEditImagesByPage((prev) => {
            const next = new Map(prev);
            next.set(target.pageId, previousPlacements);
            return next;
          });
        }
        if (editListingPendingRef.current === -1) editListingPendingRef.current = 0;
        setEditNotice({
          text: err instanceof Error ? err.message : String(err),
          error: true,
        });
      } finally {
        setEditBusy(false);
      }
    },
    [editSel, focusedDoc, docs, onEditImage, onEditImagesGroup, editBusy, editImagesByPage],
  );

  // The selected image's transform context is its user-space matrix plus the
  // page geometry the gesture needs to convert pointer↔user space. Null unless
  // exactly one image is selected and its page geometry is loaded. A group
  // renders a frame without skew or crop controls.
  const editImageTransform = useMemo(() => {
    if (!editSel || editSel.kind !== 'image' || editSel.indexes.length !== 1) return null;
    const placement = editImagesByPage
      .get(editSel.pageId)
      ?.find((pl) => pl.index === editSel.index);
    const geom = editGeomByPage.get(editSel.pageId);
    if (!placement || !geom) return null;
    return {
      pageId: editSel.pageId,
      index: editSel.index,
      matrix: placement.matrix,
      crop: placement.crop,
      mask: placement.mask,
      box: geom.box,
      bakedRotate: geom.bakedRotate,
      busy: editBusy,
    };
  }, [editSel, editImagesByPage, editGeomByPage, editBusy]);

  // The group transform context (N>1) — every member's committed matrix +
  // the shared page geometry. Members missing from the listing (mid-refetch)
  // drop out; below 2 the group frame stands down.
  const editImageGroup = useMemo(() => {
    if (!editSel || editSel.kind !== 'image' || editSel.indexes.length < 2) return null;
    const placements = editImagesByPage.get(editSel.pageId);
    const geom = editGeomByPage.get(editSel.pageId);
    if (!placements || !geom) return null;
    const members = editSel.indexes
      .map((i) => placements.find((pl) => pl.index === i))
      .filter((pl): pl is NonNullable<typeof pl> => !!pl)
      .map((pl) => ({ index: pl.index, matrix: pl.matrix }));
    if (members.length < 2) return null;
    return {
      pageId: editSel.pageId,
      members,
      box: geom.box,
      bakedRotate: geom.bakedRotate,
      busy: editBusy,
    };
  }, [editSel, editImagesByPage, editGeomByPage, editBusy]);

  // The selected vector's transform context — the SAME shape the image
  // transform overlay consumes (reused directly), with the object's bbox as a
  // unit-square placement matrix [w,0,0,h,x0,y0] and no crop (vectors don't
  // crop). Null unless a vector is selected on a page with known geometry.
  const vectorTransform = useMemo(() => {
    if (!selectedVector) return null;
    const obj = editVectorsByPage
      .get(selectedVector.pageId)
      ?.find((v) => v.index === selectedVector.index);
    const geom = editGeomByPage.get(selectedVector.pageId);
    if (!obj || !geom) return null;
    const [x0, y0, x1, y1] = obj.userRect;
    return {
      pageId: selectedVector.pageId,
      index: selectedVector.index,
      matrix: [x1 - x0, 0, 0, y1 - y0, x0, y0] as [number, number, number, number, number, number],
      crop: null,
      mask: null,
      box: geom.box,
      bakedRotate: geom.bakedRotate,
      busy: editBusy,
    };
  }, [selectedVector, editVectorsByPage, editGeomByPage, editBusy]);

  // Commit a transform gesture. M' is user-space and /Rotate-invariant
  // (the redaction-mark rule), so the commit gate baking a pending page
  // rotation can't invalidate it — no re-projection needed, unlike the
  // signature placement. The whole-file op rebuilds the page (positional ids
  // regenerate); the reselect stash restores the selection when the fresh
  // listing lands, so chained nudges need no re-click (the shipped C-tail).
  // Resolves TRUE only when the transform actually ran. Every refusal below
  // leaves the document untouched while the promise resolves, so a caller that
  // issues once and then watches for the new matrix would wait out its whole
  // timeout on a result that was never coming; the outcome is returned so the
  // refusal is a fact the caller can act on rather than silence. The gesture
  // path ignores it — the notice line is what the user reads.
  const commitImageTransform = useCallback(
    async (pageId: string, index: number, matrix: number[]): Promise<boolean> => {
      if (!focusedDoc || editBusy) return false;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      // Same refusal as runEditAction: the gesture's page died under it.
      if (pageNumber == null) {
        setEditSel(null);
        setEditNotice({ text: tChrome('canvas.edit.imagePageGone'), error: true });
        return false;
      }
      setEditBusy(true);
      setEditNotice(null);
      imageReselectRef.current = { pageNumber, indexes: [index] };
      try {
        const notice = await onEditImage('transform', focusedDoc.path, pageNumber, index, {
          matrix,
        });
        if (notice === EDIT_DECLINED) {
          imageReselectRef.current = null;
          setEditNotice({ text: tChrome('canvas.edit.cancelled'), error: false });
          return false;
        }
        if (typeof notice === 'string') {
          setEditNotice({ text: notice, error: false });
        }
        return true;
      } catch (err) {
        imageReselectRef.current = null;
        setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
        return false;
      } finally {
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, onEditImage, editBusy],
  );

  // Commit a GROUP gesture — per-member absolute targets through the ONE
  // multi op (one undo entry). The stash re-selects the whole group when the
  // fresh listing lands (count-preserving, so all members survive).
  const commitImageGroupTransform = useCallback(
    async (
      pageId: string,
      targets: { index: number; matrix: number[] }[],
      reselectIndexes?: number[],
    ): Promise<boolean> => {
      if (!focusedDoc || editBusy || targets.length === 0) return false;
      const pageNumber = workspacePageNumber(docs, focusedDoc, pageId);
      // Same refusal as runEditAction: the group's page died under it.
      if (pageNumber == null) {
        setEditSel(null);
        setEditNotice({ text: tChrome('canvas.edit.imagePageGone'), error: true });
        return false;
      }
      setEditBusy(true);
      setEditNotice(null);
      // An align can move a SUBSET while the whole group must re-select.
      imageReselectRef.current = {
        pageNumber,
        indexes: reselectIndexes ?? targets.map((t) => t.index),
      };
      try {
        const notice = await onEditImagesGroup('transform', focusedDoc.path, pageNumber, {
          targets,
        });
        if (notice === EDIT_DECLINED) {
          imageReselectRef.current = null;
          setEditNotice({ text: tChrome('canvas.edit.cancelled'), error: false });
          return false;
        }
        if (typeof notice === 'string') {
          setEditNotice({ text: notice, error: false });
        }
        return true;
      } catch (err) {
        imageReselectRef.current = null;
        setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
        return false;
      } finally {
        setEditBusy(false);
      }
    },
    [focusedDoc, docs, onEditImagesGroup, editBusy],
  );

  // Align or distribute a group through per-member translations committed in
  // one multi operation. Boxes are user-space AABBs of each member's transformed
  // quad, and alignment references the group's extents.
  const alignImageGroup = useCallback(
    (
      mode: 'left' | 'centerh' | 'right' | 'top' | 'centerv' | 'bottom' | 'disth' | 'distv',
    ): void => {
      if (!editImageGroup || editImageGroup.busy) return;
      const boxes = editImageGroup.members.map((m) => {
        const corners = LOCAL_CORNERS.map(([lx, ly]) =>
          transformPoint(m.matrix as Mat, lx, ly),
        );
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        return {
          index: m.index,
          matrix: m.matrix,
          x0: Math.min(...xs),
          x1: Math.max(...xs),
          y0: Math.min(...ys),
          y1: Math.max(...ys),
        };
      });
      const minX = Math.min(...boxes.map((b) => b.x0));
      const maxX = Math.max(...boxes.map((b) => b.x1));
      const minY = Math.min(...boxes.map((b) => b.y0));
      const maxY = Math.max(...boxes.map((b) => b.y1));
      let moves: { index: number; dx: number; dy: number }[];
      if (mode === 'disth' || mode === 'distv') {
        // Even gaps between sorted neighbours, first and last pinned.
        const horizontal = mode === 'disth';
        const sorted = [...boxes].sort((a, b) => (horizontal ? a.x0 - b.x0 : a.y0 - b.y0));
        const span = horizontal ? maxX - minX : maxY - minY;
        const total = sorted.reduce(
          (s, b) => s + (horizontal ? b.x1 - b.x0 : b.y1 - b.y0),
          0,
        );
        const gap = (span - total) / (sorted.length - 1);
        let cursor = horizontal ? minX : minY;
        moves = sorted.map((b) => {
          const size = horizontal ? b.x1 - b.x0 : b.y1 - b.y0;
          const delta = cursor - (horizontal ? b.x0 : b.y0);
          cursor += size + gap;
          return { index: b.index, dx: horizontal ? delta : 0, dy: horizontal ? 0 : delta };
        });
      } else {
        moves = boxes.map((b) => {
          if (mode === 'left') return { index: b.index, dx: minX - b.x0, dy: 0 };
          if (mode === 'right') return { index: b.index, dx: maxX - b.x1, dy: 0 };
          if (mode === 'centerh')
            return { index: b.index, dx: (minX + maxX) / 2 - (b.x0 + b.x1) / 2, dy: 0 };
          if (mode === 'top') return { index: b.index, dx: 0, dy: maxY - b.y1 };
          if (mode === 'bottom') return { index: b.index, dx: 0, dy: minY - b.y0 };
          return { index: b.index, dx: 0, dy: (minY + maxY) / 2 - (b.y0 + b.y1) / 2 };
        });
      }
      const byIndex = new Map(boxes.map((b) => [b.index, b.matrix]));
      const targets = moves
        .filter((mv) => Math.abs(mv.dx) > 1e-6 || Math.abs(mv.dy) > 1e-6)
        .map((mv) => {
          const m = byIndex.get(mv.index)!;
          return { index: mv.index, matrix: [m[0], m[1], m[2], m[3], m[4] + mv.dx, m[5] + mv.dy] };
        });
      if (targets.length === 0) return; // already aligned — no undo churn
      // Untouched members still re-select: stash the full group.
      const all = editImageGroup.members.map((m) => m.index);
      void commitImageGroupTransform(editImageGroup.pageId, targets, all);
    },
    [editImageGroup, commitImageGroupTransform],
  );

  // Crop mode (toolbar toggle) — armed, the overlay's body drag draws
  // the crop band. Reset whenever the selection changes: a stale armed crop
  // on a fresh selection would surprise.
  const [imageCropArmed, setImageCropArmed] = useState(false);
  useEffect(() => {
    setImageCropArmed(false);
  }, [editSel]);

  // The overlay reports pageId/index explicitly; they always match the
  // selection (the overlay only renders for it) — verified, then routed
  // through runEditAction so busy/notice/stale-box handling is shared.
  const commitImageCrop = useCallback(
    (pageId: string, index: number, rect: [number, number, number, number]): void => {
      if (!editSel || editSel.kind !== 'image') return;
      if (editSel.pageId !== pageId || editSel.index !== index) return;
      setImageCropArmed(false);
      void runEditAction('crop', { rect });
    },
    [editSel, runEditAction],
  );

  // Opacity commit (slider release) — same shared routing.
  const commitImageOpacity = useCallback(
    (value: number): void => {
      void runEditAction('opacity', { opacity: value });
    },
    [runEditAction],
  );

  // Quarter-turn buttons compose onto the committed matrix. With a group
  // selected, every member turns around the group center and the multi-image
  // edit commits atomically, so the arrangement turns as a unit.
  const rotateImage90 = useCallback(
    (dir: 1 | -1): void => {
      if (editImageGroup && !editImageGroup.busy) {
        const pts = editImageGroup.members.flatMap((m) =>
          LOCAL_CORNERS.map(([lx, ly]) => transformPoint(m.matrix as Mat, lx, ly)),
        );
        const cx = (Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2;
        const cy = (Math.min(...pts.map((p) => p[1])) + Math.max(...pts.map((p) => p[1]))) / 2;
        const a = (dir * Math.PI) / 2;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const d: Mat = [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos];
        void commitImageGroupTransform(
          editImageGroup.pageId,
          editImageGroup.members.map((m) => ({
            index: m.index,
            matrix: [...matMul(m.matrix as Mat, d)],
          })),
        );
        return;
      }
      if (!editImageTransform || editImageTransform.busy) return;
      const m = applyRotate(
        editImageTransform.matrix as Mat,
        (dir * Math.PI) / 2,
      );
      void commitImageTransform(editImageTransform.pageId, editImageTransform.index, [...m]);
    },
    [editImageTransform, editImageGroup, commitImageTransform, commitImageGroupTransform],
  );

  // The selected placement's kind — replace/extract disable for an
  // inline draw (honest disable at the control, engine refusal as belt).
  // The selected placement's current opacity — the slider's honest seed.
  const editImageOpacity = useMemo(() => {
    // Single selection only: per-member opacities diverge in a group,
    // so a shared slider would lie about N−1 of them.
    if (!editSel || editSel.kind !== 'image' || editSel.indexes.length !== 1) return null;
    return (
      editImagesByPage.get(editSel.pageId)?.find((pl) => pl.index === editSel.index)?.opacity ?? 1
    );
  }, [editSel, editImagesByPage]);

  // The single selected placement's KIND — the toolbar disables
  // replace/extract for a placed vector graphic (engine refusal as belt).
  const editImageSelKind = useMemo(() => {
    if (!editSel || editSel.kind !== 'image' || editSel.indexes.length !== 1) return null;
    return (
      editImagesByPage.get(editSel.pageId)?.find((pl) => pl.index === editSel.index)?.kind ?? null
    );
  }, [editSel, editImagesByPage]);

  // The selected placement's blend mode (seed) — single-only,
  // same divergence rule as opacity.
  const editImageBlend = useMemo(() => {
    if (!editSel || editSel.kind !== 'image' || editSel.indexes.length !== 1) return null;
    return (
      editImagesByPage.get(editSel.pageId)?.find((pl) => pl.index === editSel.index)?.blend ??
      'Normal'
    );
  }, [editSel, editImagesByPage]);

  const commitImageBlend = useCallback(
    (blend: string): void => {
      void runEditAction('opacity', { blend });
    },
    [runEditAction],
  );

  // The selected placement's tool gradient mask (seed) —
  // 'none' when a single image is selected without one, null when the
  // control has no target at all.
  const editImageMask = useMemo(() => {
    if (!editSel || editSel.kind !== 'image' || editSel.indexes.length !== 1) return null;
    const placement = editImagesByPage
      .get(editSel.pageId)
      ?.find((pl) => pl.index === editSel.index);
    if (!placement) return null;
    return placement.mask ?? ({ kind: 'none' } as const);
  }, [editSel, editImagesByPage]);

  const commitImageMask = useCallback(
    (mask: import('../../lib/edit-images').EditImageMaskParam): void => {
      void runEditAction('opacity', { mask });
    },
    [runEditAction],
  );

  // The overlay's mask-dot commit — pageId/index verified against the
  // selection like commitImageCrop, then routed through the shared action.
  const commitImageMaskFromOverlay = useCallback(
    (
      pageId: string,
      index: number,
      mask: import('../../lib/edit-images').EditImageMaskParam,
    ): void => {
      if (!editSel || editSel.kind !== 'image') return;
      if (editSel.pageId !== pageId || editSel.index !== index) return;
      commitImageMask(mask);
    },
    [editSel, commitImageMask],
  );

  // Add Image: the band draws the box; convert display→user space
  // (buildSignatureAppearance, verbatim from Add Text) and hand it to App's
  // onAddImage, which picks the file and embeds. No card — the native picker
  // is the second step. Reentrancy-guarded (a modal pick blocks other edits
  // meanwhile; a cancelled pick just resets it).
  const addImageRef = useRef(false);
  const onAddImageRect = useCallback(
    async (
      docId: string,
      pageId: string,
      rect: { x: number; y: number; w: number; h: number },
      rotationAtDraw: 0 | 90 | 180 | 270,
    ): Promise<void> => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc || addImageRef.current || editBusy) return;
      addImageRef.current = true;
      setEditBusy(true);
      setEditNotice(null);
      try {
        const placement: SignaturePlacement = {
          id: crypto.randomUUID(),
          path: doc.path,
          pageId,
          rect,
          rotationAtDraw,
        };
        const built = await buildSignatureAppearance(docs, placement, async (page) => {
          const f = state.files.get(page.sourceDocId);
          if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
          const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          return {
            box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
            bakedRotate: p.rotate,
          };
        });
        if (!built) throw new Error(tChrome('canvas.edit.imagePageGone'));
        // The PageCell click sentinel (w=h=0) degenerates the
        // appearance rect to the click point — route it as a natural-size
        // `at` placement instead of a drawn box.
        const isClick = rect.w === 0 && rect.h === 0;
        const [rx0, ry0, rx1, ry1] = built.appearance.rect;
        const notice = isClick
          ? await onAddImage(built.path, built.appearance.page, null, undefined, [
              (rx0 + rx1) / 2,
              (ry0 + ry1) / 2,
            ])
          : await onAddImage(built.path, built.appearance.page, built.appearance.rect);
        if (notice === EDIT_DECLINED) {
          setEditNotice({ text: tChrome('canvas.edit.cancelled'), error: false });
        } else if (typeof notice === 'string') {
          setEditNotice({ text: notice, error: false });
        }
      } catch (err) {
        setEditNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        addImageRef.current = false;
        setEditBusy(false);
      }
    },
    [docs, state.files, onAddImage, editBusy],
  );

  // --- Snapping: per-page geometry + the live preferences -------------------
  // The preferences are a MODULE store, not reducer state: `View ▸ Snapping`
  // is a registered command whose `run` has no access to this view, and a
  // persisted preference is not workspace state. One owner, three readers
  // (menu command, status bar, canvas).
  const snapSettings = useSyncExternalStore(subscribeSnapSettings, getSnapSettings, getSnapSettings);

  // --- Count & takeoff: the group list the strip offers ---------------------
  // The DOCUMENT's own groups (derived from its marks) merged with the
  // remembered ones — resolved here because this is the component that holds
  // the document; the page cell and the panel each derive what they need.
  const takeoffSettings = useSyncExternalStore(
    subscribeTakeoffSettings,
    getTakeoffSettings,
    getTakeoffSettings,
  );
  const countGroups = useMemo<CountGroup[]>(() => {
    const marks = (focusedDoc?.pages ?? []).flatMap((p) => countMarksOf(p.annotations));
    return mergeGroups(derivedGroups(marks), takeoffSettings.groups);
  }, [focusedDoc, takeoffSettings.groups]);
  // Keep the REMEMBERED definition of the armed group in step with the file's.
  // The file is the authority on how its own group looks (`mergeGroups`), so
  // without this a group learned from one drawing could place its next mark in
  // a different colour on another page — one group drawn two ways.
  useEffect(() => {
    const name = takeoffSettings.armed;
    if (!name) return;
    const fromFile = countGroups.find((g) => g.name === name);
    if (!fromFile) return;
    const remembered = takeoffSettings.groups.find((g) => g.name === name);
    if (remembered && remembered.color === fromFile.color && remembered.symbol === fromFile.symbol)
      return;
    rememberGroup(fromFile);
  }, [countGroups, takeoffSettings.armed, takeoffSettings.groups]);
  const [snapGeomByPage, setSnapGeomByPage] =
    useState<ReadonlyMap<string, PageSnapGeometry>>(NO_SNAP_GEOM);
  const snapGeomRef = useRef(snapGeomByPage);
  snapGeomRef.current = snapGeomByPage;
  const liveGuidesRef = useRef(liveGuides);
  liveGuidesRef.current = liveGuides;
  const snapFetchTokenRef = useRef(0);
  // Which canvas modes get PAGE geometry fetched. Freehand (ink/eraser) is
  // excluded because it passes `snap:false` at the choke point anyway, and
  // the modes with no page gesture at all (hand, forms, edit, the panels'
  // own modes) have nothing to snap.
  const snapConsumingTool =
    tool === 'measuredist' ||
    tool === 'measureperim' ||
    tool === 'measurearea' ||
    tool === 'measurecal' ||
    tool === 'shape' ||
    tool === 'callout' ||
    tool === 'freetext' ||
    tool === 'highlight' ||
    tool === 'note' ||
    tool === 'stamp' ||
    tool === 'redact' ||
    tool === 'signature' ||
    tool === 'formfields' ||
    tool === 'cropdraw' ||
    tool === 'beaddraw' ||
    tool === 'addtext' ||
    tool === 'addimage' ||
    // A count mark is a PLACEMENT, so it snaps like every other
    // one — landing a door count on the door's own corner is the whole point
    // of counting on a drawing rather than near it.
    tool === 'count' ||
    tool === 'select';
  const snapBuffer = focusedDoc ? state.files.get(focusedDoc.path)?.buffer : undefined;
  useEffect(() => {
    const token = ++snapFetchTokenRef.current;
    // The id-holder rule (the spec-99 discipline, same as the edit
    // listings): these maps are keyed by GENERATION-TAGGED page ids, and a
    // whole-file op rebuilds the file, so `docs` rotates to a fresh
    // generation one render before this can publish anything. Prune to what
    // still exists SYNCHRONOUSLY, before the first await — a dead id must
    // never be offered to a gesture.
    if (focusedDoc) {
      const liveIds = new Set(focusedDoc.pages.map((p) => p.id));
      setSnapGeomByPage((prev) => {
        let stale = false;
        for (const k of prev.keys()) {
          if (!liveIds.has(k)) {
            stale = true;
            break;
          }
        }
        if (!stale) return prev; // identity preserved → React bails out
        const next = new Map<string, PageSnapGeometry>();
        for (const [k, v] of prev) if (liveIds.has(k)) next.set(k, v);
        return next;
      });
    }
    if (
      !snapSettings.enabled ||
      !snapConsumingTool ||
      !focusedDoc ||
      !snapBuffer ||
      docViewMode !== 'document'
    ) {
      setSnapGeomByPage(NO_SNAP_GEOM);
      return;
    }
    const doc = focusedDoc;
    // Bounded by the READING POSITION rather than by the virtualizer's
    // mounted window: the window lives inside DocumentView and lifting it
    // would restructure the virtualizer for no gain here. ±2 pages around the
    // current page is the same order of magnitude and follows the reader,
    // which is what actually bounds the payload on a 60-sheet set.
    const centre = Math.max(0, currentPage - 1);
    const from = Math.max(0, centre - SNAP_PAGE_WINDOW);
    const to = Math.min(doc.pages.length - 1, centre + SNAP_PAGE_WINDOW);
    const run = async (): Promise<void> => {
      const validIds = new Set(doc.pages.map((p) => p.id));
      const next = new Map<string, PageSnapGeometry>();
      for (const [k, v] of snapGeomRef.current) if (validIds.has(k)) next.set(k, v);
      for (let i = from; i <= to; i++) {
        const page = doc.pages[i];
        if (!page) continue;
        if (snapFetchTokenRef.current !== token) return;
        if (next.has(page.id)) continue; // cached by page id (buffer identity is a dep)
        // Addressed like the RASTER, not like a whole-file op: the SOURCE
        // file at `sourcePageIndex`, which is exactly the page pdf.js draws.
        // That is what makes this read correct with NO commit gate — a
        // pending reorder cannot mis-address it (the physical page never
        // moves) and a pending rotation is applied by the same projection the
        // raster gets. Gating instead would flush the user's pending
        // annotations to disk on every workspace change. `list_page_geometry`
        // is an internal method because it must bypass that commit path.
        const srcFile = state.files.get(page.sourceDocId);
        if (!srcFile?.buffer) continue;
        try {
          const proxy = await getDocumentProxy(page.sourceDocId, srcFile.buffer);
          if (snapFetchTokenRef.current !== token) return;
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          const geometry = {
            box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
            bakedRotate: p.rotate,
          };
          const listing = await fetchSnapGeometry(
            (m, params) => engineCall(m, params),
            srcFile.workingPath,
            page.sourcePageIndex + 1,
            geometry,
          );
          if (snapFetchTokenRef.current !== token) return;
          next.set(page.id, listing);
          setSnapGeomByPage(new Map(next)); // incremental fill
        } catch {
          // A page whose geometry can't be listed simply offers no page
          // candidates; markup snapping still works there.
        }
      }
    };
    void run();
  }, [
    snapSettings.enabled,
    snapConsumingTool,
    focusedDoc,
    snapBuffer,
    docViewMode,
    currentPage,
    docs,
    state.files,
    engineCall,
  ]);

  // Harness bridge for Edit ▸ Images + Text — refs pattern.
  const editImagesRef = useRef(editImagesByPage);
  editImagesRef.current = editImagesByPage;
  const editVectorsRef = useRef(editVectorsByPage);
  editVectorsRef.current = editVectorsByPage;
  const selectedVectorRef = useRef(selectedVector);
  selectedVectorRef.current = selectedVector;
  const handleDeleteVectorRef = useRef(handleDeleteVector);
  handleDeleteVectorRef.current = handleDeleteVector;
  const commitVectorTransformRef = useRef(commitVectorTransform);
  commitVectorTransformRef.current = commitVectorTransform;
  const commitVectorRestyleRef = useRef(commitVectorRestyle);
  commitVectorRestyleRef.current = commitVectorRestyle;
  const editTextRef = useRef(editTextByPage);
  editTextRef.current = editTextByPage;
  const editSelRef = useRef(editSel);
  editSelRef.current = editSel;
  const runEditActionRef = useRef(runEditAction);
  runEditActionRef.current = runEditAction;
  const openTextEditorRef = useRef(handleOpenTextEditor);
  openTextEditorRef.current = handleOpenTextEditor;
  const openParagraphEditorRef = useRef(handleOpenParagraphEditor);
  openParagraphEditorRef.current = handleOpenParagraphEditor;
  const commitAddTextRef = useRef(commitAddText);
  commitAddTextRef.current = commitAddText;
  const commitImageTransformRef = useRef(commitImageTransform);
  commitImageTransformRef.current = commitImageTransform;
  const commitImageGroupTransformRef = useRef(commitImageGroupTransform);
  commitImageGroupTransformRef.current = commitImageGroupTransform;
  const onAddImageRef = useRef(onAddImage);
  onAddImageRef.current = onAddImage;
  const focusedDocPathRef = useRef<string | null>(focusedDoc?.path ?? null);
  focusedDocPathRef.current = focusedDoc?.path ?? null;
  // Place an Add-Text box on the active file's first page (the band lives in
  // transformed canvas space, undrivable by WebDriver — the new-field harness
  // precedent).
  const harnessPlaceAddTextRef = useRef<
    (rect: { x: number; y: number; w: number; h: number }) => boolean
  >(() => false);
  harnessPlaceAddTextRef.current = (rect) => {
    const doc = docs.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    if (!doc || !page) return false;
    // Same currency rule as harnessPlaceFieldRef — the
    // harness polls this, so refusing while a reindex is in flight makes
    // place→commit atomic against the id rotation instead of arming a
    // doomed placement.
    if (!placementDocsCurrent(state.files, docs, doc.path)) return false;
    setAddTextPlacement({
      id: crypto.randomUUID(),
      path: doc.path,
      pageId: page.id,
      rect,
      rotationAtDraw: page.rotation,
    });
    return true;
  };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasEditImages({
      pageIds: () => [...editImagesRef.current.keys()],
      snapGeometryPageIds: () => [...snapGeomRef.current.keys()],
      snapGeometry: (pageId) =>
        (snapGeomRef.current.get(pageId)?.paths ?? []).map((p) => ({
          subpaths: p.subpaths.map((sp) => [...sp]),
          closed: [...p.closed],
        })),
      // Slice B: the live guide list, in the STORED frame. The e2e drag off a
      // ruler is real (the strips are ordinary chrome at known coordinates),
      // so this is a READ-back, not a placement shortcut — a spec that placed
      // guides through the harness would never exercise the gesture.
      guides: () =>
        liveGuidesRef.current.map((g) => ({
          id: g.id,
          pageId: g.pageId,
          axis: g.axis,
          pos: g.pos,
          rotationAtDraw: g.rotationAtDraw,
        })),
      // False while a listing pass is in flight. An empty listing is BOTH
      // "no images here" and "the fresh listing hasn't landed yet", so a
      // spec asserting on emptiness alone can pass over a no-op.
      listingSettled: () => editListingPendingRef.current === 0,
      placements: (pageId) =>
        (editImagesRef.current.get(pageId) ?? []).map((p) => ({
          index: p.index,
          nested: p.nested,
          matrix: [...p.matrix],
          opacity: p.opacity,
          blend: p.blend,
          mask: p.mask ? { ...p.mask, from: [...p.mask.from] as [number, number], to: [...p.mask.to] as [number, number] } : null,
          kind: p.kind,
          crop: p.crop ? [...p.crop] : null,
        })),
      transformImage: (pageId, index, matrix) =>
        commitImageTransformRef.current(pageId, index, matrix),
      transformImages: (pageId, targets) =>
        commitImageGroupTransformRef.current(pageId, targets),
      addImage: async (page, rect, source, at) => {
        const path = focusedDocPathRef.current;
        if (!path) throw new Error('addImage: no active document');
        await onAddImageRef.current(path, page, rect, source, at);
      },
      select: (pageId, index, additive) => {
        imageReselectRef.current = null; // harness picks are user picks
        // Deliberately NON-toggling (unlike the click handler): harness
        // re-selects must be idempotent — specs select the same placement
        // repeatedly across commits. `additive` grows the group.
        setEditSel((prev) => {
          if (additive && prev?.kind === 'image' && prev.pageId === pageId) {
            return prev.indexes.includes(index)
              ? prev
              : { kind: 'image', pageId, index, indexes: [...prev.indexes, index] };
          }
          return { kind: 'image', pageId, index, indexes: [index] };
        });
      },
      selection: () => editSelRef.current,
      deleteSelected: () => runEditActionRef.current('delete'),
      textPageIds: () => [...editTextRef.current.keys()],
      textRuns: (pageId) =>
        (editTextRef.current.get(pageId)?.runBoxes ?? []).map((r) => ({
          index: r.index,
          text: r.text,
          editable: r.editable,
          reason: r.reason,
        })),
      openTextEditor: (pageId, index) => openTextEditorRef.current(pageId, index),
      paragraphs: (pageId) =>
        (editTextRef.current.get(pageId)?.paragraphs ?? []).map((p) => ({
          index: p.index,
          text: p.text,
          lineCount: p.lineCount,
          alignment: p.alignment,
          vertical: p.vertical,
          // The frame the paragraph's layout ran in, so a spec can
          // assert a rotated block LISTS as one rather than inferring it
          // from geometry.
          orientation: p.orientation,
          // The distinct per-span colours (seed hexes) — an e2e can
          // assert a recoloured range survives the round-trip.
          colors: Array.from(
            new Set(p.spans.map((sp) => sp.color).filter((c): c is string => !!c)),
          ),
          // The distinct member-run font sizes.
          sizes: p.runSizes,
        })),
      openParagraphEditor: (pageId, index) => openParagraphEditorRef.current(pageId, index),
      act: (kind, opts) => runEditActionRef.current(kind, opts),
      placeAddText: (rect) => harnessPlaceAddTextRef.current(rect),
      commitAddText: (params) => commitAddTextRef.current(params),
      // Vector objects.
      vectorPageIds: () => [...editVectorsRef.current.keys()],
      vectors: (pageId) =>
        (editVectorsRef.current.get(pageId) ?? []).map((v) => ({
          index: v.index,
          kind: v.kind,
          fill: v.fill ? [...v.fill] : null,
          stroke: v.stroke ? [...v.stroke] : null,
          lineWidth: v.lineWidth,
          nested: v.nested,
          userRect: [...v.userRect] as [number, number, number, number],
        })),
      selectVector: (pageId, index) => setSelectedVector({ pageId, index }),
      selectedVector: () => selectedVectorRef.current,
      deleteSelectedVector: () => handleDeleteVectorRef.current(),
      transformVector: (pageId, index, matrix) =>
        commitVectorTransformRef.current(pageId, index, matrix),
      restyleVector: (pageId, index, opts) =>
        commitVectorRestyleRef.current(pageId, index, opts),
    });
    return () => registerCanvasEditImages(null);
  }, []);

  // Harness bridge for on-canvas forms: the overlay inputs live
  // inside transformed canvas space (flaky to drive via WebDriver), so the
  // canvas registers value-setting + apply against the REAL pending-map and
  // fill paths. Refs keep the registration stable across renders.
  const workspaceFormsRef = useRef(workspaceForms);
  workspaceFormsRef.current = workspaceForms;
  const pendingFormValuesRef = useRef(pendingFormValues);
  pendingFormValuesRef.current = pendingFormValues;
  const formDisplayValuesRef = useRef(formDisplayValues);
  formDisplayValuesRef.current = formDisplayValues;
  const applyFormValuesRef = useRef(applyFormValues);
  applyFormValuesRef.current = applyFormValues;
  const setFormValueRef = useRef(onSetFormValue);
  setFormValueRef.current = onSetFormValue;
  const createFieldRef = useRef(createFieldFromPlacement);
  createFieldRef.current = createFieldFromPlacement;
  const harnessPlaceFieldRef = useRef<
    (rect: { x: number; y: number; w: number; h: number }) => boolean
  >(() => false);
  harnessPlaceFieldRef.current = (rect) => {
    const doc = docs.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    if (!doc || !page) return false;
    // Same currency rule as onSetNewFieldRect — the harness polls this, so
    // refusing while a reindex is in flight makes place→create atomic
    // against the id rotation instead of arming a doomed placement.
    if (!placementDocsCurrent(state.files, docs, doc.path)) return false;
    setNewFieldPlacement({
      id: crypto.randomUUID(),
      path: doc.path,
      pageId: page.id,
      rect,
      rotationAtDraw: page.rotation,
    });
    return true;
  };
  // Sign-into-field for the harness: the same engine call the sign
  // card's field branch makes, with the native save dialog's output injected.
  const harnessSignFieldRef = useRef<
    (params: {
      fieldName: string;
      pfxPath?: string;
      keyPath?: string;
      certPath?: string;
      password: string;
      output: string;
      reason?: string;
      location?: string;
    }) => Promise<{ signer: string | null; output: string; valid: boolean; intact: boolean; covers_whole_document: boolean }>
  >(async () => {
    throw new Error('canvas not ready');
  });
  harnessSignFieldRef.current = async (params) => {
    const path = state.activeFileId;
    const f = path ? state.files.get(path) : undefined;
    if (!path || !f) throw new Error('signCanvasField: no active file');
    if (state.pageDirtyPaths.includes(path)) {
      throw new Error('signCanvasField: apply pending page changes first');
    }
    return (await engineCall('sign_pdf', {
      file: f.workingPath,
      output: params.output,
      ...(params.pfxPath ? { pfx_path: params.pfxPath } : {}),
      ...(params.keyPath ? { key_path: params.keyPath } : {}),
      ...(params.certPath ? { cert_path: params.certPath } : {}),
      password: params.password,
      ...(params.reason ? { reason: params.reason } : {}),
      ...(params.location ? { location: params.location } : {}),
      existing_field: params.fieldName,
    })) as unknown as { signer: string | null; output: string; valid: boolean; intact: boolean; covers_whole_document: boolean };
  };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasForms({
      setFieldValue: (path, fieldName, value) => {
        // Mirror exactly what the overlay controls can produce (review note:
        // a looser harness could "pass" scenarios no real user can trigger):
        // right shape for the type, and choice values within the options.
        const info = workspaceFormsRef.current.get(path);
        const field = info?.fields.find((f) => f.name === fieldName);
        if (!field || !field.editable) return false;
        if (!valueShapeMatches(field.type, value)) return false;
        if (
          (field.type === 'radio' || field.type === 'dropdown') &&
          typeof value === 'string' &&
          value !== '' &&
          !(field.options ?? []).includes(value)
        ) {
          return false;
        }
        if (
          field.type === 'optionlist' &&
          Array.isArray(value) &&
          !value.every((v) => (field.options ?? []).includes(v))
        ) {
          return false;
        }
        setFormValueRef.current(path, fieldName, value);
        return true;
      },
      pendingCount: () => {
        let n = 0;
        for (const [, values] of pendingFormValuesRef.current) n += values.size;
        return n;
      },
      apply: () => applyFormValuesRef.current(),
      shownValueFor: (path, fieldName) => {
        const value = formDisplayValuesRef.current.get(path)?.get(fieldName);
        if (typeof value !== 'string') return null;
        const field = workspaceFormsRef.current.get(path)?.fields.find((f) => f.name === fieldName);
        return shownValue(field ? formatScriptOf(field) : undefined, value);
      },
      scriptsNotRunFor: (path) =>
        (workspaceFormsRef.current.get(path)?.fields ?? [])
          .filter((f) => f.scriptsNotRun?.length)
          .map((f) => f.name),
      widgetCountFor: (path) => {
        const info = workspaceFormsRef.current.get(path);
        if (!info) return 0;
        let n = 0;
        for (const [, arr] of info.widgetsByPage) n += arr.length;
        return n;
      },
      placeNewFieldOnFirstPage: (rect) => harnessPlaceFieldRef.current(rect),
      createPlacedField: (params) => createFieldRef.current(params),
      signField: (params) => harnessSignFieldRef.current(params),
    });
    return () => registerCanvasForms(null);
  }, []);

  // Harness bridge (e2e): drive OCR-apply without depending on the FindBar
  // button's async-gated visibility (same pattern as redaction/signature).
  const applyOcrRef = useRef(handleApplyOcr);
  applyOcrRef.current = handleApplyOcr;
  const ocrReadyCountRef = useRef(0);
  ocrReadyCountRef.current = ocrReady.length;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasOcr({
      readyCount: () => ocrReadyCountRef.current,
      apply: () => applyOcrRef.current(),
    });
    return () => registerCanvasOcr(null);
  }, []);

  // Convert every live mark into engine regions and redact file by file.
  // Geometry (crop-intersected box + baked /Rotate) is read from the CURRENT
  // buffer's pdf.js proxy — the same bytes the marks were drawn against; the
  // commit gate then materializes pending page edits before the engine reads
  // the file, so workspace page numbers and composed rotations line up with
  // what lands on disk. Resolves with per-file failure messages (empty =
  // success) — the confirm button surfaces them in the error banner, the test
  // harness rethrows them.
  // Ref, not just state: two clicks in the same tick both read a stale
  // `redacting === false` (same failure mode as the commit-race double-click,
  // the same reentrancy class).
  // Selection -> link regions. Geometry comes from the CURRENT buffer's proxy
  // (the same contract as applyMarks), and the engine call is commit-gated, so
  // the page numbers and user space line up with what lands on disk.
  const createLinks = useCallback(
    async (selection: PageQuads[], url: string): Promise<void> => {
      const { files: payloads, skippedPageIds } = await buildLinkPayloads(
        docs,
        selection,
        url,
        async (page) => {
          const f = state.files.get(page.sourceDocId);
          if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
          const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          return {
            box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
            bakedRotate: p.rotate,
          };
        },
      );
      if (payloads.length === 0) {
        throw new Error(
          tChrome(
            skippedPageIds.length > 0
              ? 'canvas.link.pagesGone'
              : 'canvas.link.nothingSelected',
          ),
        );
      }
      for (const payload of payloads) await onAddLinks(payload.path, payload.links);
    },
    [docs, state.files, onAddLinks],
  );

  const applyingRef = useRef(false);
  const applyMarks = useCallback(async (): Promise<string[]> => {
    const toApply = liveMarks;
    if (toApply.length === 0 || applyingRef.current) return [];
    applyingRef.current = true;
    setRedacting(true);
    setRedactError(null);
    try {
      const { files: payloads } = await buildRedactionRegions(docs, toApply, async (page) => {
        const f = state.files.get(page.sourceDocId);
        if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
        const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
        const p = await proxy.getPage(page.sourcePageIndex + 1);
        const [vx0, vy0, vx1, vy1] = p.view;
        return {
          box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
          bakedRotate: p.rotate,
        };
      });
      const failures: string[] = [];
      for (const payload of payloads) {
        try {
          if (await onRedactFile(payload.path, payload.regions)) {
            const applied = new Set(payload.markIds);
            setMarks((prev) => prev.filter((m) => !applied.has(m.id)));
          }
        } catch (err) {
          const name = payload.path.split(/[\\/]/).pop() || payload.path;
          failures.push(
            tChrome('canvas.common.fileFailure', {
              name,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
      if (failures.length > 0) {
        setRedactError(tChrome('canvas.redact.failed', { reasons: failures.join('; ') }));
      }
      return failures;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRedactError(tChrome('canvas.redact.failedSingle', { reasons: msg }));
      return [msg];
    } finally {
      applyingRef.current = false;
      setRedacting(false);
    }
  }, [liveMarks, docs, state.files, onRedactFile]);

  // Persist the marks into the file(s) as /Redact annotations — the
  // SAME geometry pipeline as apply, so save and apply cannot disagree
  // about where a mark sits. The reload each op triggers clears the
  // transient marks and the re-seed loads them straight back from the
  // file: after a save, what you see IS what the file says.
  const savingRef = useRef(false);
  const [savingMarks, setSavingMarks] = useState(false);
  // Every path that has carried a mark in this view's lifetime — the
  // clear-set for save-as-replace (deleting a file's last mark and saving
  // must clear its STORED set too).
  const markPathsEverRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const m of marks) markPathsEverRef.current.add(m.path);
  }, [marks]);
  const saveMarks = useCallback(async (): Promise<string[]> => {
    const toSave = liveMarks;
    if (savingRef.current) return [];
    savingRef.current = true;
    setSavingMarks(true);
    setRedactError(null);
    try {
      const { files: payloads } = await buildRedactionRegions(docs, toSave, async (page) => {
        const f = state.files.get(page.sourceDocId);
        if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
        const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
        const p = await proxy.getPage(page.sourcePageIndex + 1);
        const [vx0, vy0, vx1, vy1] = p.view;
        return {
          box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
          bakedRotate: p.rotate,
        };
      });
      // Save is a REPLACE, and "no marks" is a set: a file whose marks
      // (drawn or seeded) were all deleted this view lifetime gets its
      // stored set cleared — markPathsEverRef remembers which files those
      // are; files never marked stay untouched.
      const marked = new Set(payloads.map((p) => p.path));
      const failures: string[] = [];
      for (const payload of payloads) {
        try {
          await onSaveRedactionMarks(payload.path, payload.regions);
        } catch (err) {
          const name = payload.path.split(/[\\/]/).pop() || payload.path;
          failures.push(
            tChrome('canvas.common.fileFailure', {
              name,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
      for (const path of [...markPathsEverRef.current]) {
        if (marked.has(path)) continue;
        if (!state.files.has(path)) continue; // closed — nothing to clear
        try {
          await onSaveRedactionMarks(path, []);
        } catch {
          // clearing an already-clear file is best-effort
        }
      }
      if (failures.length > 0) {
        setRedactError(tChrome('canvas.redact.saveMarksFailed', { reasons: failures.join('; ') }));
      }
      return failures;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRedactError(tChrome('canvas.redact.saveMarksFailed', { reasons: msg }));
      return [msg];
    } finally {
      savingRef.current = false;
      setSavingMarks(false);
    }
  }, [liveMarks, docs, state.files, onSaveRedactionMarks]);

  // ── the Search & Redact panel's seam ─────────────────────────────────────
  //
  // The panel is a PRODUCER OF MARKS and nothing else — it never calls
  // `redact`, and the status bar's apply / save marks / clear stays the only
  // destructive path. What crosses this seam is page-space `{page, rect}`,
  // the payload shape `list_redact_annotations` returns and
  // `save_redaction_marks` takes, converted here by `marksFromFileRects` —
  // the seed's own conversion, so there is exactly one of it.
  const geometryForPage = useCallback(
    async (page: PageRef): Promise<PageGeometry> => {
      const f = filesRef.current.get(page.sourceDocId);
      if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
      const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
      const p = await proxy.getPage(page.sourcePageIndex + 1);
      const [vx0, vy0, vx1, vy1] = p.view;
      return {
        box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 },
        bakedRotate: p.rotate,
      };
    },
    [],
  );

  const markedRects = useCallback(async () => {
    // buildRedactionRegions, not a second conversion: what the panel compares
    // a fresh hit against must be exactly what an apply would send.
    const { files: payloads } = await buildRedactionRegions(
      docsRef.current,
      liveMarksRef.current,
      geometryForPage,
    );
    return payloads.flatMap((payload) =>
      payload.regions.map((region) => ({
        path: payload.path,
        page: region.page,
        rect: region.rect,
      })),
    );
  }, [geometryForPage]);

  const addMarksFromRects = useCallback(
    async (
      requests: { path: string; page: number; rect: [number, number, number, number] }[],
    ) => {
      // Dedupe against what is already pending AND within this batch: two
      // patterns can name the same characters on one page, and clicking
      // "Mark checked" twice must not stack marks the user then has to
      // delete twice.
      const existing = await markedRects();
      // The panel's marks take the properties the user is
      // currently working with, exactly as a hand-drawn band does. Merged in
      // as the engine PAYLOAD so both producers travel the one conversion
      // (`marksFromFileRects`) rather than two.
      const current = propertiesPayload(loadRedactionProperties());
      const byPath = new Map<
        string,
        (Record<string, unknown> & { page: number; rect: [number, number, number, number] })[]
      >();
      let duplicates = 0;
      for (const request of requests) {
        const pending = byPath.get(request.path) ?? [];
        const already =
          existing.some(
            (mark) =>
              mark.path === request.path &&
              mark.page === request.page &&
              sameRegion(mark.rect, request.rect),
          ) ||
          pending.some(
            (entry) => entry.page === request.page && sameRegion(entry.rect, request.rect),
          );
        if (already) {
          duplicates += 1;
          continue;
        }
        pending.push({ page: request.page, rect: request.rect, ...current });
        byPath.set(request.path, pending);
      }
      const fresh: RedactionMark[] = [];
      let skipped = 0;
      for (const [path, entries] of byPath) {
        const { marks: made, orphaned } = await marksFromFileRects(path, entries);
        fresh.push(...made);
        skipped += orphaned;
      }
      if (fresh.length > 0) setMarks((prev) => [...prev, ...fresh]);
      return { added: fresh.length, duplicates, skipped };
    },
    [markedRects, marksFromFileRects],
  );

  const searchOcrPage = useCallback(
    async (
      path: string,
      page: number,
      query: string,
      options: SearchOptions,
    ): Promise<{ text: string; rect: [number, number, number, number] }[]> => {
      // The SECOND rect authority: an image-only page has no text
      // runs for the engine to slice, but the in-app index already recognised
      // it and holds word boxes. They convert to page space through the same
      // machinery "Make searchable" uses, so a scanned page's marks and an
      // OCR layer's words land in the same coordinates.
      const pages = docsRef.current.filter((d) => d.path === path).flatMap((d) => d.pages);
      const pageRef = pages[page - 1];
      if (!pageRef) return [];
      const words = searchIndexRef.current.getOcrWords(sourceKeyOf(pageRef));
      if (!words || words.length === 0) return [];
      const matched = highlightWords(words, query, options);
      if (matched.length === 0) return [];
      const geometry = await geometryForPage(pageRef);
      return matched.map((word) => ({
        text: word.text,
        rect: displayRectToPdf(word, geometry.box, geometry.bakedRotate),
      }));
    },
    [geometryForPage],
  );

  // Listeners so the panel's already-marked state stays live while the user
  // also draws bands by hand — the panel cannot poll, and a stale disabled
  // checkbox on a destructive tool is a checkbox that lies.
  useEffect(() => {
    for (const listener of [...markSubscribersRef.current]) listener();
  }, [marks]);

  redactionServiceRef.current = { addMarksFromRects, markedRects, searchOcrPage };

  // ── Detected field candidates ─────────────────────────────────────────
  // The panel owns the review; the canvas owns the geometry. What crosses the
  // seam is the detection payload in and page-space specs out — the same
  // division the redaction seam draws, and for the same reason: converting a
  // page-space rect into a cell rect needs the pdf.js proxies and the PageRef
  // rotations, and there is exactly one place that has both.
  const publishCandidates = useCallback(
    async (path: string, result: DetectionResult): Promise<{ shown: number; skipped: number }> => {
      const doc = docsRef.current.find((d) => d.path === path);
      if (!doc) return { shown: 0, skipped: result.candidates.length };
      const geometry = new Map<number, PageGeometry>();
      for (const page of new Set(result.candidates.map((c) => c.page))) {
        const pageRef = doc.pages[page - 1];
        if (!pageRef) continue;
        geometry.set(page, await geometryForPage(pageRef));
      }
      const { candidates, skipped } = candidatesFromDetection(
        result,
        path,
        (row) => {
          const pageRef = doc.pages[row.page - 1];
          const geo = geometry.get(row.page);
          if (!pageRef || !geo) return null;
          return {
            pageId: pageRef.id,
            // Detection reasons in unrotated user space; the projection is
            // where the page's baked /Rotate and its pending delta apply.
            rect: pdfRectToDisplay(
              row.rect,
              geo.box,
              geo.bakedRotate + (pageRef.rotation ?? 0),
            ),
            rotationAtDraw: ((((pageRef.rotation ?? 0) % 360) + 360) % 360) as 0 | 90 | 180 | 270,
          };
        },
        () => crypto.randomUUID(),
      );
      setFieldCandidates(candidates);
      setSelectedCandidateId(null);
      return { shown: candidates.length, skipped };
    },
    [geometryForPage],
  );

  const acceptCandidates = useCallback(
    async (ids: readonly string[]): Promise<{ created: number; skipped: number }> => {
      const wanted = new Set(ids);
      const chosen = liveCandidatesRef.current.filter((c) => wanted.has(c.id));
      if (chosen.length === 0) return { created: 0, skipped: 0 };
      const path = chosen[0].path;
      const doc = docsRef.current.find((d) => d.path === path);
      if (!doc) return { created: 0, skipped: chosen.length };
      const resolved = [];
      let skipped = 0;
      for (const candidate of chosen) {
        const pageIndex = doc.pages.findIndex((p) => p.id === candidate.pageId);
        if (pageIndex < 0) {
          skipped += 1;
          continue;
        }
        const geo = await geometryForPage(doc.pages[pageIndex]);
        resolved.push({
          candidate,
          pageIndex,
          // The rect is converted at the orientation it was DETECTED in: a
          // later in-memory rotation moves the projection, never user space.
          rect: displayRectToPdf(
            candidate.rect,
            geo.box,
            geo.bakedRotate + candidate.rotationAtDraw,
          ),
        });
      }
      if (resolved.length === 0) return { created: 0, skipped };
      // Top-level names only: a detected name collides with a field ROOT, and
      // a hierarchy child's leaf name is not a top-level sibling.
      const existing = new Set(
        (workspaceForms.get(path)?.fields ?? []).map((f) => f.name.split('.')[0]),
      );
      const specs = buildFieldSpecs(resolved, existing);
      await onAddFormFields(path, specs);
      return { created: specs.length, skipped };
    },
    [geometryForPage, workspaceForms, onAddFormFields],
  );

  candidateServiceRef.current = {
    publish: publishCandidates,
    accept: acceptCandidates,
    update: (next) => setFieldCandidates([...next]),
    clear: () => {
      setFieldCandidates(NO_CANDIDATES);
      setSelectedCandidateId(null);
    },
    focus: (candidateId) => {
      const target = liveCandidatesRef.current.find((c) => c.id === candidateId);
      if (!target) return;
      setSelectedCandidateId(candidateId);
      jumpToPageRef.current(target.pageId);
    },
  };

  useEffect(() => {
    for (const listener of [...candidateSubscribersRef.current]) listener();
  }, [fieldCandidates]);

  // ── Detected tables ───────────────────────────────────────────────────
  // The candidate seam again, one step safer: the panel owns the review, the
  // canvas owns the geometry, and the accept side writes no document at all —
  // it hands the reviewed bounds to the spreadsheet export and nothing else.
  const publishTables = useCallback(
    async (path: string, result: TableDetectionResult): Promise<{ shown: number; skipped: number }> => {
      const doc = docsRef.current.find((d) => d.path === path);
      if (!doc) return { shown: 0, skipped: result.regions.length };
      const geometry = new Map<number, PageGeometry>();
      for (const page of new Set(result.regions.map((r) => r.page))) {
        const pageRef = doc.pages[page - 1];
        if (!pageRef) continue;
        geometry.set(page, await geometryForPage(pageRef));
      }
      const { regions, skipped } = regionsFromDetection(
        result,
        path,
        (row) => {
          const pageRef = doc.pages[row.page - 1];
          const geo = geometry.get(row.page);
          if (!pageRef || !geo) return null;
          const delta = quarter(pageRef.rotation ?? 0);
          return {
            pageId: pageRef.id,
            // Detection reasons in unrotated user space; the projection is
            // where the page's baked /Rotate and its pending delta apply.
            rect: pdfRectToDisplay(row.bounds, geo.box, geo.bakedRotate + delta),
            rotationAtDraw: delta,
            totalRotationAtDraw: quarter(geo.bakedRotate + delta),
          };
        },
        () => crypto.randomUUID(),
      );
      setTableRegions(regions);
      setSelectedTableId(null);
      return { shown: regions.length, skipped };
    },
    [geometryForPage],
  );

  const exportReviewedTables = useCallback(
    async (
      output: string,
      options: { sheetPer: string; includeUntabled: boolean },
    ): Promise<ExportDocumentResult> => {
      const chosen = acceptedRegions(liveTableRegionsRef.current);
      if (chosen.length === 0) throw new Error(tChrome('panel.tableReview.nothingAccepted'));
      const path = chosen[0].path;
      const doc = docsRef.current.find((d) => d.path === path);
      if (!doc) throw new Error(tChrome('panel.tableReview.documentGone'));
      const geometry = new Map<string, { index: number; geo: PageGeometry }>();
      for (const region of chosen) {
        if (geometry.has(region.pageId)) continue;
        const index = doc.pages.findIndex((p) => p.id === region.pageId);
        if (index < 0) continue;
        geometry.set(region.pageId, { index, geo: await geometryForPage(doc.pages[index]) });
      }
      const { regions, skipped } = exportRegions(chosen, (region) => {
        const placed = geometry.get(region.pageId);
        if (!placed) return null;
        return {
          // The engine addresses the file's own page order, and a reviewed
          // table's page is where its bytes are, not where it sits on the board.
          page: doc.pages[placed.index].sourcePageIndex + 1,
          bounds: displayRectToPdf(
            region.rect,
            placed.geo.box,
            placed.geo.bakedRotate + region.rotationAtDraw,
          ),
        };
      });
      // A table whose page has gone is not silently left out of a workbook the
      // reviewer believes carries it.
      if (skipped > 0) throw new Error(tChrome('panel.tableReview.pagesGone'));
      return (await engineCall('export_document', {
        file: path,
        output,
        fmt: 'xlsx',
        sheet_per: options.sheetPer,
        ...(options.includeUntabled ? { include_untabled: true } : {}),
        regions,
      })) as unknown as ExportDocumentResult;
    },
    [engineCall, geometryForPage],
  );

  tableServiceRef.current = {
    publish: publishTables,
    update: (next) => setTableRegions([...next]),
    clear: () => {
      setTableRegions(NO_TABLES);
      setSelectedTableId(null);
    },
    focus: (regionId) => {
      const target = liveTableRegionsRef.current.find((r) => r.id === regionId);
      if (!target) return;
      setSelectedTableId(regionId);
      jumpToPageRef.current(target.pageId);
    },
    exportTo: exportReviewedTables,
  };

  useEffect(() => {
    for (const listener of [...tableSubscribersRef.current]) listener();
  }, [tableRegions]);

  // Sign the placement's file (visible stamp at the drawn box) or fill the
  // targeted existing empty signature field (the field's own widget
  // rect is the stamp box). Geometry for a placement is read from the
  // CURRENT buffer's proxy (same contract as applyMarks); the engine gate
  // then flushes pending page edits before sign_pdf reads the file, so the
  // output contains what the user sees. The input file itself is NEVER
  // modified — signing writes a new file.
  const signingRef = useRef(false);
  const applySignature = useCallback(async (): Promise<void> => {
    const placement = liveSigPlacement;
    const fieldTarget = sigFieldTarget;
    if ((!placement && !fieldTarget) || signingRef.current) return;
    // Synchronous validation only above this line. The reentrancy ref MUST be
    // taken before the FIRST await (regression; same double-click class as
    // the applyMarks reentrancy class) — a second click during
    // buildSignatureAppearance or the native save dialog would otherwise
    // start an overlapping sign flow.
    const resolved = signerSourceParams(sigSource);
    if (resolved.error) {
      setSignError(resolved.error);
      return;
    }
    if (!sigPassword && sigSource.mode === 'pfx') {
      setSignError(tChrome('canvas.sign.enterPassword'));
      return;
    }
    if (fieldTarget && state.pageDirtyPaths.includes(fieldTarget.path)) {
      // The gate-commit inside sign_pdf could rename fields (a pending
      // import's name collision) out from under a name-only target.
      // Unlike the value fill — which re-resolves renames by fingerprint —
      // a signature is not silently re-appliable, so refuse until the page
      // edits are applied and the target re-clicked against the fresh read.
      setSignError(tChrome('canvas.sign.applyEditsFirst'));
      return;
    }
    if (placement && !placementDocsCurrent(state.files, docs, placement.path)) {
      // Same stale-docs rule as createFieldFromPlacement: a
      // placement whose docs were indexed from a superseded buffer converts
      // sourcePageIndex against ids that are about to rotate — the stamp
      // could land on the wrong page. The invalidation effect clears the
      // placement when the buffer change lands; this covers the in-flight
      // window where it hasn't yet. Loud, not silent — the card stays open.
      setSignError(tChrome('canvas.sign.pageChanged'));
      return;
    }
    signingRef.current = true;
    setSigningBusy(true);
    setSignError(null);
    try {
      let filePath: string;
      let placementParams: Record<string, unknown>;
      if (fieldTarget) {
        filePath = fieldTarget.path;
        placementParams = { existing_field: fieldTarget.fieldName };
      } else {
        const built = await buildSignatureAppearance(docs, placement!, async (page) => {
          const f = state.files.get(page.sourceDocId);
          if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
          const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
          const p = await proxy.getPage(page.sourcePageIndex + 1);
          const [vx0, vy0, vx1, vy1] = p.view;
          return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
        });
        if (!built) {
          setSignError(tChrome('canvas.sign.pageGone'));
          return;
        }
        filePath = built.path;
        placementParams = { appearance: built.appearance };
      }
      const file = state.files.get(filePath);
      if (!file) {
        setSignError(tChrome('canvas.sign.fileClosed'));
        return;
      }
      const baseName = (filePath.split(/[\\/]/).pop() ?? 'document').replace(/\.pdfx?$/i, '');
      const dest = await dialog.saveFile({ defaultPath: `${baseName}-signed.pdf` });
      if (!dest) return; // cancelled — the finally still clears the password
      const res = (await engineCall('sign_pdf', {
        file: file.workingPath,
        output: dest,
        ...resolved.params!,
        // A token source takes the password field as its PIN.
        ...(resolved.params!.pkcs11_module ? { pkcs11_pin: sigPassword } : { password: sigPassword }),
        ...(sigReason.trim() ? { reason: sigReason.trim() } : {}),
        ...(sigLocation.trim() ? { location: sigLocation.trim() } : {}),
        ...placementParams,
        ...certifyParams(sigCertify),
        ...lockParams(sigLock),
      })) as unknown as { signer: string | null; output: string; valid: boolean; intact: boolean; covers_whole_document: boolean };
      setSignDone({ signer: res.signer, output: res.output, ok: res.valid && res.intact && res.covers_whole_document });
      setSigPlacement(null);
      setSigFieldTarget(null);
      setTool('select');
    } catch (err) {
      setSignError(err instanceof Error ? err.message : String(err));
    } finally {
      // Clear the secret from state on EVERY exit — success, failure, or a
      // cancelled save dialog (regression: a cancel used to strand the
      // typed password in state, pre-filling later unrelated attempts).
      setSigPassword('');
      signingRef.current = false;
      setSigningBusy(false);
    }
  }, [liveSigPlacement, sigFieldTarget, sigSource, sigPassword, sigReason, sigLocation, sigCertify, sigLock, docs, state.files, state.pageDirtyPaths, engineCall, setTool]);

  // Harness bridge (e2e builds only): redaction marks live here, out of the
  // reducer's reach, so the canvas registers its own handlers while mounted.
  // Refs keep the registration stable across renders.
  const applyMarksRef = useRef(applyMarks);
  applyMarksRef.current = applyMarks;
  const saveMarksRef = useRef(saveMarks);
  saveMarksRef.current = saveMarks;
  const harnessAddMarkRef = useRef<
    (rect: { x: number; y: number; w: number; h: number }) => { markId: string; docId: string; pageId: string } | null
  >(() => null);
  harnessAddMarkRef.current = (rect) => {
    const doc = docs.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    if (!doc || !page) return null;
    const id = crypto.randomUUID();
    setMarks((prev) => [
      ...prev,
      { id, path: doc.path, pageId: page.id, rect, rotationAtDraw: page.rotation },
    ]);
    return { markId: id, docId: doc.id, pageId: page.id };
  };
  const liveMarksRef = useRef(liveMarks);
  liveMarksRef.current = liveMarks;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasRedaction({
      addMarkToFirstPage: (rect) => harnessAddMarkRef.current(rect),
      apply: () => applyMarksRef.current(),
      save: () => saveMarksRef.current(),
      clear: () => setMarks([]),
      count: () => liveMarksRef.current.length,
    });
    return () => registerCanvasRedaction(null);
  }, []);

  // Same bridge for the visible-signature placement (rubber band + native
  // dialogs aren't WebDriver-drivable). The harness places on the first page
  // and reads back the CONVERTED appearance via the real conversion path.
  const liveSigRef = useRef(liveSigPlacement);
  liveSigRef.current = liveSigPlacement;
  const harnessPlaceSigRef = useRef<
    (rect: { x: number; y: number; w: number; h: number }) => boolean
  >(() => false);
  harnessPlaceSigRef.current = (rect) => {
    const doc = docs.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    if (!doc || !page) return false;
    // Same currency rule as harnessPlaceFieldRef — the
    // harness polls this, so a transient refusal during a reindex
    // self-heals instead of arming a doomed placement.
    if (!placementDocsCurrent(state.files, docs, doc.path)) return false;
    setSigPlacement({
      id: crypto.randomUUID(),
      path: doc.path,
      pageId: page.id,
      rect,
      rotationAtDraw: page.rotation,
    });
    return true;
  };
  // The crop band, driven the way the gesture drives it — through the
  // REAL `onSetCropRect`, so the geometry read, the rotation-aware inset
  // conversion and the publish to the panel are all exercised rather than
  // simulated.
  const harnessDrawCropRef = useRef<
    (rect: { x: number; y: number; w: number; h: number }) => boolean
  >(() => false);
  harnessDrawCropRef.current = (rect) => {
    const doc = docs.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    if (!doc || !page) return false;
    if (!placementDocsCurrent(state.files, docs, doc.path)) return false;
    onSetCropRect(doc.id, page.id, rect, page.rotation);
    return true;
  };
  const harnessBuildSigRef = useRef<
    () => Promise<{ path: string; appearance: { page: number; rect: [number, number, number, number] } } | null>
  >(async () => null);
  harnessBuildSigRef.current = async () => {
    const placement = liveSigPlacement;
    if (!placement) return null;
    return buildSignatureAppearance(docs, placement, async (page) => {
      const f = state.files.get(page.sourceDocId);
      if (!f?.buffer) throw new Error(`no buffer loaded for ${page.sourceDocId}`);
      const proxy = await getDocumentProxy(page.sourceDocId, f.buffer);
      const p = await proxy.getPage(page.sourcePageIndex + 1);
      const [vx0, vy0, vx1, vy1] = p.view;
      return { box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }, bakedRotate: p.rotate };
    });
  };
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasSignature({
      placeOnFirstPage: (rect) => harnessPlaceSigRef.current(rect),
      buildAppearance: () => harnessBuildSigRef.current(),
      clear: () => setSigPlacement(null),
      has: () => liveSigRef.current != null,
    });
    return () => registerCanvasSignature(null);
  }, []);
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasCrop({ drawOnFirstPage: (rect) => harnessDrawCropRef.current(rect) });
    return () => registerCanvasCrop(null);
  }, []);
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasSnapshot({ saveTo: (path) => writeSnapshotTo(path) });
    return () => registerCanvasSnapshot(null);
  }, [writeSnapshotTo]);

  // Which pages travel with a drag that grabs `grabbedPageId`: the whole
  // selection (in workspace order) when the grabbed page is part of a
  // multi-selection, otherwise just that page. MUST be a pure query — it runs
  // on pointer-down, before we know whether this is a drag or a click, so it
  // must not mutate the selection (that would corrupt a following Ctrl/Shift
  // click's modifier logic). A drag re-selects its moved pages on drop;
  // a plain click selects via onSelectPage.
  const getMovingPageIds = useCallback(
    (grabbedPageId: string): string[] => {
      if (selectedPageIds.size > 1 && selectedPageIds.has(grabbedPageId)) {
        return flatOrder.filter((id) => selectedPageIds.has(id));
      }
      return [grabbedPageId];
    },
    [selectedPageIds, flatOrder],
  );

  const movePagesInto = useCallback(
    (movingIds: string[], targetDocId: string, index: number) => {
      if (movingIds.length === 0) return;
      if (movingIds.length === 1) {
        // Keep the exact single-page semantics (same-doc no-op guard, etc.).
        const src = docs.find((d) => d.pages.some((p) => p.id === movingIds[0]));
        if (!src) return;
        dispatch({
          type: 'MOVE_PAGE',
          fromDocId: src.id,
          toDocId: targetDocId,
          pageId: movingIds[0],
          toIndex: index,
        });
      } else {
        dispatch({ type: 'MOVE_PAGES', pageIds: movingIds, toDocId: targetDocId, toIndex: index });
      }
      // A drag re-selects its moved pages on drop.
      dispatch({
        type: 'UI_SET_SELECTION',
        pageIds: movingIds,
        anchor: movingIds[movingIds.length - 1],
      });
    },
    [dispatch, docs],
  );

  const movePagesToNewDoc = useCallback(
    (movingIds: string[], docIndex: number) => {
      if (movingIds.length === 0) return;
      // Template on the first moving page's document (matches the reducer).
      const first = docs.find((d) => d.pages.some((p) => p.id === movingIds[0]));
      if (!first) return;
      const movingSet = new Set(movingIds);
      const newDocId = crypto.randomUUID();
      // Free a fully-emptied source doc's name for reuse by the new doc.
      const taken = new Set(
        docs.filter((d) => !d.pages.every((p) => movingSet.has(p.id))).map((d) => d.name),
      );
      const newName = uniqueDocName(first.name, taken);
      if (movingIds.length === 1) {
        dispatch({
          type: 'MOVE_PAGE_TO_NEW_DOC',
          fromDocId: first.id,
          pageId: movingIds[0],
          docIndex,
          newDocId,
          newName,
        });
      } else {
        dispatch({ type: 'MOVE_PAGES_TO_NEW_DOC', pageIds: movingIds, docIndex, newDocId, newName });
      }
      dispatch({
        type: 'UI_SET_SELECTION',
        pageIds: movingIds,
        anchor: movingIds[movingIds.length - 1],
      });
    },
    [dispatch, docs],
  );

  const drag = usePageDrag({
    layout,
    canvasRef,
    getMovingPageIds,
    movePagesInto,
    movePagesToNewDoc,
  });

  const onSelectPage = useCallback(
    (docId: string, pageId: string, e?: React.MouseEvent) => {
      // Modifier semantics (toggle / shift-range / single) live in the
      // reducer now — it has the workspace-flattened order and the anchor.
      const mode = e && (e.metaKey || e.ctrlKey) ? 'toggle' : e && e.shiftKey ? 'range' : 'single';
      dispatch({ type: 'UI_SELECT_PAGE', pageId, mode });
    },
    [dispatch],
  );

  // Double-click a page = READ it: the reading pane is
  // the "look closely" surface, so the PageInspector retired in its favor —
  // its rotate/delete were commands already.
  //
  // NOT `jumpToPage` after the mode dispatch: dispatch is async, so jumpToPage
  // would read the STALE mode ref, take its synchronous same-view fast path,
  // center the about-to-unmount BOARD, and the fresh DocumentView would open
  // at page 1 — on the WRONG document when the page belongs to a non-active
  // one (regression, HIGH). The pending-jump slot exists for exactly this:
  // park the target, flip the mode (and the owning doc if needed), and the
  // consuming effect centers once the new view's handle is live.
  const openPageForReading = useCallback(
    (pageId: string) => {
      const owner = docsRef.current.find((d) => d.pages.some((p) => p.id === pageId));
      if (!owner) return;
      const needsMode = docViewModeRef.current !== 'document';
      const needsFocus = owner.id !== focusedDocRef.current?.id;
      if (needsMode) dispatch({ type: 'UI_SET_DOC_VIEW_MODE', mode: 'document' });
      if (needsFocus) dispatch({ type: 'UI_FOCUS_DOC', docId: owner.id });
      if (needsMode || needsFocus) {
        // Park it: the flush effect centres once that doc's view has mounted.
        pendingJumpRef.current = pageId;
        return;
      }
      // ALREADY reading that document — centre NOW. Parking here instead was a
      // silent no-op: neither dispatch changes state, so the flush effect's
      // deps (focusedDoc, docViewMode) never change and it never re-runs. Every
      // jump from a surface that lists pages of the doc you are already reading
      // — the comment list, and now omnisearch text hits — did nothing at all.
      // `jumpToPage` above has always had this branch; this one was missing it.
      activeCanvasHandle()?.centerOn(pageId);
    },
    [dispatch, activeCanvasHandle],
  );
  openPageForReadingRef.current = openPageForReading;
  const onOpenPage = useCallback(
    (_docId: string, pageId: string) => openPageForReading(pageId),
    [openPageForReading],
  );

  const onPageContextMenu = useCallback(
    (docId: string, pageId: string, e: React.MouseEvent) => {
      // Right-clicking a page already in the selection keeps the whole
      // selection (menu actions then apply to all); otherwise select just it.
      dispatch({ type: 'UI_SELECT_PAGE', pageId, mode: 'context' });
      setMenu({ x: e.clientX, y: e.clientY, docId, pageId });
    },
    [dispatch],
  );

  const menuItems = useMemo((): MenuItem[] => {
    if (!menu) return [];
    // Shared with the nav-pane Pages panel — one menu definition.
    return buildPageContextMenu({
      docs,
      docId: menu.docId,
      pageId: menu.pageId,
      selectedPageIds,
      dispatch,
      onOpen: onOpenPage,
      onExtractText,
    });
  }, [menu, docs, selectedPageIds, dispatch, onOpenPage, onExtractText]);

  const onMoveDoc = useCallback(
    (docId: string, direction: -1 | 1) => dispatch({ type: 'REORDER_DOCS', docId, direction }),
    [dispatch],
  );

  // Canvas whole-document merge: append a COPY of this document's pages
  // to the document above — one IMPORT_PAGES dispatch = one undo step. Copy,
  // not move (the zero-page guard forbids emptying a file); the source strip
  // stays until the user removes it, and after Apply changes the copies
  // re-bake to the target's own file. Fresh ids + deep-copied annotations:
  // lib/merge-docs.ts.
  const [mergeNotice, setMergeNotice] = useState<string | null>(null);
  const onMergeUp = useCallback(
    (docId: string) => {
      const index = docs.findIndex((d) => d.id === docId);
      if (index <= 0) return; // first document has nothing above it
      const from = docs[index];
      const to = docs[index - 1];
      if (from.pages.length === 0) return;
      dispatch({
        type: 'IMPORT_PAGES',
        toDocId: to.id,
        toIndex: to.pages.length,
        pages: buildMergedPageRefs(from),
      });
    },
    [dispatch, docs],
  );

  const onRemoveDoc = useCallback(
    (docId: string) => {
      const doc = docs.find((d) => d.id === docId);
      if (!doc) return;
      const siblings = docs.filter((d) => d.path === doc.path);
      if (siblings.length === 1) {
        // Close-guard: a STAGED merge copy still reads its bytes from
        // this file — closing it would orphan the refs and fail every later
        // commit of the target. Scoped to dirty referencing paths: after
        // Apply changes the lingering (reindex-pending) refs are hazardless
        // and refusing would be spurious. Leaving the canvas commits (the
        // gate), so this canvas-side guard is the only one needed.
        if (pathBlockedFromClose(docs, state.pageDirtyPaths, doc.path)) {
          setMergeNotice(tChrome('canvas.doc.mergedCannotClose', { name: doc.name }));
          return;
        }
        onCloseFile(doc.path);
      } else {
        dispatch({ type: 'REMOVE_DOC', docId });
      }
    },
    [dispatch, docs, state.pageDirtyPaths, onCloseFile],
  );

  const onRenameDoc = useCallback(
    (docId: string, name: string) => {
      const taken = new Set(docs.filter((d) => d.id !== docId).map((d) => d.name));
      dispatch({ type: 'RENAME_DOC', docId, name: uniqueDocName(name.trim(), taken) });
    },
    [dispatch, docs],
  );

  // e2e harness for the canvas merge: the header hover actions sit in
  // the transformed overlay, so the doc listing + the REAL merge-up and
  // guarded-remove paths register here. Refs keep the registration stable.
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const filesRef = useRef(state.files);
  filesRef.current = state.files;
  const mergeUpRef = useRef(onMergeUp);
  mergeUpRef.current = onMergeUp;
  const removeDocRef = useRef(onRemoveDoc);
  removeDocRef.current = onRemoveDoc;
  const mergeNoticeRef = useRef(mergeNotice);
  mergeNoticeRef.current = mergeNotice;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCanvasMerge({
      getDocs: () =>
        docsRef.current.map((d) => ({ id: d.id, path: d.path, name: d.name, pages: d.pages.length })),
      mergeUp: (docId) => mergeUpRef.current(docId),
      removeDoc: (docId) => removeDocRef.current(docId),
      noticeText: () => mergeNoticeRef.current,
    });
    return () => registerCanvasMerge(null);
  }, []);

  const { intoDocId, intoIndex, betweenIndex, ghostSize, betweenPages } = deriveDropGhosts(
    docs,
    drag.draggingPage,
    drag.dropTarget,
  );

  const dirty = state.pageDirtyPaths.length > 0;

  if (docs.length === 0) {
    return (
      <div className="canvas-view flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg text-neutral-400 mb-1">
            {tChrome('canvas.view.noDocuments')}
          </p>
          <p className="text-sm text-neutral-500 mb-4">
            {tChrome('canvas.view.dropHint')}
          </p>
          <button
            onClick={onOpenFiles}
            className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium"
          >
            {tChrome('canvas.view.openPdf')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        'canvas-view flex-1 flex flex-col relative overflow-hidden' +
        (drag.committing ? ' committing' : '') +
        (drag.draggingPage ? ' dragging' : '') +
        // Output Preview and the flattener preview draw nothing, so the page
        // must not offer a draw cursor under either.
        (tool !== 'select' && tool !== 'forms' && tool !== 'outputpreview'
          && tool !== 'flattenpreview'
          ? ' annotating'
          : '') +
        (tool === 'forms' ? ' forms-mode' : '')
      }
    >
      {/* The contextual strip, at the top of the document pane. It shows
          the tool that owns the armed mode; nothing armed ⇒ nothing here. */}
      <SecondaryToolbar
        tool={tool}
        activeToolId={state.ui.activeToolId}
        toolColor={toolColor}
        onSetToolColor={setToolColor}
        stampPreset={stampPreset}
        onSetStampPreset={setStampPreset}
        countGroups={countGroups}
        shapeType={shapeType}
        onSetShapeType={setShapeType}
        measureScale={measureScale}
        onSetMeasureScale={setMeasureScale}
        measureLeaveMarkup={measureLeaveMarkup}
        onToggleMeasureLeaveMarkup={() => setMeasureLeaveMarkup((v) => !v)}
        measureResult={measureResult}
        calibration={calibration}
        onApplyCalibration={applyCalibration}
        onCancelCalibration={() => setCalibration(null)}
        editHasSelection={editSel !== null}
        editSelectionKind={editSel?.kind ?? null}
        editTextEditable={
          editSel?.kind === 'text'
            ? (editTextByPage
                .get(editSel.pageId)
                ?.runBoxes.find((r) => r.index === editSel.index)?.editable ?? false)
            : editSel?.kind === 'para' // only editable paragraphs are listed
        }
        editTextReason={
          editSel?.kind === 'text'
            ? (editTextByPage
                .get(editSel.pageId)
                ?.runBoxes.find((r) => r.index === editSel.index)?.reason ?? null)
            : null
        }
        editBusy={editBusy}
        editNotice={editNotice}
        onEditAction={(kind) => void runEditAction(kind)}
        editImageOpacity={editImageOpacity}
        editImageBlend={editImageBlend}
        onSetImageBlend={commitImageBlend}
        editImageMask={editImageMask}
        onSetImageMask={commitImageMask}
        editImagePlacementKind={editImageSelKind}
        editImageCount={editSel?.kind === 'image' ? editSel.indexes.length : 0}
        onAlignImages={alignImageGroup}
        onSetImageOpacity={commitImageOpacity}
        imageCropArmed={imageCropArmed}
        onToggleImageCrop={() => setImageCropArmed((a) => !a)}
        onRotateImage={rotateImage90}
        onEditTextOpen={() => {
          if (editSel?.kind === 'text') handleOpenTextEditor(editSel.pageId, editSel.index);
          else if (editSel?.kind === 'para')
            handleOpenParagraphEditor(editSel.pageId, editSel.index);
        }}
      />
      {state.ui.propertiesBar && (
        <PropertiesBar
          selected={resolvedAnnot}
          selectedGroup={resolvedAnnots?.annotations ?? NO_ANNOTATIONS}
          tool={tool}
          toolColor={toolColor}
          onSetToolColor={setToolColor}
          onRecolor={onRecolorAnnotation}
          onRemove={onRemoveAnnotation}
          onAlign={onAlignSelection}
          onDistribute={onDistributeSelection}
          onSizeMatch={onSizeMatchSelection}
          onReorder={onReorderSelection}
          onRecolorGroup={onRecolorSelection}
          onRemoveGroup={onRemoveSelection}
          onRestyle={onRestyleSelection}
          onRotateFlip={onRotateFlipSelection}
          onClose={() => dispatch({ type: 'UI_TOGGLE_PROPERTIES_BAR' })}
        />
      )}
      {recalTarget && recalAnnot && (
        <RecalibratePopover
          x={recalTarget.x}
          y={recalTarget.y}
          measureKind={recalAnnot.annotation.measureKind ?? 'distance'}
          currentNote={recalAnnot.annotation.note ?? ''}
          onApply={applyRecalibration}
          onClose={() => setRecalTarget(null)}
        />
      )}
      {docViewMode === 'document' && focusedDoc ? (
        (() => {
          // ONE props bundle for the unsplit view and both split panes — the
          // instances must never drift apart prop-by-prop (the openByPaths
          // two-implementations lesson, applied to JSX). Transient
          // interaction overlays (open editors, placements, transforms,
          // crop) are then stripped from the INACTIVE pane: two live
          // editors over one paragraph would let a stale draft clobber a
          // commit. Passive overlays (annotations, marks, find highlights,
          // form values, selections) mirror in both panes.
          const dvProps = {
            onCreateLinks: createLinks,
            pageLayout: state.ui.pageLayout,
            twoUpCover: state.ui.twoUpCover,
            spreadDirection: state.ui.spreadDirection,
            doc: focusedDoc,
            viewRotation: state.ui.viewRotationByPath[focusedDoc.path] ?? 0,
            proxies,
            renderVersion,
            selectedPageIds,
            onSelectPage,
            onOpenPage,
            onPageContextMenu,
            tool,
            annotationColor: toolColor ?? undefined,
            stampPreset,
            shapeType,
            measureScale,
            measureLeaveMarkup,
            onMeasureResult: setMeasureResult,
            onMarqueeZoomApplied: syncMarqueeZoom,
            redactionMarksByPage,
            fieldCandidatesByPage,
            tableRegionsByPage,
            tableReview: tableReviewHandlers,
            selectedCandidateId,
            onSelectCandidate: setSelectedCandidateId,
            onRemoveCandidate,
            onMoveCandidate,
            editImagesByPage,
            editVectorsByPage,
            snapGeomByPage,
            snapSettings,
            guidesByPage,
            onAddGuide,
            onMoveGuide,
            onRemoveGuide,
            selectedVector,
            editImageTransform,
            onCommitImageTransform: commitImageTransform,
            editImageGroup,
            onCommitImageGroupTransform: (
              pageId: string,
              targets: { index: number; matrix: number[] }[],
            ) => void commitImageGroupTransform(pageId, targets),
            vectorTransform,
            onCommitVectorTransform: (pageId: string, index: number, matrix: number[]) =>
              void commitVectorTransform(pageId, index, matrix),
            imageCropArmed,
            onCommitImageCrop: commitImageCrop,
            onCommitImageMask: commitImageMaskFromOverlay,
            editTextByPage,
            editSelection: editSel,
            editingText,
            onSelectEditImage: handleSelectEditImage,
            onSelectEditVector: handleSelectEditVector,
            onDeleteVector: () => void handleDeleteVector(),
            onRestyleVector: (
              pageId: string,
              index: number,
              opts: {
                fill?: [number, number, number];
                stroke?: [number, number, number];
                lineWidth?: number;
              },
            ) => void commitVectorRestyle(pageId, index, opts),
            onSelectEditText: handleSelectEditText,
            onOpenTextEditor: handleOpenTextEditor,
            onCommitTextEdit: (
              pageId: string,
              index: number,
              text: string,
              opts?: { convert?: boolean },
            ) => void handleCommitTextEdit(pageId, index, text, opts),
            onRestyleTextEdit: (
              pageId: string,
              index: number,
              style: { size?: number; color?: [number, number, number] },
            ) => void handleRestyleTextEdit(pageId, index, style),
            onCancelTextEdit: handleCancelTextEdit,
            onSelectEditParagraph: handleSelectEditParagraph,
            onOpenParagraphEditor: handleOpenParagraphEditor,
            onCommitParagraphEdit: (
              pageId: string,
              index: number,
              text: string,
              opts?: ParagraphEditOpts,
            ) => void handleCommitParagraphEdit(pageId, index, text, opts),
            onCancelParagraphEdit: handleCancelTextEdit,
            onCheckSpelling: handleCheckSpelling,
            spellLang,
            onMergeParagraphPrev: (
              pageId: string,
              index: number,
              editedText?: string,
              restyle?: MergeRestyle,
            ) => void handleMergeParagraphPrev(pageId, index, editedText, restyle),
            onMergeParagraphNext: (
              pageId: string,
              index: number,
              editedText?: string,
              restyle?: MergeRestyle,
            ) => void handleMergeParagraphNext(pageId, index, editedText, restyle),
            signaturePlacement: liveSigPlacement,
            findMatchPageIds,
            findWordsByPage,
            readAloudByPage,
            formWidgetsByPage,
            formValuesByPath: formDisplayValues,
            onSetFormValue,
            onSignFieldRequest,
            onFormButton: (p: string, f: string, a: import('../../lib/forms').ButtonAction | null) => void onFormButton(p, f, a),
            newFieldPlacement: liveNewFieldPlacement,
            onSetNewFieldRect,
            onClearNewFieldPlacement,
            addTextPlacement: liveAddTextPlacement,
            cropPlacement: liveCropPlacement,
            onClearCropPlacement,
            onSetCropRect,
            onSetBeadRect,
            onSetSnapshotRect,
            snapshotPlacement: liveSnapshotPlacement,
            onClearSnapshotPlacement,
            onSaveSnapshot,
            onSetAddTextRect,
            onAddImageRect,
            onClearAddTextPlacement,
            onAddAnnotation,
            onUpdateAnnotation,
            onRecolorAnnotation,
            onRemoveAnnotation,
            selectedAnnotationIds: selectedAnnot?.ids ?? NO_ANNOTATION_IDS,
            onSelectAnnotation,
            onTransformAnnotations,
            onCalibrate,
            onMeasureContextMenu,
            onMarqueeSelect,
            onRegroupCountMarks,
            onAddRedactionMark,
            onRemoveRedactionMark,
            onSetSignaturePlacement,
            onClearSignaturePlacement,
          };
          const inactiveOverrides = {
            editingText: null,
            editImageTransform: null,
            editImageGroup: null,
            vectorTransform: null,
            imageCropArmed: false,
            signaturePlacement: null,
            newFieldPlacement: null,
            addTextPlacement: null,
            cropPlacement: null,
            onClearCropPlacement,
            snapshotPlacement: null,
          };
          if (!splitView) {
            return (
              <DocumentView
                {...dvProps}
                key={focusedDoc.id}
                ref={documentViewRef}
                onCurrentPageChange={onPaneAPageChange}
              />
            );
          }
          if (splitMode === 'quad') {
            // The spreadsheet split: a 2×2 grid with a divider CROSS. Pane a
            // keeps the unsplit view's key/ref so entering quad never
            // remounts the primary view (the two-pane invariant, kept).
            const paneDefs = [
              { p: 'a' as const, ref: documentViewRef, onPage: onPaneAPageChange, key: focusedDoc.id, col: '1', row: '1' },
              { p: 'b' as const, ref: documentViewRefB, onPage: onPaneBPageChange, key: `${focusedDoc.id}:b`, col: '3', row: '1' },
              { p: 'c' as const, ref: documentViewRefC, onPage: onPaneCPageChange, key: `${focusedDoc.id}:c`, col: '1', row: '3' },
              { p: 'd' as const, ref: documentViewRefD, onPage: onPaneDPageChange, key: `${focusedDoc.id}:d`, col: '3', row: '3' },
            ];
            return (
              <div
                ref={quadContainerRef}
                data-testid="quad-container"
                className="flex-1 min-h-0 grid"
                style={{
                  gridTemplateColumns: `${quadCol}fr 6px ${1 - quadCol}fr`,
                  gridTemplateRows: `${splitRatio}fr 6px ${1 - splitRatio}fr`,
                }}
              >
                {paneDefs.map((def) => (
                  <div
                    key={def.p}
                    data-testid={`doc-pane-${def.p}`}
                    data-active={activePane === def.p}
                    className="flex min-h-0 min-w-0 flex-col"
                    style={{ gridColumn: def.col, gridRow: def.row }}
                    onPointerDownCapture={() => activatePane(def.p)}
                  >
                    <DocumentView
                      {...dvProps}
                      {...(activePane === def.p ? null : inactiveOverrides)}
                      key={def.key}
                      ref={def.ref}
                      onCurrentPageChange={def.onPage}
                    />
                  </div>
                ))}
                <div
                  data-testid="quad-divider-col"
                  role="separator"
                  aria-orientation="vertical"
                  className="cursor-col-resize bg-neutral-700 hover:bg-blue-500"
                  style={{ gridColumn: '2', gridRow: '1 / span 3' }}
                  onPointerDown={(e) => onQuadDividerDown('col', e)}
                />
                <div
                  data-testid="quad-divider-row"
                  role="separator"
                  aria-orientation="horizontal"
                  className="cursor-row-resize bg-neutral-700 hover:bg-blue-500"
                  style={{ gridColumn: '1 / span 3', gridRow: '2' }}
                  onPointerDown={(e) => onQuadDividerDown('row', e)}
                />
              </div>
            );
          }
          return (
            <div
              ref={splitContainerRef}
              data-testid="split-container"
              className="flex flex-1 min-h-0 flex-col"
            >
              <div
                data-testid="doc-pane-a"
                data-active={activePane === 'a'}
                className="flex min-h-0 flex-col"
                style={{ flexGrow: splitRatio, flexBasis: 0 }}
                onPointerDownCapture={() => activatePane('a')}
              >
                <DocumentView
                  {...dvProps}
                  {...(activePane === 'a' ? null : inactiveOverrides)}
                  key={focusedDoc.id}
                  ref={documentViewRef}
                  onCurrentPageChange={onPaneAPageChange}
                />
              </div>
              <div
                data-testid="split-divider"
                role="separator"
                aria-orientation="horizontal"
                className="h-1.5 shrink-0 cursor-row-resize bg-neutral-700 hover:bg-blue-500"
                onPointerDown={onDividerPointerDown}
              />
              <div
                data-testid="doc-pane-b"
                data-active={activePane === 'b'}
                className="flex min-h-0 flex-col"
                style={{ flexGrow: 1 - splitRatio, flexBasis: 0 }}
                onPointerDownCapture={() => activatePane('b')}
              >
                <DocumentView
                  {...dvProps}
                  {...(activePane === 'b' ? null : inactiveOverrides)}
                  key={`${focusedDoc.id}:b`}
                  ref={documentViewRefB}
                  onCurrentPageChange={onPaneBPageChange}
                />
              </div>
            </div>
          );
        })()
      ) : (
      <Canvas
        ref={canvasRef}
        contentWidth={layout.contentWidth}
        contentHeight={layout.contentHeight}
        slotHeight={layout.slotHeight}
        dragging={drag.draggingPage !== null}
        handMode={tool === 'hand'}
        onSettle={() => setRenderVersion((v) => v + 1)}
        onBackgroundClick={clearSelection}
        overlay={
          <HeaderLayer
            items={layout.items}
            betweenIndex={betweenIndex}
            onMove={onMoveDoc}
            onRemove={onRemoveDoc}
            onRename={onRenameDoc}
            onMergeUp={onMergeUp}
          />
        }
      >
        <DocLayer
          items={layout.items}
          proxies={proxies}
          renderVersion={renderVersion}
          selectedPageIds={selectedPageIds}
          collapsedIds={drag.collapsedIds}
          intoDocId={intoDocId}
          intoIndex={intoIndex}
          intoGhostWidth={ghostSize.width}
          intoGhostHeight={ghostSize.height}
          betweenIndex={betweenIndex}
          onSelectPage={onSelectPage}
          onOpenPage={onOpenPage}
          tool={tool}
          annotationColor={toolColor ?? undefined}
          stampPreset={stampPreset}
          shapeType={shapeType}
          measureScale={measureScale}
          measureLeaveMarkup={measureLeaveMarkup}
          onMeasureResult={setMeasureResult}
          redactionMarksByPage={redactionMarksByPage}
          fieldCandidatesByPage={fieldCandidatesByPage}
          tableRegionsByPage={tableRegionsByPage}
          tableReview={tableReviewHandlers}
          selectedCandidateId={selectedCandidateId}
          onSelectCandidate={setSelectedCandidateId}
          onRemoveCandidate={onRemoveCandidate}
          onMoveCandidate={onMoveCandidate}
          editImagesByPage={editImagesByPage}
          editVectorsByPage={editVectorsByPage}
          snapGeomByPage={snapGeomByPage}
          snapSettings={snapSettings}
          selectedVector={selectedVector}
          editImageTransform={editImageTransform}
          onCommitImageTransform={commitImageTransform}
          editImageGroup={editImageGroup}
          onCommitImageGroupTransform={(pageId, targets) =>
            void commitImageGroupTransform(pageId, targets)
          }
          vectorTransform={vectorTransform}
          onCommitVectorTransform={(pageId, index, matrix) =>
            void commitVectorTransform(pageId, index, matrix)
          }
          imageCropArmed={imageCropArmed}
          onCommitImageCrop={commitImageCrop}
          onCommitImageMask={commitImageMaskFromOverlay}
          editTextByPage={editTextByPage}
          editSelection={editSel}
          editingText={editingText}
          onSelectEditImage={handleSelectEditImage}
          onSelectEditVector={handleSelectEditVector}
          onDeleteVector={() => void handleDeleteVector()}
          onRestyleVector={(pageId, index, opts) => void commitVectorRestyle(pageId, index, opts)}
          onSelectEditText={handleSelectEditText}
          onOpenTextEditor={handleOpenTextEditor}
          onCommitTextEdit={(pageId, index, text, opts) =>
            void handleCommitTextEdit(pageId, index, text, opts)
          }
          onRestyleTextEdit={(pageId, index, style) =>
            void handleRestyleTextEdit(pageId, index, style)
          }
          onCancelTextEdit={handleCancelTextEdit}
          onSelectEditParagraph={handleSelectEditParagraph}
          onOpenParagraphEditor={handleOpenParagraphEditor}
          onCommitParagraphEdit={(pageId, index, text, opts) =>
            void handleCommitParagraphEdit(pageId, index, text, opts)
          }
          onCancelParagraphEdit={handleCancelTextEdit}
          onCheckSpelling={handleCheckSpelling}
          spellLang={spellLang}
          onMergeParagraphPrev={(pageId, index, editedText, restyle) =>
            void handleMergeParagraphPrev(pageId, index, editedText, restyle)
          }
          onMergeParagraphNext={(pageId, index, editedText, restyle) =>
            void handleMergeParagraphNext(pageId, index, editedText, restyle)
          }
          signaturePlacement={liveSigPlacement}
          findMatchPageIds={findMatchPageIds}
          findWordsByPage={findWordsByPage}
          readAloudByPage={readAloudByPage}
          formWidgetsByPage={formWidgetsByPage}
          formValuesByPath={formDisplayValues}
          onSetFormValue={onSetFormValue}
          onSignFieldRequest={onSignFieldRequest}
          onFormButton={(p, f, a) => void onFormButton(p, f, a)}
          newFieldPlacement={liveNewFieldPlacement}
          onSetNewFieldRect={onSetNewFieldRect}
          onClearNewFieldPlacement={onClearNewFieldPlacement}
          addTextPlacement={liveAddTextPlacement}
          onSetAddTextRect={onSetAddTextRect}
          onSetCropRect={onSetCropRect}
          onSetBeadRect={onSetBeadRect}
          cropPlacement={liveCropPlacement}
          onClearCropPlacement={onClearCropPlacement}
          onSetSnapshotRect={onSetSnapshotRect}
          snapshotPlacement={liveSnapshotPlacement}
          onClearSnapshotPlacement={onClearSnapshotPlacement}
          onSaveSnapshot={onSaveSnapshot}
          onAddImageRect={onAddImageRect}
          onClearAddTextPlacement={onClearAddTextPlacement}
          onPageContextMenu={onPageContextMenu}
          onPagePointerDown={tool === 'hand' ? HAND_SUPPRESSES_PICKUP : drag.onPagePointerDown}
          onAddAnnotation={onAddAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          onRecolorAnnotation={onRecolorAnnotation}
          onRemoveAnnotation={onRemoveAnnotation}
          selectedAnnotationIds={selectedAnnot?.ids ?? NO_ANNOTATION_IDS}
          onSelectAnnotation={onSelectAnnotation}
          onTransformAnnotations={onTransformAnnotations}
          onCalibrate={onCalibrate}
          onMeasureContextMenu={onMeasureContextMenu}
          onMarqueeSelect={onMarqueeSelect}
          onRegroupCountMarks={onRegroupCountMarks}
          onAddRedactionMark={onAddRedactionMark}
          onRemoveRedactionMark={onRemoveRedactionMark}
          onSetSignaturePlacement={onSetSignaturePlacement}
          onClearSignaturePlacement={onClearSignaturePlacement}
          onAddPages={onAddPages}
        />
        {drag.dropTarget?.kind === 'between' && (
          <div
            className="canvas-doc ghost-doc"
            style={{
              left: 0,
              top: betweenSlotY(layout, drag.dropTarget.docIndex),
              width: MIN_DOC_WIDTH,
            }}
          >
            <GhostRow width={MIN_DOC_WIDTH} pageHeight={BASE_PAGE_HEIGHT} pages={betweenPages} />
          </div>
        )}
        <div
          className="canvas-doc"
          style={{ left: 0, top: betweenSlotY(layout, layout.items.length), width: MIN_DOC_WIDTH }}
        >
          <AddDocGhost width={MIN_DOC_WIDTH} onClick={onOpenFiles} />
        </div>
      </Canvas>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {/* Floating controls. The tool pill and its mode OPTIONS (stamp presets,
          annotation colour) moved to the secondary toolbar — they belong to the
          tool. What's left is deliberately NOT tool-scoped: the view toggles,
          and the PENDING-STATE buttons (Fill N / Redact N / Apply changes),
          which report queued work. The canvas invariant is that pending state is
          never invisible, so those must not vanish when a tool closes. */}
      {(!state.ui.readingMode || dirty || pendingFormCount > 0 || liveMarks.length > 0) && (
        <CanvasStatusBar
          docViewMode={docViewMode}
          snap={snapSettings}
          snapScaleUnit={measureScale.toUnit}
          onSnapChange={setSnapSettings}
          onToggleView={() =>
            dispatch({
              type: 'UI_SET_DOC_VIEW_MODE',
              mode: docViewMode === 'document' ? 'organize' : 'document',
            })
          }
          // The status bar and the Comments TOOL now open the SAME panel —
          // there is one comments surface, seated like any other op. The dock's
          // separate `view: 'comments'` mode is gone with the second list.
          showComments={state.ui.toolDock.open && state.ui.activeOp === 'comments'}
          onToggleComments={() => {
            if (state.ui.toolDock.open && state.ui.activeOp === 'comments') {
              dispatch({ type: 'UI_SET_TOOL_DOCK_OPEN', open: false });
            } else {
              invokeCommand('tools.panel.comments');
            }
          }}
          pageBox={
            docViewMode === 'document' && focusedDoc
              ? {
                  inputRef: pageBoxRef,
                  value: pageBox,
                  total: focusedDoc.pages.length,
                  labelled: labelsCustom,
                  sheet: currentPage,
                  onChange: (e) => {
                    setPageBox(sanitizePageEntry(e.target.value, labelsCustom));
                    pageBoxDirty.current = true;
                  },
                  onFocus: (e) => {
                    pageBoxFocused.current = true;
                    pageBoxDirty.current = false;
                    e.target.select();
                  },
                  onBlur: () => {
                    pageBoxFocused.current = false;
                    // Only navigate if the user actually typed a new page — a
                    // blur after just focusing + scrolling must not snap back.
                    if (pageBoxDirty.current) {
                      // A label first, then the sheet number; an entry that
                      // is neither leaves the reading position alone and
                      // resyncs the box (typing nonsense must not navigate).
                      const n = resolvePageEntry(pageBox, pageLabels, focusedDoc.pages.length);
                      if (n !== null) activeCanvasHandle()?.centerOn(focusedDoc.pages[n - 1].id);
                      setPageBox(labelFor(n ?? currentPage, pageLabels));
                    } else {
                      setPageBox(labelFor(currentPage, pageLabels));
                    }
                  },
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  },
                }
              : null
          }
          onZoomOut={() => activeCanvasHandle()?.zoomOut()}
          onFit={() => activeCanvasHandle()?.reset()}
          onZoomIn={() => activeCanvasHandle()?.zoomIn()}
          dirty={dirty}
          onApplyPageEdits={() => invokeCommand('document.applyPageEdits')}
          pendingFormCount={pendingFormCount}
          fillingForms={fillingForms}
          onApplyForms={() => void applyFormValues()}
          onClearForms={clearFormValues}
          markCount={liveMarks.length}
          redacting={redacting}
          onApplyRedact={() => setConfirmRedact(true)}
          onClearRedact={() => setMarks([])}
          savingMarks={savingMarks}
          onSaveRedact={() => void saveMarks()}
        />
      )}


      {find.open && (
        <FindBar
          query={find.query}
          result={find.result}
          matchCount={find.matchPages.length}
          current={find.current}
          options={find.options}
          onToggleOption={find.toggleOption}
          ocrRemaining={searchIndex.ocrRemaining}
          hasScanned={searchIndex.hasScanned}
          ocrLanguage={searchIndex.ocrLanguage}
          canApplyOcr={ocrReady.length > 0}
          applyingOcr={applyingOcr}
          onQuery={find.setQuery}
          onOcrLanguage={searchIndex.setOcrLanguage}
          onNext={find.next}
          onPrev={find.prev}
          onApplyOcr={() => void handleApplyOcr()}
          onClose={find.closeFind}
        />
      )}
      {reader.open && <ReadAloudBar reader={reader} />}
      {ocrApplyError && (
        <div
          data-testid="ocr-apply-error"
          className="absolute top-16 end-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 bg-red-600/20 border border-red-500/40 rounded text-xs text-red-200 shadow-lg"
        >
          <span className="flex-1">{ocrApplyError}</span>
          <button onClick={() => setOcrApplyError(null)} className="text-red-300 hover:text-red-100">×</button>
        </div>
      )}
      {formsError && (
        <div
          data-testid="forms-fill-error"
          className="absolute top-28 end-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 bg-red-600/20 border border-red-500/40 rounded text-xs text-red-200 shadow-lg"
        >
          <span className="flex-1">{formsError}</span>
          <button onClick={() => setFormsError(null)} className="text-red-300 hover:text-red-100">×</button>
        </div>
      )}
      {mergeNotice && (
        <div
          data-testid="merge-notice"
          className="absolute top-40 end-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 bg-amber-500/15 border border-amber-500/40 rounded text-xs text-amber-200 shadow-lg"
        >
          <span className="flex-1">{mergeNotice}</span>
          <button onClick={() => setMergeNotice(null)} className="text-amber-300 hover:text-amber-100">×</button>
        </div>
      )}

      {(liveSigPlacement || sigFieldTarget) && (
        <div
          data-testid="sign-canvas-form"
          className="absolute bottom-4 start-4 z-30 w-80 rounded border border-neutral-700 bg-neutral-900/95 p-3 shadow-xl flex flex-col gap-2.5"
        >
          <div className="text-sm text-neutral-200 font-medium">
            {sigFieldTarget
              ? tChrome('canvas.sign.fieldTitle', { field: sigFieldTarget.fieldName })
              : tChrome('canvas.sign.stampTitle')}
          </div>
          <p className="text-[11px] text-neutral-500 -mt-1.5">
            {tChrome(
              sigFieldTarget ? 'canvas.sign.fieldBlurb' : 'canvas.sign.stampBlurb',
            )}
          </p>
          <SignerSourceFields value={sigSource} onChange={setSigSource} idPrefix="canvas-sign" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">
              {tChrome('canvas.sign.password')}
            </span>
            <input
              data-testid="canvas-sign-password"
              type="password"
              value={sigPassword}
              onChange={(e) => setSigPassword(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">
              {tChrome('canvas.sign.reason')}
            </span>
            <input
              type="text"
              value={sigReason}
              placeholder={tChrome('canvas.sign.optional')}
              onChange={(e) => setSigReason(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">
              {tChrome('canvas.sign.location')}
            </span>
            <input
              type="text"
              value={sigLocation}
              placeholder={tChrome('canvas.sign.optional')}
              onChange={(e) => setSigLocation(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
            />
          </div>
          {/* Certification is offered here on the same terms as in the panel:
              only where it can be the document's first signature. Filling an
              EXISTING field is still an eligible placement — what disqualifies
              a document is a signature already on it, not the placement. */}
          {sigCanCertify ? (
            <div className="flex flex-col gap-1.5" data-testid="canvas-certify-group">
              <label className="flex items-center gap-2 text-xs text-neutral-300">
                <input
                  data-testid="canvas-sign-certify"
                  type="checkbox"
                  checked={sigCertify.certify}
                  onChange={(e) => setSigCertify((c) => ({ ...c, certify: e.target.checked }))}
                />
                {tChrome('panel.sig.certify')}
              </label>
              {sigCertify.certify && (
                <select
                  data-testid="canvas-sign-certify-level"
                  value={sigCertify.level}
                  aria-label={tChrome('panel.sig.certifyLevel')}
                  onChange={(e) =>
                    setSigCertify((c) => ({ ...c, level: e.target.value as CertificationLevel }))
                  }
                  className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-blue-500"
                >
                  {CERTIFY_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {tChrome(CERTIFICATION_LEVEL_LABEL[level])}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : (
            <p data-testid="canvas-certify-unavailable" className="text-[11px] text-neutral-500">
              {tChrome('panel.sig.certifyUnavailable')}
            </p>
          )}
          <FieldLockControl
            value={sigLock}
            onChange={setSigLock}
            fieldNames={sigLockFields}
            idPrefix="canvas-sign"
          />
          {signError && <div data-testid="canvas-sign-error" className="text-xs text-red-400">{signError}</div>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setSigPlacement(null);
                setSigFieldTarget(null);
                setSigPassword('');
                setSignError(null);
              }}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              {tChrome('canvas.common.cancel')}
            </button>
            <button
              data-testid="canvas-sign-apply"
              onClick={() => void applySignature()}
              disabled={signingBusy}
              className="px-2.5 py-1 text-xs text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded font-medium"
            >
              {tChrome(signingBusy ? 'canvas.sign.signing' : 'canvas.sign.apply')}
            </button>
          </div>
        </div>
      )}

      {liveNewFieldPlacement && (
        <div
          data-testid="new-field-form"
          className="absolute bottom-4 start-4 z-30 w-80 rounded border border-neutral-700 bg-neutral-900/95 p-3 shadow-xl flex flex-col gap-2.5"
        >
          <div className="text-sm text-neutral-200 font-medium">
            {tChrome('canvas.newfield.title')}
          </div>
          <p className="text-[11px] text-neutral-500 -mt-1.5">
            {tChrome('canvas.newfield.blurb')}
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">
              {tChrome('canvas.newfield.name')}
            </span>
            <input
              data-testid="new-field-name"
              type="text"
              value={nfName}
              onChange={(e) => setNfName(e.target.value)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-20 shrink-0">
              {tChrome('canvas.newfield.type')}
            </span>
            <select
              data-testid="new-field-type"
              value={nfType}
              onChange={(e) => setNfType(e.target.value as NewFieldType)}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs"
            >
              <option value="text">{tChrome('canvas.newfield.type.text')}</option>
              <option value="checkbox">{tChrome('canvas.newfield.type.checkbox')}</option>
              <option value="radio">{tChrome('canvas.newfield.type.radio')}</option>
              <option value="dropdown">{tChrome('canvas.newfield.type.dropdown')}</option>
              <option value="optionlist">{tChrome('canvas.newfield.type.optionlist')}</option>
              <option value="signature">{tChrome('canvas.newfield.type.signature')}</option>
            </select>
          </div>
          {nfType === 'text' && (
            <label className="flex items-center gap-2 cursor-pointer text-xs text-neutral-400">
              <input
                type="checkbox"
                checked={nfMultiline}
                onChange={() => setNfMultiline((v) => !v)}
                className="rounded bg-neutral-800 border-neutral-700"
              />
              {tChrome('canvas.newfield.multiline')}
            </label>
          )}
          {nfType === 'signature' && (
            <FieldLockControl
              value={nfLock}
              onChange={setNfLock}
              fieldNames={newFieldLockNames}
              idPrefix="new-field"
            />
          )}
          {(nfType === 'radio' || nfType === 'dropdown' || nfType === 'optionlist') && (
            <div className="flex items-start gap-2">
              <span className="text-xs text-neutral-400 w-20 shrink-0 pt-1">
                {tChrome('canvas.newfield.options')}
              </span>
              <textarea
                data-testid="new-field-options"
                value={nfOptions}
                rows={3}
                placeholder={tChrome('canvas.newfield.optionsPlaceholder')}
                onChange={(e) => setNfOptions(e.target.value)}
                className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-emerald-500 resize-y"
              />
            </div>
          )}
          {nfError && <div data-testid="new-field-error" className="text-xs text-red-400">{nfError}</div>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setNewFieldPlacement(null);
                setNfError(null);
              }}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              {tChrome('canvas.common.cancel')}
            </button>
            <button
              data-testid="new-field-create"
              onClick={() => void createPlacedField()}
              disabled={creatingField}
              className="px-2.5 py-1 text-xs text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded font-medium"
            >
              {tChrome(creatingField ? 'canvas.newfield.creating' : 'canvas.newfield.create')}
            </button>
          </div>
        </div>
      )}

      {liveAddTextPlacement && (
        <div
          data-testid="add-text-form"
          className="absolute bottom-4 start-4 z-30 w-80 rounded border border-neutral-700 bg-neutral-900/95 p-3 shadow-xl flex flex-col gap-2.5"
        >
          <div className="text-sm text-neutral-200 font-medium">
            {tChrome('canvas.addtext.title')}
          </div>
          <p className="text-[11px] text-neutral-500 -mt-1.5">
            {tChrome('canvas.addtext.blurb')}
          </p>
          <textarea
            data-testid="add-text-input"
            ref={atTextareaRef}
            value={atText}
            rows={3}
            autoFocus
            placeholder={tChrome('canvas.addtext.placeholder')}
            onChange={(e) => {
              setAtText(e.target.value);
              // Character positions drift under edits — clear spans
              // visibly rather than let them silently mis-bind.
              if (atSpans.length > 0) setAtSpans([]);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClearAddTextPlacement();
              }
            }}
            className="px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-emerald-500 resize-y"
          />
          <div className="flex items-center gap-1.5 flex-wrap" data-testid="add-text-span-row">
            <span
              className="text-xs text-neutral-400 w-16 shrink-0"
              title={tChrome('canvas.addtext.spansTitle')}
            >
              {tChrome('canvas.addtext.spans')}
            </span>
            <input
              data-testid="add-text-span-size"
              type="number"
              min={1}
              max={999}
              placeholder={tChrome('canvas.addtext.sizePlaceholder')}
              value={atSpanSize}
              onChange={(e) => setAtSpanSize(e.target.value)}
              className="w-14 px-1.5 py-0.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
            />
            {['#000000', '#c62828', '#1565c0', '#2e7d32'].map((hex) => (
              <button
                key={hex}
                type="button"
                className={'page-edittext-colorchip' + (atSpanColor === hex ? ' selected' : '')}
                style={{ background: hex }}
                onClick={() => setAtSpanColor((c) => (c === hex ? null : hex))}
              />
            ))}
            <button
              type="button"
              onClick={() => setAtSpanBold((v) => !v)}
              className={`px-1.5 py-0.5 text-xs font-bold rounded border ${atSpanBold ? 'border-emerald-500 text-emerald-400' : 'border-neutral-700 text-neutral-400'}`}
            >
              {tChrome('canvas.addtext.bold')}
            </button>
            <button
              type="button"
              onClick={() => setAtSpanItalic((v) => !v)}
              className={`px-1.5 py-0.5 text-xs italic rounded border ${atSpanItalic ? 'border-emerald-500 text-emerald-400' : 'border-neutral-700 text-neutral-400'}`}
            >
              {tChrome('canvas.addtext.italic')}
            </button>
            <button
              data-testid="add-text-span-apply"
              type="button"
              onClick={() => {
                const ta = atTextareaRef.current;
                if (!ta) return;
                const start = ta.selectionStart ?? 0;
                const end = ta.selectionEnd ?? 0;
                if (start >= end) {
                  setAtError(tChrome('canvas.addtext.selectTextFirst'));
                  return;
                }
                const size = parseFloat(atSpanSize);
                const span: {
                  start: number; end: number; size?: number;
                  color?: [number, number, number]; bold?: boolean; italic?: boolean;
                } = { start, end };
                if (atSpanSize !== '' && Number.isFinite(size) && size > 0) span.size = size;
                if (atSpanColor) {
                  const c = hexToRgb(atSpanColor);
                  if (c) span.color = c;
                }
                if (atSpanBold) span.bold = true;
                if (atSpanItalic) span.italic = true;
                if (span.size === undefined && !span.color && !span.bold && !span.italic) {
                  setAtError(tChrome('canvas.addtext.pickAStyleFirst'));
                  return;
                }
                setAtError(null);
                // Overlapping earlier spans are replaced by the new one —
                // last application wins, kept sorted for the engine.
                setAtSpans((prev) =>
                  [...prev.filter((s) => s.end <= start || s.start >= end), span].sort(
                    (a, b) => a.start - b.start,
                  ),
                );
              }}
              className="px-2 py-0.5 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              {tChrome('canvas.addtext.styleSelection')}
            </button>
          </div>
          {atSpans.length > 0 && (
            <div className="flex flex-wrap gap-1" data-testid="add-text-span-chips">
              {atSpans.map((s, i) => (
                <span
                  key={`${s.start}-${s.end}-${i}`}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] bg-neutral-800 border border-neutral-700 rounded text-neutral-300"
                  title={tChrome('canvas.addtext.spanChipTitle', {
                    text: atText.slice(s.start, s.end),
                  })}
                >
                  {tChrome('canvas.addtext.spanRange', {
                    start: tNumber(s.start),
                    end: tNumber(s.end),
                  })}
                  {s.size !== undefined
                    ? tChrome('canvas.addtext.spanSize', { size: tNumber(s.size) })
                    : ''}
                  {s.bold ? tChrome('canvas.addtext.spanBold') : ''}
                  {s.italic ? tChrome('canvas.addtext.spanItalic') : ''}
                  {s.color ? (
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm"
                      style={{ background: `rgb(${s.color.map((v) => Math.round(v * 255)).join(',')})` }}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="text-neutral-500 hover:text-red-400"
                    onClick={() => setAtSpans((prev) => prev.filter((_x, xi) => xi !== i))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-16 shrink-0">
              {tChrome('canvas.addtext.font')}
            </span>
            <select
              data-testid="add-text-family"
              value={atFamily}
              onChange={(e) => setAtFamily(e.target.value as 'sans' | 'serif' | 'mono')}
              className="flex-1 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs"
            >
              <option value="sans">{tChrome('canvas.addtext.family.sans')}</option>
              <option value="serif">{tChrome('canvas.addtext.family.serif')}</option>
              <option value="mono">{tChrome('canvas.addtext.family.mono')}</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400 w-16 shrink-0">
              {tChrome('canvas.addtext.size')}
            </span>
            <input
              data-testid="add-text-size"
              type="number"
              min={1}
              max={1638}
              step={1}
              // parseFloat + skip-on-NaN (NOT Number(), where '' → 0 → clamps
              // to 1 and fights a clear-and-retype: "125" instead of "25").
              // Mirrors ParagraphEditor's size input — the regression fix.
              value={Number.isFinite(atSize) ? Math.round(atSize) : ''}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v)) setAtSize(Math.max(1, Math.min(1638, v)));
              }}
              className="w-20 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-emerald-500"
            />
            <button
              type="button"
              data-testid="add-text-rotate"
              title={tChrome('canvas.addtext.rotateTitle')}
              onClick={() =>
                setAtRotate((r) => {
                  const next = (Math.floor(r / 90) * 90 + 90) % 360;
                  // The box preview's direction arrow tracks the card live.
                  setAddTextPlacement((pl) => (pl ? { ...pl, rotate: next } : pl));
                  return next;
                })
              }
              className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded hover:border-emerald-500"
            >
              <span
                className="inline-block"
                style={{ transform: `rotate(${-atRotate}deg)` }}
                aria-hidden
              >
                →
              </span>{' '}
              {tChrome('canvas.addtext.degrees', {
                deg: tNumber(Math.round(atRotate * 10) / 10),
              })}
            </button>
            <input
              type="number"
              data-testid="add-text-rotate-deg"
              title={tChrome('canvas.addtext.rotateDegTitle')}
              min={-360}
              max={720}
              step={1}
              value={Number.isFinite(atRotate) ? Math.round(atRotate * 10) / 10 : ''}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!Number.isFinite(v)) return;
                const next = ((v % 360) + 360) % 360;
                setAtRotate(next);
                setAddTextPlacement((pl) => (pl ? { ...pl, rotate: next } : pl));
              }}
              className="w-20 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-emerald-500"
            />
            <button
              type="button"
              data-testid="add-text-bold"
              aria-pressed={atBold}
              title={tChrome('canvas.addtext.boldTitle')}
              onClick={() => setAtBold((b) => !b)}
              className={`px-2 py-1 text-xs font-bold border rounded ${
                atBold
                  ? 'bg-emerald-700/40 border-emerald-500'
                  : 'bg-neutral-800 border-neutral-700 hover:border-emerald-500'
              }`}
            >
              {tChrome('canvas.addtext.bold')}
            </button>
            <button
              type="button"
              data-testid="add-text-kern"
              aria-pressed={atKern}
              title={tChrome('canvas.addtext.kernTitle')}
              onClick={() => setAtKern((k) => !k)}
              className={`px-2 py-1 text-xs border rounded ${
                atKern
                  ? 'bg-emerald-700/40 border-emerald-500'
                  : 'bg-neutral-800 border-neutral-700 hover:border-emerald-500'
              }`}
            >
              {tChrome('canvas.addtext.kern')}
            </button>
            <button
              type="button"
              data-testid="add-text-italic"
              aria-pressed={atItalic}
              title={tChrome('canvas.addtext.italicTitle')}
              onClick={() => setAtItalic((i) => !i)}
              className={`px-2 py-1 text-xs italic border rounded ${
                atItalic
                  ? 'bg-emerald-700/40 border-emerald-500'
                  : 'bg-neutral-800 border-neutral-700 hover:border-emerald-500'
              }`}
            >
              {tChrome('canvas.addtext.italic')}
            </button>
            {/* OpenType features. Authoring always renders a bundled face,
                so a feature switches to Libertinus Serif (Liberation has none). */}
            <button
              type="button"
              data-testid="add-text-smallcaps"
              aria-pressed={atSmallCaps}
              title={tChrome('canvas.addtext.smallCapsTitle')}
              onClick={() => setAtSmallCaps((s) => !s)}
              className={`px-2 py-1 text-xs border rounded ${
                atSmallCaps
                  ? 'bg-emerald-700/40 border-emerald-500'
                  : 'bg-neutral-800 border-neutral-700 hover:border-emerald-500'
              }`}
              style={{ fontVariantCaps: 'all-small-caps' }}
            >
              {tChrome('canvas.addtext.smallCaps')}
            </button>
            <button
              type="button"
              data-testid="add-text-alternates"
              aria-pressed={atAlternates}
              title={tChrome('canvas.addtext.alternatesTitle')}
              onClick={() => setAtAlternates((a) => !a)}
              className={`px-2 py-1 text-xs border rounded ${
                atAlternates
                  ? 'bg-emerald-700/40 border-emerald-500'
                  : 'bg-neutral-800 border-neutral-700 hover:border-emerald-500'
              }`}
            >
              {tChrome('canvas.addtext.alternates')}
            </button>
            {atAlternates && (
              <input
                type="number"
                data-testid="add-text-altindex"
                min={0}
                max={99}
                step={1}
                value={atAltIndex}
                title={tChrome('canvas.addtext.altIndexTitle')}
                onChange={(e) =>
                  setAtAltIndex(Math.max(0, Math.min(99, Math.trunc(parseFloat(e.target.value) || 0))))
                }
                className="w-12 px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-xs focus:outline-none focus:border-emerald-500"
              />
            )}
            <span className="text-xs text-neutral-400 flex-1 text-end shrink-0">
              {tChrome('canvas.addtext.colour')}
            </span>
            <input
              data-testid="add-text-color"
              type="color"
              value={atColor}
              onChange={(e) => setAtColor(e.target.value)}
              className="h-6 w-8 bg-neutral-800 border border-neutral-700 rounded"
            />
          </div>
          {atFits === false && (
            <div data-testid="add-text-overflow" className="text-xs text-amber-400">
              {tChrome('canvas.addtext.overflow')}
            </div>
          )}
          {atError && <div data-testid="add-text-error" className="text-xs text-red-400">{atError}</div>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => onClearAddTextPlacement()}
              className="px-2.5 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
            >
              {tChrome('canvas.common.cancel')}
            </button>
            <button
              data-testid="add-text-create"
              onClick={() => void createPlacedText()}
              disabled={creatingText}
              className="px-2.5 py-1 text-xs text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded font-medium"
            >
              {tChrome(creatingText ? 'canvas.addtext.adding' : 'canvas.addtext.title')}
            </button>
          </div>
        </div>
      )}

      {signDone && (
        <div
          data-testid="canvas-sign-done"
          className={`absolute bottom-4 start-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 rounded text-xs shadow-lg border ${
            signDone.ok
              ? 'bg-green-600/15 border-green-600/40 text-green-200'
              : 'bg-amber-500/15 border-amber-500/40 text-amber-200'
          }`}
        >
          <span className="flex-1">
            {tChrome(signDone.ok ? 'canvas.sign.doneOk' : 'canvas.sign.doneBad', {
              signer: signDone.signer ?? tChrome('canvas.sign.unknownSigner'),
              output: signDone.output,
            })}
          </span>
          <button onClick={() => setSignDone(null)} className="hover:text-white">×</button>
        </div>
      )}

      {redactError && (
        <div
          data-testid="redact-error"
          className="absolute bottom-16 end-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 bg-red-600/20 border border-red-500/40 rounded text-xs text-red-200 shadow-lg"
        >
          <span className="flex-1">{redactError}</span>
          <button
            onClick={() => setRedactError(null)}
            className="text-red-300 hover:text-red-100"
          >
            ×
          </button>
        </div>
      )}

      {snapshotError && (
        <div
          data-testid="snapshot-error"
          className="absolute bottom-16 end-4 z-30 max-w-md flex items-start gap-2 px-3 py-2 bg-red-600/20 border border-red-500/40 rounded text-xs text-red-200 shadow-lg"
        >
          <span className="flex-1">
            {tChrome('canvas.snapshot.failed', { message: snapshotError })}
          </span>
          <button
            onClick={() => setSnapshotError(null)}
            className="text-red-300 hover:text-red-100"
          >
            ×
          </button>
        </div>
      )}

      {/* Redaction is the one canvas action that destroys file content, so it
          alone gets an explicit confirm step. */}
      {confirmRedact && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={() => setConfirmRedact(false)}
        >
          <div
            className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[420px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-neutral-800">
              <h3 className="text-sm font-semibold">{tChrome('canvas.redact.title')}</h3>
            </div>
            <div className="px-5 py-4 text-sm text-neutral-300 space-y-2">
              <p>
                {tChromeCount('canvas.redact.confirm', liveMarks.length, {
                  pages: tChromeCount(
                    'canvas.redact.pageCount',
                    new Set(liveMarks.map((m) => m.pageId)).size,
                  ),
                })}
              </p>
              <p className="text-xs text-neutral-400">{tChrome('canvas.redact.warning')}</p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-neutral-800">
              <button
                data-testid="redact-cancel-btn"
                onClick={() => setConfirmRedact(false)}
                className="px-3 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium"
              >
                {tChrome('canvas.common.cancel')}
              </button>
              <button
                data-testid="redact-confirm-btn"
                onClick={() => {
                  setConfirmRedact(false);
                  void applyMarks();
                }}
                className="px-3 py-1 text-xs text-white bg-red-600 hover:bg-red-500 rounded font-medium"
              >
                {tChrome('canvas.redact.apply')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
