import { describe, it, expect } from 'vitest';
import { isAppTextCopy } from '../src/renderer/lib/copy-guard';

// A stand-in for a DOM element: `closest` answers for the guide's marker only.
const inGuide = { closest: (selector: string) => (selector === '[data-app-text]' ? {} : null) };
const inDocument = { closest: () => null };

describe('copy guard exemption for application text', () => {
  it('lets a selection wholly inside the guide be copied', () => {
    expect(isAppTextCopy(inGuide, [])).toBe(true);
  });

  it('never exempts a selection that holds PDF pages, wherever focus is', () => {
    expect(isAppTextCopy(inGuide, ['page-1'])).toBe(false);
  });

  it('does not exempt the document itself', () => {
    expect(isAppTextCopy(inDocument, [])).toBe(false);
  });

  it('ignores a target that is not an element', () => {
    expect(isAppTextCopy(null, [])).toBe(false);
    expect(isAppTextCopy({}, [])).toBe(false);
    expect(isAppTextCopy('text', [])).toBe(false);
  });
});
