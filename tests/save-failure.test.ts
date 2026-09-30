import { describe, expect, it } from 'vitest';
import { saveFailureNotice, writeFailureText } from '../src/renderer/lib/save-failure';

const unsafe =
  'Failed to save: The folder does not allow report 1.pdf to be replaced safely. Choose a folder where new files can be created.';

describe('saveFailureNotice', () => {
  it('maps the unsafe-replacement refusal to its own notice, named for the destination', () => {
    expect(saveFailureNotice('C:\\docs\\report 1.pdf', unsafe)).toEqual({
      key: 'app.save.replaceUnsafe',
      params: { name: 'report 1.pdf' },
    });
    expect(saveFailureNotice('/docs/report 1.pdf', new Error(unsafe)).key).toBe('app.save.replaceUnsafe');
  });

  it('passes any other refusal through with its reason', () => {
    const reason = 'Failed to save: destination is read-only';
    expect(saveFailureNotice('C:\\docs\\a.pdf', new Error(reason))).toEqual({
      key: 'app.save.failed',
      params: { name: 'a.pdf', reason },
    });
  });
});

describe('writeFailureText', () => {
  it('localizes the unsafe-replacement refusal and passes others through', () => {
    const text = writeFailureText('C:/docs/report 1.pdf', new Error(unsafe));
    expect(text).toBe(
      '"report 1.pdf" was not written. This folder does not allow the existing file to be replaced safely. Choose another folder.',
    );
    expect(text).not.toContain('Save As');
    expect(text).not.toContain('Choose a folder where new files can be created');
    expect(writeFailureText('C:/docs/a.html', new Error('disk full'))).toBe('disk full');
  });
});
