// What a surface shows for a caught error: the operating system's sentence
// without its diagnostic code, and a library message without the temporary
// path the program itself created.
import { describe, it, expect } from 'vitest';
import { errorText, withoutFilePath, withoutOsErrorCode } from '../src/renderer/lib/error-text';
import { runTracked, upsertQueueItem, type QueueSinks } from '../src/renderer/hooks/useOperationQueue';
import type { QueueItem } from '../src/renderer/components/OperationQueue';

describe('withoutOsErrorCode', () => {
  it('removes the trailing code of a Rust io error', () => {
    expect(withoutOsErrorCode('Access is denied. (os error 5)')).toBe('Access is denied.');
    expect(withoutOsErrorCode('Permission denied (os error 13)')).toBe('Permission denied');
  });

  it('keeps a message that carries no code, and a code that is not trailing', () => {
    expect(withoutOsErrorCode('Nothing was saved.')).toBe('Nothing was saved.');
    expect(withoutOsErrorCode('(os error 5) is the code')).toBe('(os error 5) is the code');
  });
});

describe('errorText', () => {
  it('reads an Error and any other thrown value', () => {
    expect(errorText(new Error('Access is denied. (os error 5)'))).toBe('Access is denied.');
    expect(errorText('The process cannot access the file. (os error 32)')).toBe(
      'The process cannot access the file.',
    );
  });
});

describe('withoutFilePath', () => {
  const temp = 'C:\\Users\\a\\AppData\\Local\\Temp\\spectrapdf\\web\\not-a-pdf-1.txt';

  it('removes the path prefix a PDF library prints, in either separator spelling', () => {
    expect(withoutFilePath(`${temp}: unable to find trailer dictionary`, temp)).toBe(
      'unable to find trailer dictionary',
    );
    expect(withoutFilePath(`${temp.replace(/\\/g, '/')} (offset 0): file is damaged`, temp)).toBe(
      'file is damaged',
    );
    expect(withoutFilePath(`${temp.toLowerCase()}: bad`, temp)).toBe('bad');
  });

  it('leaves a message that does not name the path', () => {
    expect(withoutFilePath('This file is not a PDF.', temp)).toBe('This file is not a PDF.');
    expect(withoutFilePath('x', '')).toBe('x');
  });
});

describe('the operation queue line', () => {
  it('shows the failure without the code while the log keeps the raw text', async () => {
    const record = { items: [] as QueueItem[], lines: [] as string[] };
    const sinks: QueueSinks = {
      put: (item) => { record.items = upsertQueueItem(record.items, item); },
      log: (line) => { record.lines.push(line); },
      now: () => 1_000,
    };
    const refusal = new Error('Access is denied. (os error 5)');
    await expect(runTracked('1', 'merge', {}, async () => { throw refusal; }, sinks)).rejects.toBe(refusal);
    expect(record.items[0].message).toBe('Access is denied.');
    expect(record.lines[0]).toContain('(os error 5)');
  });
});
