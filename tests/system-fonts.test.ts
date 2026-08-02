import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseListing,
  pickFace,
  loadSystemFonts,
  __resetSystemFonts,
} from '../src/renderer/lib/system-fonts';

const REPLY = {
  families: [
    {
      family: 'Georgia',
      faces: [
        { path: 'C:\\W\\georgia.ttf', index: 0, style: 'Regular', name: 'Georgia', bold: false, italic: false },
        { path: 'C:\\W\\georgiab.ttf', index: 0, style: 'Bold', name: 'Georgia Bold', bold: true, italic: false },
        { path: 'C:\\W\\georgiai.ttf', index: 0, style: 'Italic', name: 'Georgia Italic', bold: false, italic: true },
      ],
    },
    {
      family: 'OneFace',
      faces: [{ path: 'C:\\W\\one.ttf', index: 0, style: 'Regular', name: 'OneFace', bold: false, italic: false }],
    },
  ],
  count: 4,
  restricted: 2,
};

describe('parseListing', () => {
  it('reads a well-formed reply', () => {
    const out = parseListing(REPLY);
    expect(out.families.map((f) => f.family)).toEqual(['Georgia', 'OneFace']);
    expect(out.count).toBe(4);
    expect(out.restricted).toBe(2);
  });

  it('drops malformed entries rather than breaking the picker', () => {
    const out = parseListing({
      families: [
        { family: '', faces: [] },
        { family: 'Good', faces: [{ path: 'C:\\a.ttf' }] },
        { family: 'NoFaces', faces: [] },
        { faces: [{ path: 'C:\\b.ttf' }] },
        { family: 'BadFace', faces: [{ style: 'Regular' }] },
      ],
    });
    expect(out.families.map((f) => f.family)).toEqual(['Good']);
    // Missing optional fields take honest defaults.
    expect(out.families[0].faces[0].style).toBe('Regular');
    expect(out.families[0].faces[0].bold).toBe(false);
  });

  it('survives a reply that is not a listing at all', () => {
    expect(parseListing(null).families).toEqual([]);
    expect(parseListing({}).count).toBe(0);
    expect(parseListing({ families: 'nope' }).families).toEqual([]);
  });
});

describe('pickFace', () => {
  const georgia = parseListing(REPLY).families[0];
  const oneFace = parseListing(REPLY).families[1];

  it('takes the exact weight and slant when the family has it', () => {
    expect(pickFace(georgia, false, false)?.style).toBe('Regular');
    expect(pickFace(georgia, true, false)?.style).toBe('Bold');
    expect(pickFace(georgia, false, true)?.style).toBe('Italic');
  });

  it('degrades within the FAMILY rather than leaving it', () => {
    // Georgia has no Bold Italic here: same weight beats same slant, and
    // both beat jumping to another family — face identity is what matters.
    expect(pickFace(georgia, true, true)?.style).toBe('Bold');
  });

  it('falls back to Regular, then to whatever exists', () => {
    expect(pickFace(oneFace, true, true)?.style).toBe('Regular');
    expect(pickFace({ family: 'Empty', faces: [] }, false, false)).toBeNull();
  });
});

describe('loadSystemFonts', () => {
  beforeEach(() => __resetSystemFonts());

  it('fetches once and caches — the engine is a serial queue', async () => {
    let calls = 0;
    const call = async () => {
      calls += 1;
      return REPLY;
    };
    const a = await loadSystemFonts(call);
    const b = await loadSystemFonts(call);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a.count).toBe(4);
  });

  it('a machine that cannot answer keeps the bundled families', async () => {
    const failing = async () => {
      throw new Error('engine unavailable');
    };
    const out = await loadSystemFonts(failing);
    expect(out.families).toEqual([]);
    expect(out.count).toBe(0);
    // …and the failure is not cached, so a later attempt can still succeed.
    const ok = await loadSystemFonts(async () => REPLY);
    expect(ok.count).toBe(4);
  });
});
