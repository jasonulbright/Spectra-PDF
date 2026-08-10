// The renderer half of scanner acquisition: the wire types the Rust module
// reports, and the CONTROL DERIVATION that turns one device's capability
// report into the controls a dialog may render.
//
// A leaf data + pure-function module with no React and no engine calls, for
// the reason `create-pdf.ts` is one: there is no DOM test environment in this
// repo, so anything that has to be proven lives here rather than inside the
// component.
//
// The rule the whole module exists to enforce: EVERY control comes from what
// the device reported. A resolution dropdown of 100/200/300/600 offered on a
// device whose resolution is a 75–1200 range in steps of 25 is a control that
// lies, and one offered on a device reporting three values is a control that
// refuses. Nothing here has a default list of anything.
//
// Field names are snake_case because they are the Rust struct's own spelling,
// which is what crosses the bridge.

/** What one property's `GetPropertyAttributes` reported. */
export type PropertyDomain =
  | { kind: 'none' }
  | { kind: 'list'; values: number[]; nominal: number | null }
  | { kind: 'range'; min: number; max: number; step: number; nominal: number | null }
  | { kind: 'flag'; valid: number; nominal: number | null };

export interface PropertyReport {
  id: number;
  /** The driver's own name for the property. Never translated: the OS's own
   * scan surfaces show the same string. */
  name: string;
  readable: boolean;
  writable: boolean;
  current: number | null;
  domain: PropertyDomain;
}

/** What a control derived from one property can offer. */
export type ControlModel =
  | { kind: 'absent' }
  | { kind: 'fixed'; value: number }
  | { kind: 'choice'; values: number[]; current: number | null }
  | { kind: 'span'; min: number; max: number; step: number; current: number | null }
  | { kind: 'flags'; valid: number; current: number | null };

export type ColorMode = 'black_and_white' | 'grayscale' | 'color' | 'auto';

export type SourceCategory =
  | 'flatbed'
  | 'feeder'
  | 'feeder_front'
  | 'feeder_back'
  | 'auto'
  | 'film'
  | 'other';

export type DuplexMode = 'none' | 'duplex_bit' | 'front_back_items';

export interface DocumentHandling {
  capabilities: number;
  flatbed: boolean;
  feeder: boolean;
  duplex: boolean;
  advanced_duplex: boolean;
  duplex_mode: DuplexMode;
  /** The exact value each offered source writes. Reported by the device
   * layer, never reconstructed here — a second copy of those bit values is a
   * second thing to keep right. */
  flatbed_select: number;
  feeder_select: number;
  duplex_select: number;
}

export interface ScanSourceReport {
  item_name: string;
  category: SourceCategory;
  properties: PropertyReport[];
  resolution: ControlModel;
  optical_resolution: number | null;
  color_modes: ColorMode[];
  brightness: ControlModel;
  contrast: ControlModel;
  pages: ControlModel;
  document_handling_select: ControlModel;
}

export interface ScannerCapabilities {
  device_id: string;
  device_name: string;
  document_handling: DocumentHandling;
  max_scan_time_ms: number | null;
  /** The sources this device offers, in picker order — derived by the device
   * layer so nothing downstream re-derives it. */
  source_options: ScanSourceOption[];
  sources: ScanSourceReport[];
}

export interface ScannerDevice {
  id: string;
  name: string;
}

export interface ScannerList {
  scanners: ScannerDevice[];
  default: string | null;
}

/** A structured refusal from the device layer: a stable catalog key beside
 * its English sentence. A bare `String(e)` on one of these yields
 * "[object Object]" — read `key`. */
export interface ScanRefusal {
  key: string;
  message: string;
  code: string | null;
}

export type PaperSize = 'auto' | 'letter' | 'legal' | 'tabloid' | 'a3' | 'a4' | 'a5';

/** Every paper size the dialog offers, in dropdown order. Mirrors the device
 * layer's own list, which is where the dimensions live. */
export const PAPER_SIZES: readonly PaperSize[] = [
  'auto',
  'letter',
  'legal',
  'tabloid',
  'a3',
  'a4',
  'a5',
];

/** What the dialog sends. Every field is optional: a control the device did
 * not report is a control that did not render, so its setting is absent
 * rather than guessed. */
export interface ScanSettings {
  item_name?: string;
  dpi?: number;
  color_mode?: ColorMode;
  paper?: PaperSize;
  pages?: number;
  document_handling?: number;
  brightness?: number;
  contrast?: number;
}

export interface PropertyAdjustment {
  property: string;
  requested: number;
  actual: number | null;
}

export interface ScanResult {
  pages: string[];
  cancelled: boolean;
  scratch: string;
  /** The resolution actually in force, read back after the write. This is
   * what `create_pdf`'s `image_dpi_default` is set from, so a driver that
   * wrote no resolution header still produces correctly sized pages. */
  dpi: number;
  adjusted: PropertyAdjustment[];
  bytes: number;
}

export type ScanEvent =
  | { kind: 'warming' }
  | { kind: 'pageStarted'; index: number }
  | { kind: 'progress'; index: number; percent: number }
  | { kind: 'pageFinished'; index: number; path: string }
  | { kind: 'deviceStatus'; code: string }
  | { kind: 'sizeWarning'; bytes: number };

// ── Refusals ────────────────────────────────────────────────────────────────

/**
 * Every catalog key the device layer can refuse with.
 *
 * Pinned against the Rust table by `tests/fixtures/scan-refusal-keys.json`,
 * which both suites read: a key the device layer can produce and the catalog
 * has no row for renders as its own name, and nothing else would notice.
 */
export const SCAN_REFUSAL_KEYS: readonly string[] = [
  'scan.busy',
  'scan.cancelledAtDevice',
  'scan.coverOpen',
  'scan.deviceBusy',
  'scan.deviceGone',
  'scan.deviceLocked',
  'scan.deviceOffline',
  'scan.driverError',
  'scan.failed',
  'scan.feederEmpty',
  'scan.needsAttention',
  'scan.notResponding',
  'scan.paperJam',
  'scan.paperProblem',
  'scan.settingRejected',
];

/** Is this thrown value one of the device layer's structured refusals? */
export function isScanRefusal(value: unknown): value is ScanRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ScanRefusal>;
  return typeof candidate.key === 'string' && typeof candidate.message === 'string';
}

/**
 * The catalog key to render a thrown value with, or `null` when the value is
 * not a refusal this catalog names.
 *
 * A refusal whose key the catalog does not carry falls back to its English
 * sentence rather than rendering the key itself — an unknown key is a bug,
 * and showing the user "scan.somethingNew" would be a worse one.
 */
export function refusalKey(value: unknown): string | null {
  if (!isScanRefusal(value)) return null;
  return SCAN_REFUSAL_KEYS.includes(value.key) ? `refusal.${value.key}` : null;
}

/** The English fallback for a thrown value: a refusal's own sentence, an
 * Error's message, or the value's text. */
export function refusalText(value: unknown): string {
  if (isScanRefusal(value)) return value.message;
  return value instanceof Error ? value.message : String(value);
}

// ── Control derivation ──────────────────────────────────────────────────────

/**
 * How many values a range may be enumerated into before a dropdown stops
 * being a dropdown. A 75–4800 range in steps of one is 4726 options, which is
 * a list nobody can use; past this the control is a bounded number field
 * carrying the device's own min, max and step instead.
 */
export const MAX_ENUMERATED_STEPS = 64;

export type NumericControl =
  | { kind: 'absent' }
  | { kind: 'fixed'; value: number }
  | { kind: 'choice'; values: number[]; current: number | null }
  | { kind: 'number'; min: number; max: number; step: number; current: number | null };

/**
 * One numeric control from one reported property.
 *
 * A listed property renders exactly its values. A range renders the range's
 * OWN steps while they are few enough to pick from, and a bounded number
 * field when they are not — either way the user cannot choose a value the
 * device did not say it accepts.
 */
export function numericControl(model: ControlModel): NumericControl {
  switch (model.kind) {
    case 'absent':
      return { kind: 'absent' };
    case 'fixed':
      return { kind: 'fixed', value: model.value };
    case 'choice':
      return model.values.length === 0
        ? { kind: 'absent' }
        : { kind: 'choice', values: [...model.values].sort((a, b) => a - b), current: model.current };
    case 'span': {
      const step = model.step > 0 ? model.step : 1;
      const count = Math.floor((model.max - model.min) / step) + 1;
      if (count <= 1) return { kind: 'fixed', value: model.min };
      if (count > MAX_ENUMERATED_STEPS) {
        return { kind: 'number', min: model.min, max: model.max, step, current: model.current };
      }
      const values: number[] = [];
      for (let v = model.min; v <= model.max; v += step) values.push(v);
      return { kind: 'choice', values, current: model.current };
    }
    // A bitmask is not a numeric control; the source picker reads it.
    case 'flags':
      return { kind: 'absent' };
  }
}

/** The value a numeric control should start on: the device's own current
 * value when it is one the control offers, else the control's own first
 * offer. `null` when the control offers nothing to choose. */
export function initialValue(control: NumericControl): number | null {
  switch (control.kind) {
    case 'absent':
      return null;
    case 'fixed':
      return control.value;
    case 'choice':
      return control.current !== null && control.values.includes(control.current)
        ? control.current
        : (control.values[0] ?? null);
    case 'number':
      return control.current !== null &&
        control.current >= control.min &&
        control.current <= control.max
        ? control.current
        : control.min;
  }
}

/**
 * The resolution a dialog opens on.
 *
 * The device's own current value where the control offers it, and otherwise
 * the offered value nearest 300 dpi — the resolution a document scan wants,
 * chosen from what the device HAS rather than written over it.
 */
export const PREFERRED_DPI = 300;

export function initialDpi(control: NumericControl): number | null {
  if (control.kind === 'choice') {
    const current = control.current;
    if (current !== null && control.values.includes(current)) return current;
    let best = control.values[0] ?? null;
    for (const value of control.values) {
      if (best === null) {
        best = value;
      } else if (Math.abs(value - PREFERRED_DPI) < Math.abs(best - PREFERRED_DPI)) {
        best = value;
      }
    }
    return best;
  }
  if (control.kind === 'number') {
    if (control.current !== null && control.current >= control.min && control.current <= control.max) {
      return control.current;
    }
    return Math.min(control.max, Math.max(control.min, PREFERRED_DPI));
  }
  return initialValue(control);
}

/** One row of the source picker, exactly as the device layer reported it. */
export interface ScanSourceOption {
  id: 'flatbed' | 'feeder' | 'duplex';
  /** The item the transfer runs against. */
  item_name: string;
  /** The `WIA_IPS_DOCUMENT_HANDLING_SELECT` value this row writes, or `null`
   * where the device reports no such property to write. */
  document_handling: number | null;
  /** Does this row feed sheets, i.e. can it produce more than one page in one
   * run? Only a feeder makes a page count meaningful. */
  feeds: boolean;
}

/**
 * The sources this device offers, in picker order.
 *
 * Read from the report, never re-derived: the dialog and the CLI arm would
 * otherwise be two answers to "which sources does this device have", and the
 * one that is wrong offers duplex on a flatbed or scans the wrong side of a
 * sheet. The device layer owns the rule; this is the accessor.
 */
export function sourceOptions(capabilities: ScannerCapabilities): ScanSourceOption[] {
  return capabilities.source_options;
}

/** The report for one picker row, which is where its own resolution, colour
 * and brightness controls come from. */
export function reportFor(
  capabilities: ScannerCapabilities,
  option: ScanSourceOption | null,
): ScanSourceReport | null {
  if (!option) return capabilities.sources[0] ?? null;
  return (
    capabilities.sources.find((s) => s.item_name === option.item_name) ??
    capabilities.sources[0] ??
    null
  );
}

/** The colour mode a dialog opens on: the device's own current data type
 * where it is one of the offered modes, else colour, else the first offered.
 * Never a mode the device did not list. */
export function initialColorMode(modes: readonly ColorMode[]): ColorMode | null {
  if (modes.length === 0) return null;
  if (modes.includes('color')) return 'color';
  return modes[0];
}

/**
 * Is "every page in the feeder" a thing this source can be asked for?
 *
 * `WIA_IPS_PAGES = 0` means "until the feeder empties". A device whose page
 * property will not take zero cannot be asked, so the dialog must not offer
 * it — it would silently scan one page.
 */
export function offersAllPages(option: ScanSourceOption | null, pages: ControlModel): boolean {
  if (!option?.feeds) return false;
  switch (pages.kind) {
    case 'choice':
      return pages.values.includes(0);
    case 'span':
      return pages.min <= 0;
    case 'fixed':
      return pages.value === 0;
    default:
      return false;
  }
}

/** The largest page count this source will take, or `null` for no stated
 * limit. */
export function maxPages(pages: ControlModel): number | null {
  switch (pages.kind) {
    case 'choice':
      return pages.values.length > 0 ? Math.max(...pages.values) : null;
    case 'span':
      return pages.max;
    default:
      return null;
  }
}

/** What the dialog currently holds, before it becomes wire settings. */
export interface ScanFormState {
  option: ScanSourceOption | null;
  dpi: number | null;
  colorMode: ColorMode | null;
  paper: PaperSize;
  allPages: boolean;
  pageCount: number;
  brightness: number | null;
  contrast: number | null;
}

/**
 * The settings the device layer is sent.
 *
 * A control that did not render contributes nothing: an absent field leaves
 * the device's own value alone, which is not the same as writing a default
 * over it.
 */
export function toScanSettings(form: ScanFormState): ScanSettings {
  const settings: ScanSettings = {};
  if (form.option) {
    settings.item_name = form.option.item_name;
    if (form.option.document_handling !== null) {
      settings.document_handling = form.option.document_handling;
    }
    settings.pages = form.allPages ? 0 : Math.max(1, Math.trunc(form.pageCount));
  }
  if (form.dpi !== null) settings.dpi = form.dpi;
  if (form.colorMode !== null) settings.color_mode = form.colorMode;
  if (form.paper !== 'auto') settings.paper = form.paper;
  if (form.brightness !== null) settings.brightness = form.brightness;
  if (form.contrast !== null) settings.contrast = form.contrast;
  return settings;
}

/**
 * Is this resolution interpolated rather than optical?
 *
 * A device with a 1200-dpi optical sensor that offers 4800 dpi is upsampling,
 * and a user choosing 4800 for OCR is choosing four times the file for no
 * more detail. The marker says so; it never blocks the choice.
 */
export function isInterpolated(dpi: number | null, optical: number | null): boolean {
  return dpi !== null && optical !== null && optical > 0 && dpi > optical;
}

// ── Staged pages ────────────────────────────────────────────────────────────

/** One acquired page, as the review list holds it. */
export interface ScanPage {
  /** Stable across removals, so a React key and a preview survive a delete. */
  id: string;
  path: string;
  /** The run that staged it — its scratch folder is discarded when the last
   * page from that run is gone or the dialog is cancelled. */
  scratch: string;
}

let nextPageId = 0;

export function pagesFromResult(result: ScanResult): ScanPage[] {
  return result.pages.map((path) => ({ id: `p${++nextPageId}`, path, scratch: result.scratch }));
}

export function removePage(pages: readonly ScanPage[], id: string): ScanPage[] {
  return pages.filter((p) => p.id !== id);
}

/** Every scratch folder the staged pages still live in. Discarding one whose
 * pages are all gone would delete files a later run still holds, so the set
 * is derived from the pages rather than tracked beside them. */
export function liveScratches(pages: readonly ScanPage[]): string[] {
  return [...new Set(pages.map((p) => p.scratch))];
}

/**
 * The default output name for a run's pages: the destination dialog's
 * suggestion. Named for the scan rather than for a scratch file, whose name
 * is an implementation detail nobody chose.
 */
export function defaultScanOutputName(): string {
  return 'scan.pdf';
}

/** How large a staged page may be before the review list stops previewing it.
 * A preview reads the whole file into the webview, and an uncompressed
 * 600-dpi colour A3 page is roughly 400 MB — a preview that large is a
 * hang, not a thumbnail. */
export const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
