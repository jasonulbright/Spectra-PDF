import { describe, it, expect } from 'vitest';
import { splitAfterSeparators } from '../src/renderer/components/path-breaks';

describe('splitAfterSeparators', () => {
  it('cuts after each Windows separator and keeps the file name whole', () => {
    expect(splitAfterSeparators('Created 3 pages -> C:\\Users\\a\\mixed.pdf')).toEqual([
      'Created 3 pages -> C:\\',
      'Users\\',
      'a\\',
      'mixed.pdf',
    ]);
  });

  it('cuts after POSIX separators', () => {
    expect(splitAfterSeparators('/tmp/out/summary-1.pdf')).toEqual(['/', 'tmp/', 'out/', 'summary-1.pdf']);
  });

  it('loses no character', () => {
    const text = 'Saved to C:\\x\\y\\comment-summary-lahuc2summary-1.pdf';
    expect(splitAfterSeparators(text).join('')).toBe(text);
  });

  it('returns the text itself when it has no separator, including empty text', () => {
    expect(splitAfterSeparators('plain')).toEqual(['plain']);
    expect(splitAfterSeparators('')).toEqual(['']);
  });

  it('ends on the separator when the text ends with one', () => {
    expect(splitAfterSeparators('C:\\out\\')).toEqual(['C:\\', 'out\\']);
  });
});
