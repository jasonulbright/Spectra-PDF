// The scan dialog's control DERIVATION, proven without a DOM.
//
// The rule every case here defends: a control offers exactly what the device
// reported and nothing else. A resolution dropdown with a value the device
// never listed is a control that lies; a duplex row on a flatbed is a control
// that refuses. There is no DOM test environment in this repo, which is why
// the derivation lives in `lib/scan.ts` rather than inside the component.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REFUSAL_STRINGS } from '../src/renderer/i18n-refusals';
import {
  MAX_ENUMERATED_STEPS,
  PREFERRED_DPI,
  SCAN_REFUSAL_KEYS,
  initialColorMode,
  initialDpi,
  initialValue,
  isInterpolated,
  isScanRefusal,
  liveScratches,
  maxPages,
  numericControl,
  offersAllPages,
  pagesFromResult,
  refusalKey,
  refusalText,
  removePage,
  reportFor,
  sourceOptions,
  toScanSettings,
  type ControlModel,
  type ScanSourceOption,
  type ScanSourceReport,
  type ScannerCapabilities,
  type SourceCategory,
} from '../src/renderer/lib/scan';

function source(
  category: SourceCategory,
  over: Partial<ScanSourceReport> = {},
): ScanSourceReport {
  return {
    item_name: `Root\\${category}`,
    category,
    properties: [],
    resolution: { kind: 'absent' },
    optical_resolution: null,
    color_modes: [],
    brightness: { kind: 'absent' },
    contrast: { kind: 'absent' },
    pages: { kind: 'absent' },
    document_handling_select: { kind: 'flags', valid: 7, current: 1 },
    ...over,
  };
}

function device(
  sources: ScanSourceReport[],
  options: ScanSourceOption[] = [],
  handling: Partial<ScannerCapabilities['document_handling']> = {},
): ScannerCapabilities {
  return {
    device_id: 'dev',
    device_name: 'A Scanner',
    max_scan_time_ms: 60000,
    source_options: options,
    sources,
    document_handling: {
      capabilities: 0,
      flatbed: false,
      feeder: false,
      duplex: false,
      advanced_duplex: false,
      duplex_mode: 'none',
      flatbed_select: 2,
      feeder_select: 1,
      duplex_select: 5,
      ...handling,
    },
  };
}

describe('numeric controls come from the reported property', () => {
  it('a listed property offers exactly its values, sorted', () => {
    const model: ControlModel = { kind: 'choice', values: [600, 100, 300], current: 300 };
    expect(numericControl(model)).toEqual({
      kind: 'choice',
      values: [100, 300, 600],
      current: 300,
    });
  });

  it('a narrow range becomes the range’s OWN steps, not a made-up list', () => {
    // 75–300 in steps of 75 is four values, and they are the four the device
    // named — never the 100/200/300/600 a hard-coded dropdown would offer.
    expect(numericControl({ kind: 'span', min: 75, max: 300, step: 75, current: 150 })).toEqual({
      kind: 'choice',
      values: [75, 150, 225, 300],
      current: 150,
    });
  });

  it('a range too wide to pick from becomes a bounded number field', () => {
    // A 75–4800 range in steps of one is 4726 options: a list nobody can use.
    const control = numericControl({ kind: 'span', min: 75, max: 4800, step: 1, current: 300 });
    expect(control).toEqual({ kind: 'number', min: 75, max: 4800, step: 1, current: 300 });
    // The boundary is the cap itself, on both sides of it.
    const atCap = numericControl({
      kind: 'span',
      min: 1,
      max: MAX_ENUMERATED_STEPS,
      step: 1,
      current: 1,
    });
    expect(atCap.kind).toBe('choice');
    const overCap = numericControl({
      kind: 'span',
      min: 1,
      max: MAX_ENUMERATED_STEPS + 1,
      step: 1,
      current: 1,
    });
    expect(overCap.kind).toBe('number');
  });

  it('a property with one value, or none, renders no picker', () => {
    expect(numericControl({ kind: 'fixed', value: 300 })).toEqual({ kind: 'fixed', value: 300 });
    expect(numericControl({ kind: 'span', min: 300, max: 300, step: 1, current: 300 })).toEqual({
      kind: 'fixed',
      value: 300,
    });
    expect(numericControl({ kind: 'choice', values: [], current: null })).toEqual({
      kind: 'absent',
    });
    expect(numericControl({ kind: 'absent' })).toEqual({ kind: 'absent' });
    // A bitmask is the source picker's business, not a numeric control's.
    expect(numericControl({ kind: 'flags', valid: 7, current: 1 })).toEqual({ kind: 'absent' });
  });

  it('a zero or negative step still spans, one unit at a time', () => {
    expect(numericControl({ kind: 'span', min: 0, max: 10, step: 0, current: 5 })).toEqual({
      kind: 'choice',
      values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      current: 5,
    });
  });
});

describe('the value a control opens on', () => {
  it('is the device’s own current value when the control offers it', () => {
    expect(initialValue({ kind: 'choice', values: [100, 200, 300], current: 200 })).toBe(200);
    expect(initialDpi({ kind: 'choice', values: [100, 200, 300], current: 200 })).toBe(200);
  });

  it('falls back to the OFFERED value nearest the document resolution', () => {
    // Never 300 itself where 300 is not on offer: the fallback picks from
    // what the device has.
    expect(initialDpi({ kind: 'choice', values: [75, 150, 600], current: null })).toBe(150);
    expect(initialDpi({ kind: 'choice', values: [1200, 2400], current: null })).toBe(1200);
    expect(initialDpi({ kind: 'number', min: 50, max: 1200, step: 1, current: null })).toBe(
      PREFERRED_DPI,
    );
    // A range that does not reach the preferred resolution clamps into it.
    expect(initialDpi({ kind: 'number', min: 50, max: 150, step: 1, current: null })).toBe(150);
  });

  it('ignores a current value the control does not offer', () => {
    expect(initialValue({ kind: 'choice', values: [100, 200], current: 9999 })).toBe(100);
    expect(initialValue({ kind: 'number', min: 0, max: 10, step: 1, current: 99 })).toBe(0);
    expect(initialValue({ kind: 'absent' })).toBeNull();
  });
});

describe('the source picker is read from the report, not re-derived', () => {
  const flatbedRow: ScanSourceOption = {
    id: 'flatbed',
    item_name: 'Root\\flatbed',
    document_handling: 2,
    feeds: false,
  };
  const feederRow: ScanSourceOption = {
    id: 'feeder',
    item_name: 'Root\\feeder',
    document_handling: 1,
    feeds: true,
  };
  const duplexRow: ScanSourceOption = {
    id: 'duplex',
    item_name: 'Root\\feeder',
    document_handling: 5,
    feeds: true,
  };

  it('offers exactly the rows the device layer reported', () => {
    // Which sources a device has is answered ONCE, in the device layer, so
    // the dialog and the CLI arm cannot disagree about what "duplex" means.
    const caps = device([source('flatbed'), source('feeder')], [flatbedRow, feederRow, duplexRow]);
    expect(sourceOptions(caps)).toEqual([flatbedRow, feederRow, duplexRow]);
    // A device with no reported row offers none, rather than a guess.
    expect(sourceOptions(device([source('flatbed')], []))).toEqual([]);
  });

  it('resolves a row back to its own per-source report', () => {
    const flatbed = source('flatbed', { color_modes: ['color'] });
    const feeder = source('feeder', { color_modes: ['grayscale'] });
    const caps = device([flatbed, feeder], [flatbedRow, feederRow]);
    expect(reportFor(caps, feederRow)?.color_modes).toEqual(['grayscale']);
    expect(reportFor(caps, flatbedRow)?.color_modes).toEqual(['color']);
    // No row at all still answers with something transferable.
    expect(reportFor(caps, null)?.item_name).toBe(flatbed.item_name);
    // A row naming an item the report no longer carries falls back rather
    // than leaving the dialog with no controls at all.
    expect(reportFor(caps, { ...feederRow, item_name: 'Root\\gone' })?.item_name).toBe(
      flatbed.item_name,
    );
  });
});

describe('the page count', () => {
  const feederRow = { id: 'feeder' as const, item_name: 'f', document_handling: 1, feeds: true };
  const flatbedRow = { id: 'flatbed' as const, item_name: 'g', document_handling: 2, feeds: false };

  it('offers "all pages" only where the device takes zero for it', () => {
    expect(offersAllPages(feederRow, { kind: 'span', min: 0, max: 99, step: 1, current: 0 })).toBe(
      true,
    );
    expect(offersAllPages(feederRow, { kind: 'choice', values: [0, 1, 2], current: 0 })).toBe(true);
    // A device whose page property will not take zero would silently scan one
    // page, so the offer must not appear.
    expect(offersAllPages(feederRow, { kind: 'span', min: 1, max: 99, step: 1, current: 1 })).toBe(
      false,
    );
    expect(offersAllPages(feederRow, { kind: 'absent' })).toBe(false);
  });

  it('is never offered on a source that cannot feed sheets', () => {
    expect(offersAllPages(flatbedRow, { kind: 'span', min: 0, max: 99, step: 1, current: 0 })).toBe(
      false,
    );
    expect(offersAllPages(null, { kind: 'span', min: 0, max: 99, step: 1, current: 0 })).toBe(false);
  });

  it('reports the device’s own upper limit, or none', () => {
    expect(maxPages({ kind: 'span', min: 0, max: 50, step: 1, current: 0 })).toBe(50);
    expect(maxPages({ kind: 'choice', values: [1, 10, 5], current: 1 })).toBe(10);
    expect(maxPages({ kind: 'absent' })).toBeNull();
  });
});

describe('the settings sent to the device', () => {
  const form = {
    option: { id: 'feeder' as const, item_name: 'Root\\feeder', document_handling: 1, feeds: true },
    dpi: 300,
    colorMode: 'color' as const,
    paper: 'letter' as const,
    allPages: true,
    pageCount: 1,
    brightness: 0,
    contrast: null,
  };

  it('carry only what a rendered control actually chose', () => {
    expect(toScanSettings(form)).toEqual({
      item_name: 'Root\\feeder',
      document_handling: 1,
      pages: 0,
      dpi: 300,
      color_mode: 'color',
      paper: 'letter',
      brightness: 0,
    });
    // A control that did not render leaves the device's own value alone,
    // which is not the same as writing a default over it.
    expect('contrast' in toScanSettings(form)).toBe(false);
  });

  it('leave the scan area alone when the whole bed was asked for', () => {
    const settings = toScanSettings({ ...form, paper: 'auto' });
    expect('paper' in settings).toBe(false);
  });

  it('turn a page limit into a page count of at least one', () => {
    expect(toScanSettings({ ...form, allPages: false, pageCount: 5 }).pages).toBe(5);
    expect(toScanSettings({ ...form, allPages: false, pageCount: 0 }).pages).toBe(1);
    expect(toScanSettings({ ...form, allPages: false, pageCount: 2.7 }).pages).toBe(2);
  });

  it('write nothing about a source the device never offered', () => {
    const settings = toScanSettings({ ...form, option: null });
    expect('item_name' in settings).toBe(false);
    expect('pages' in settings).toBe(false);
  });
});

describe('reported facts the dialog only marks', () => {
  it('names an interpolated resolution without blocking it', () => {
    expect(isInterpolated(4800, 1200)).toBe(true);
    expect(isInterpolated(1200, 1200)).toBe(false);
    expect(isInterpolated(600, 1200)).toBe(false);
    // A device that reports no optical resolution claims nothing either way.
    expect(isInterpolated(4800, null)).toBe(false);
    expect(isInterpolated(4800, 0)).toBe(false);
  });

  it('opens on colour where the device lists it, and never invents a mode', () => {
    expect(initialColorMode(['black_and_white', 'grayscale', 'color'])).toBe('color');
    expect(initialColorMode(['black_and_white', 'grayscale'])).toBe('black_and_white');
    expect(initialColorMode([])).toBeNull();
  });
});

describe('the staged page list', () => {
  it('keeps a page identity a removal cannot disturb', () => {
    const pages = pagesFromResult({
      pages: ['a.bmp', 'b.bmp', 'c.bmp'],
      cancelled: false,
      scratch: 'S1',
      dpi: 300,
      adjusted: [],
      bytes: 0,
    });
    expect(pages.map((p) => p.path)).toEqual(['a.bmp', 'b.bmp', 'c.bmp']);
    const kept = removePage(pages, pages[1].id);
    expect(kept.map((p) => p.path)).toEqual(['a.bmp', 'c.bmp']);
    // Ids stay attached to the pages that survived.
    expect(kept[1].id).toBe(pages[2].id);
  });

  it('derives the live scratch folders from the pages that remain', () => {
    const first = pagesFromResult({
      pages: ['a.bmp'],
      cancelled: false,
      scratch: 'S1',
      dpi: 300,
      adjusted: [],
      bytes: 0,
    });
    const second = pagesFromResult({
      pages: ['b.bmp', 'c.bmp'],
      cancelled: true,
      scratch: 'S2',
      dpi: 300,
      adjusted: [],
      bytes: 0,
    });
    const all = [...first, ...second];
    expect(liveScratches(all)).toEqual(['S1', 'S2']);
    // Dropping every page of one run drops its folder from the set, and a
    // folder another run still holds pages in is never dropped.
    expect(liveScratches(removePage(all, first[0].id))).toEqual(['S2']);
    expect(liveScratches(removePage(all, second[0].id))).toEqual(['S1', 'S2']);
  });
});

describe('refusals resolve through the catalog, never as a raw key', () => {
  it('recognises a structured refusal and renders its own key', () => {
    const refusal = { key: 'scan.feederEmpty', message: 'Put paper in the feeder.', code: null };
    expect(isScanRefusal(refusal)).toBe(true);
    expect(refusalKey(refusal)).toBe('refusal.scan.feederEmpty');
    expect(refusalText(refusal)).toBe('Put paper in the feeder.');
  });

  it('falls back to English rather than showing a key the catalog lacks', () => {
    const unknown = { key: 'scan.somethingNew', message: 'Something new happened.', code: null };
    expect(refusalKey(unknown)).toBeNull();
    expect(refusalText(unknown)).toBe('Something new happened.');
    // An ordinary Error is not a refusal, and `String(e)` on a refusal would
    // have produced "[object Object]" — hence reading the fields.
    expect(isScanRefusal(new Error('boom'))).toBe(false);
    expect(refusalKey(new Error('boom'))).toBeNull();
    expect(refusalText(new Error('boom'))).toBe('boom');
    expect(refusalText('plain')).toBe('plain');
    expect(isScanRefusal(null)).toBe(false);
  });

  it('every key the device layer can refuse with has a catalog row', () => {
    // The other half of the cross-language pin the Rust suite reads: the
    // fixture lists what the device layer produces, and every one of those
    // must resolve to a sentence here.
    const fixture: string[] = JSON.parse(
      readFileSync(resolve(__dirname, 'fixtures/scan-refusal-keys.json'), 'utf8'),
    );
    expect([...SCAN_REFUSAL_KEYS].sort()).toEqual([...fixture].sort());
    for (const key of fixture) {
      expect(
        (REFUSAL_STRINGS as Record<string, string>)[`refusal.${key}`],
        `refusal.${key} has no catalog row`,
      ).toBeTruthy();
    }
  });
});
