import { describe, expect, it } from 'vitest';
import { applyOcrPayloads } from '../src/renderer/lib/ocr-apply';

describe('applying OCR layers to several files', () => {
  it('keeps every file that landed when another file fails', async () => {
    const payloads = ['a.pdf', 'b.pdf', 'c.pdf'].map((path) => ({ path, pages: [{ page: 1, words: [] }] }));
    const refusal = new Error('refused');
    const { applied, failed } = await applyOcrPayloads(payloads, async (path) => {
      if (path === 'b.pdf') throw refusal;
    });
    expect(applied).toEqual(['a.pdf', 'c.pdf']);
    expect(failed).toEqual([{ path: 'b.pdf', error: refusal }]);
  });
});
