import { describe, expect, it } from 'vitest';
import { paragraphBoxLook } from '../src/renderer/lib/edit-paragraphs';

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
