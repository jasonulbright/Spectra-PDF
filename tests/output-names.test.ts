// What a "write the result to a new file" dialog opens on. Pure, because the
// dialogs themselves are not testable and a wrong suggestion silently proposes
// overwriting an unrelated document's output.
import { describe, expect, it } from 'vitest';
import { fileBaseName, suffixedOutputName } from '../src/renderer/lib/output-names';

describe('fileBaseName', () => {
  it('drops the last extension', () => {
    expect(fileBaseName('report.pdf')).toBe('report');
    expect(fileBaseName('report.final.pdf')).toBe('report.final');
  });

  it('keeps a name that has no extension', () => {
    expect(fileBaseName('report')).toBe('report');
  });

  // A leading dot is part of the name, not an empty base.
  it('keeps a dotfile whole', () => {
    expect(fileBaseName('.hidden')).toBe('.hidden');
  });
});

describe('suffixedOutputName', () => {
  it('carries the source name into the suggestion', () => {
    expect(suffixedOutputName('report.pdf', 'compressed')).toBe('report_compressed.pdf');
    expect(suffixedOutputName('Q3 Accounts.pdf', 'optimized')).toBe('Q3 Accounts_optimized.pdf');
  });

  it('takes the extension when the result is not a PDF', () => {
    expect(suffixedOutputName('report.pdf', 'text', 'txt')).toBe('report_text.txt');
  });

  // The behaviour every one of these dialogs had before a source was known.
  it('stands the suffix alone with no source', () => {
    expect(suffixedOutputName(undefined, 'compressed')).toBe('compressed.pdf');
    expect(suffixedOutputName(null, 'compressed')).toBe('compressed.pdf');
    expect(suffixedOutputName('   ', 'compressed')).toBe('compressed.pdf');
  });

  // Deliberate: collapsing it would propose the name the previous run already
  // wrote, turning a suggestion into an overwrite prompt on the user's output.
  it('repeats the suffix when the operation is repeated', () => {
    expect(suffixedOutputName('report_compressed.pdf', 'compressed')).toBe(
      'report_compressed_compressed.pdf',
    );
  });
});
