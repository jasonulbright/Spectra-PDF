import { describe, it, expect } from 'vitest';
import {
  STATUS_PAGE_FIELD_MAX_CH,
  STATUS_PAGE_FIELD_MIN_PX,
  statusPageFieldWidth,
} from '../src/renderer/components/canvas/status-page-width';

const chOf = (css: string): number => Number(/calc\((\d+)ch/.exec(css)?.[1]);

describe('statusPageFieldWidth', () => {
  it('never falls below the numeric box', () => {
    expect(statusPageFieldWidth('1', 2)).toContain(`max(${STATUS_PAGE_FIELD_MIN_PX}px,`);
  });

  it('fits a page label longer than the page number', () => {
    // A five-letter label in a two-page document: the label sets the width.
    expect(chOf(statusPageFieldWidth('Edits', 2))).toBe(6);
    expect(chOf(statusPageFieldWidth('iv', 20))).toBe(3);
  });

  it('fits the widest page number of the document while a short value shows', () => {
    expect(chOf(statusPageFieldWidth('7', 12345))).toBe(6);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(chOf(statusPageFieldWidth('𝐀𝐁', 1))).toBe(3);
  });

  it('stops growing at the cap', () => {
    expect(chOf(statusPageFieldWidth('x'.repeat(200), 2))).toBe(STATUS_PAGE_FIELD_MAX_CH);
  });
});
