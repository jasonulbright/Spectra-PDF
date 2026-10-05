import { describe, it, expect } from 'vitest';
import { TAB_SPLIT_MIN, TAB_TAIL, splitTabLabel, tabLabelLayout } from '../src/renderer/components/tab-label';

describe('splitTabLabel', () => {
  it('keeps the distinguishing end of a long name in the tail', () => {
    expect(splitTabLabel('comment-summary-lahuc2summary-1.pdf')).toEqual({
      head: 'comment-summary-lahuc2summary',
      tail: '-1.pdf',
    });
  });

  it('keeps a trailing number with the extension', () => {
    expect(splitTabLabel('quarterly-report-2024-3.pdf')).toEqual({
      head: 'quarterly-report-2024',
      tail: '-3.pdf',
    });
  });

  it('tells a series apart by the tail', () => {
    const tails = ['summary-report-1.pdf', 'summary-report-2.pdf'].map((n) => splitTabLabel(n).tail);
    expect(tails[0]).not.toBe(tails[1]);
  });

  it('does not split a short name', () => {
    expect(splitTabLabel('alpha.pdf')).toEqual({ head: 'alpha.pdf', tail: '' });
  });

  it('loses no character and counts astral letters as one each', () => {
    const name = 'report-final-version-𝐀𝐁𝐂.pdf';
    const { head, tail } = splitTabLabel(name);
    expect(head + tail).toBe(name);
    expect(tail).toBe('𝐁𝐂.pdf');
    expect(Array.from(tail)).toHaveLength(TAB_TAIL);
  });

  it('keeps a ZWJ emoji sequence whole', () => {
    const family = '\u{1F469}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
    const name = `holiday-album-${family}.pdf`;
    const { head, tail } = splitTabLabel(name);
    expect(head + tail).toBe(name);
    expect(head).toBe('holiday-album');
    expect(tail).toBe(`-${family}.pdf`);
  });

  it('keeps a flag whole', () => {
    const flag = '\u{1F1EF}\u{1F1F5}';
    const name = `travel-diary-${flag}abcde`;
    const { head, tail } = splitTabLabel(name);
    expect(head + tail).toBe(name);
    expect(tail).toBe(`${flag}abcde`);
  });

  it('keeps a combining mark with its base letter', () => {
    const name = 'resume-final-café.pdf';
    const { head, tail } = splitTabLabel(name);
    expect(head).toBe('resume-final-ca');
    expect(tail).toBe('fé.pdf');
  });

  it('does not split an Arabic name', () => {
    const name = 'تقرير المبيعات السنوي النهائي.pdf';
    expect(splitTabLabel(name)).toEqual({ head: name, tail: '' });
  });

  it('does not split a Devanagari name with combining marks', () => {
    const name = 'वार्षिक रिपोर्ट अंतिम संस्करण.pdf';
    expect(splitTabLabel(name)).toEqual({ head: name, tail: '' });
  });
});

describe('tabLabelLayout', () => {
  it('splits a long Latin name and keeps the tail whole', () => {
    expect(tabLabelLayout('summary-1.pdf')).toEqual({ kind: 'split', head: 'summary', tail: '-1.pdf' });
  });

  it('never cuts a short name', () => {
    expect(tabLabelLayout('report.pdf')).toEqual({ kind: 'whole', head: 'report.pdf', tail: '' });
    expect(tabLabelLayout('abcdefgh.pdf')).toEqual({ kind: 'whole', head: 'abcdefgh.pdf', tail: '' });
  });

  it('clips a long shaped-script name at its end, unsplit', () => {
    const arabic = 'تقرير المبيعات السنوي النهائي.pdf';
    expect(tabLabelLayout(arabic)).toEqual({ kind: 'clip', head: arabic, tail: '' });
    const devanagari = 'वार्षिक रिपोर्ट अंतिम संस्करण.pdf';
    expect(tabLabelLayout(devanagari).kind).toBe('clip');
  });

  it('keeps a short shaped-script name whole', () => {
    expect(tabLabelLayout('تقرير.pdf').kind).toBe('whole');
  });

  it('counts graphemes, not code units, for the whole threshold', () => {
    const name = 'résumé-x.pdf'.normalize('NFD');
    expect(Array.from(name).length).toBeGreaterThan(TAB_SPLIT_MIN);
    expect(tabLabelLayout(name).kind).toBe('whole');
  });
});
