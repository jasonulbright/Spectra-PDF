import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { ReadingViewControls } from '../src/renderer/components/canvas/ReadingViewControls';
import { CanvasStatusBar } from '../src/renderer/components/canvas/CanvasStatusBar';
import {
  __resetReadingViewStore,
  publishReadingView,
  setActiveReadingPane,
} from '../src/renderer/lib/reading-view-store';
import type { ReadingViewSnapshot } from '../src/renderer/lib/reading-view-types';

const PATH = 'C:\\docs\\a.pdf';

function snap(over: Partial<ReadingViewSnapshot> = {}): ReadingViewSnapshot {
  return {
    zoomMode: 'fitPage',
    zoomPercent: 125,
    layoutMode: 'single',
    coverAlone: false,
    scrollMode: 'continuous',
    page: 1,
    columns: 1,
    pageCount: 5,
    docIndex: 0,
    ...over,
  };
}

/** The opening tag of the element carrying `testid`. */
function tagOf(html: string, testid: string): string {
  const m = new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>`).exec(html);
  if (!m) throw new Error(`no element with data-testid="${testid}"`);
  return m[0];
}

const CONTROL_IDS = [
  'reading-zoom-out',
  'reading-zoom-percent',
  'reading-zoom-in',
  'reading-fit-menu',
  'reading-layout-single',
  'reading-layout-grid',
  'reading-scroll-continuous',
  'reading-scroll-paged',
];

function statusBar(docViewMode: 'document' | 'organize'): string {
  const noop = (): void => {};
  return renderToString(
    createElement(CanvasStatusBar, {
      docViewMode,
      onToggleView: noop,
      showComments: false,
      onToggleComments: noop,
      pageBox: null,
      onZoomOut: noop,
      onFit: noop,
      onZoomIn: noop,
      dirty: false,
      onApplyPageEdits: noop,
      pendingFormCount: 0,
      fillingForms: false,
      onApplyForms: noop,
      onClearForms: noop,
      markCount: 0,
      redacting: false,
      onApplyRedact: noop,
      onClearRedact: noop,
      savingMarks: false,
      onSaveRedact: noop,
    }),
  );
}

describe('reading view controls', () => {
  beforeEach(() => {
    __resetReadingViewStore();
  });

  it('every control is disabled while no reading pane has published a view', () => {
    const html = renderToString(createElement(ReadingViewControls));
    for (const id of CONTROL_IDS) expect(tagOf(html, id), id).toMatch(/\sdisabled=""/);
  });

  it('shows the active pane: percent through Intl, pressed layout and scroll, fitted Fit', () => {
    publishReadingView(PATH, 'a', snap({ zoomPercent: 1250, layoutMode: 'grid', scrollMode: 'paged' }));
    setActiveReadingPane(PATH, 'a');
    const html = renderToString(createElement(ReadingViewControls));
    for (const id of CONTROL_IDS) expect(tagOf(html, id), id).not.toMatch(/\sdisabled=""/);
    const shown = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 }).format(12.5);
    expect(tagOf(html, 'reading-zoom-percent')).toContain(`value="${shown}"`);
    expect(tagOf(html, 'reading-layout-grid')).toContain('aria-pressed="true"');
    expect(tagOf(html, 'reading-layout-single')).toContain('aria-pressed="false"');
    expect(tagOf(html, 'reading-scroll-paged')).toContain('aria-pressed="true"');
    expect(tagOf(html, 'reading-scroll-continuous')).toContain('aria-pressed="false"');
    expect(tagOf(html, 'reading-fit-menu')).toMatch(/class="[^"]*\bactive\b/);
  });

  it('a custom zoom leaves Fit unlit', () => {
    publishReadingView(PATH, 'a', snap({ zoomMode: 'custom' }));
    setActiveReadingPane(PATH, 'a');
    const html = renderToString(createElement(ReadingViewControls));
    expect(tagOf(html, 'reading-fit-menu')).not.toMatch(/class="[^"]*\bactive\b/);
  });

  it('follows the active pane, not the last publisher', () => {
    publishReadingView(PATH, 'a', snap({ layoutMode: 'single' }));
    publishReadingView(PATH, 'b', snap({ layoutMode: 'grid' }));
    setActiveReadingPane(PATH, 'a');
    const html = renderToString(createElement(ReadingViewControls));
    expect(tagOf(html, 'reading-layout-single')).toContain('aria-pressed="true"');
  });

  it('the steppers keep the titles the zoom buttons have always had', () => {
    const html = renderToString(createElement(ReadingViewControls));
    expect(tagOf(html, 'reading-zoom-in')).toContain('title="Zoom in"');
    expect(tagOf(html, 'reading-zoom-out')).toContain('title="Zoom out"');
  });

  it('the status bar offers the group in the reading view only; the board never offers layout or scroll', () => {
    const reading = statusBar('document');
    expect(reading).toContain('data-testid="reading-layout-grid"');
    expect(reading).toContain('data-testid="reading-scroll-paged"');
    const board = statusBar('organize');
    for (const id of CONTROL_IDS) expect(board).not.toContain(`data-testid="${id}"`);
    expect(board).toContain('title="Zoom in"');
    expect(board).toContain('title="Fit to view"');
  });
});
