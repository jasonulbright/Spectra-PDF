import { describe, expect, it } from 'vitest';
import { paragraphBoxLook, segmentsToHtml } from '../src/renderer/lib/edit-paragraphs';

const base = { spans: [], bold: false, italic: false, color: '#b30000', alignment: 'left' };

describe('paragraphBoxLook', () => {
  it('carries colour, alignment, weight and slant of the paragraph', () => {
    expect(paragraphBoxLook({ ...base, bold: true, italic: true, alignment: 'justify' })).toEqual({
      fontWeight: 700,
      fontStyle: 'italic',
      color: '#b30000',
      textAlign: 'justify',
    });
  });

  it('names the stand-in family that covers most of the text', () => {
    const look = paragraphBoxLook({
      ...base,
      spans: [
        { start: 0, end: 4, run: 0, family: 'sans' },
        { start: 4, end: 20, run: 1, family: 'serif' },
      ],
    });
    expect(look.fontFamily).toContain('Liberation Serif');
  });

  it('leaves the family to the app default for an installed or unknown face', () => {
    const look = paragraphBoxLook({
      ...base,
      spans: [{ start: 0, end: 9, run: 0, family: 'C:/Windows/Fonts/a.ttf' }],
    });
    expect(look.fontFamily).toBeUndefined();
  });

  it('refuses a colour that is not #rrggbb and an unknown alignment', () => {
    const look = paragraphBoxLook({ ...base, color: 'url(x)', alignment: 'weird' });
    expect(look.color).toBeUndefined();
    expect(look.textAlign).toBeUndefined();
  });
});

describe('paragraphBoxLook family majority', () => {
  it('does not paint an installed-face majority with a shorter serif span', () => {
    const look = paragraphBoxLook({
      ...base,
      spans: [
        { start: 0, end: 30, run: 0, family: 'C:/Windows/Fonts/a.ttf' },
        { start: 30, end: 36, run: 1, family: 'serif' },
      ],
    });
    expect(look.fontFamily).toBeUndefined();
  });
});

describe('segmentsToHtml inside a bold or italic paragraph', () => {
  const seg = { text: 'x', color: null, bold: false, italic: false, size: null };
  const opts = { basePx: 16, baseSize: 12, rev: 0 };

  it('states a normal weight and slant for a plain segment', () => {
    const html = segmentsToHtml([seg], { ...opts, parentBold: true, parentItalic: true });
    expect(html).toContain('font-weight:400');
    expect(html).toContain('font-style:normal');
  });

  it('adds nothing when the paragraph is not bold or italic', () => {
    expect(segmentsToHtml([seg], opts)).not.toContain('font-weight');
  });
});
