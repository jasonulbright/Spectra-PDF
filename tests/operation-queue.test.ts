import { describe, expect, it } from 'vitest';
import { isTrackableMethod } from '../src/renderer/hooks/useOperationQueue';

// The INTERNAL_METHODS allowlist exempts pure reads from the commit gate +
// the visible operation queue. A read that slips OUT of the list force-
// commits pending page edits on every call (the get_pdf_version incident).
describe('isTrackableMethod — internal-read exemptions', () => {
  it('exempts the pure reads (they must never gate/queue)', () => {
    for (const m of [
      'get_page_count',
      'get_metadata',
      'get_pdf_version',
      'get_outline',
      // 9.A2-tail-2: the fit indicator fires on every keystroke pause; if it
      // gated, it would commit unrelated pending page edits mid-typing.
      'measure_text_box',
    ]) {
      expect(isTrackableMethod(m)).toBe(false);
    }
  });

  it('tracks real operations (they gate + queue)', () => {
    for (const m of ['add_text_box', 'merge', 'sign_pdf', 'delete']) {
      expect(isTrackableMethod(m)).toBe(true);
    }
  });
});
