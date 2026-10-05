import { describe, it, expect } from 'vitest';
import { TAB_TAIL, splitTabLabel } from '../src/renderer/components/tab-label';

describe('splitTabLabel', () => {
  it('keeps the distinguishing end of a long name in the tail', () => {
    expect(splitTabLabel('comment-summary-lahuc2summary-1.pdf')).toEqual({
      head: 'comment-summary-lahuc2summary',
      tail: '-1.pdf',
    });
  });

  it('tells a series apart by the tail', () => {
    const tails = ['summary-report-1.pdf', 'summary-report-2.pdf'].map((n) => splitTabLabel(n).tail);
    expect(tails[0]).not.toBe(tails[1]);
  });

  it('does not split a short name', () => {
    expect(splitTabLabel('alpha.pdf')).toEqual({ head: 'alpha.pdf', tail: '' });
  });

  it('loses no character and splits on code points', () => {
    const name = '𝐀𝐁𝐂-report-final-2.pdf';
    const { head, tail } = splitTabLabel(name);
    expect(head + tail).toBe(name);
    expect(Array.from(tail)).toHaveLength(TAB_TAIL);
  });
});
