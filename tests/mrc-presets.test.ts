// Lib/mrc-presets.ts.
//
// There is no DOM test environment, so the panel and the batch dialog cannot
// be rendered. Everything they DECIDE about MRC lives in this module for that
// reason, and this is where those decisions are pinned: which quality routes
// to the pass, what the engine is actually sent, when the codec fallback is
// announced, and that the batch note matches the engine's own wording
// byte-for-byte (a run logged one way by the GUI and another by the scheduler
// makes the audit trail useless exactly where it matters most).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_MRC_PRESET,
  MRC_PRESETS,
  MRC_QUALITY,
  isMrcQuality,
  mrcBatchNote,
  mrcCodecFellBack,
  mrcCompressParams,
  mrcPagesOffSharedDictionary,
  normalizeMrcPreset,
  MRC_MASK_CODEC_MIXED,
  type MrcReport,
} from '../src/renderer/lib/mrc-presets';

function report(over: Partial<MrcReport> = {}): MrcReport {
  return {
    original_size: 900_000,
    compressed_size: 55_000,
    preset: 'balanced',
    mask_codec: 'jbig2_symbol',
    requested_mask_codec: 'jbig2_symbol',
    pages_mrc: 3,
    pages_reverted: 0,
    pages_untouched: 1,
    verify_text: false,
    min_text_similarity: null,
    ...over,
  };
}

describe('the MRC quality value', () => {
  it('is the one that routes compress to the pass', () => {
    expect(MRC_QUALITY).toBe('mrc');
    expect(isMrcQuality('mrc')).toBe(true);
    expect(isMrcQuality(' MRC ')).toBe(true);
    for (const other of ['screen', 'ebook', 'printer', 'prepress', 'custom', '']) {
      expect(isMrcQuality(other)).toBe(false);
    }
  });
});

describe('normalizeMrcPreset', () => {
  it('is total over the preset union', () => {
    for (const preset of MRC_PRESETS) expect(normalizeMrcPreset(preset)).toBe(preset);
  });

  it('falls back rather than sending an unknown value to the engine', () => {
    // The engine refuses an unknown preset BY NAME, which would fail the whole
    // run — so a stale stored setting must never reach it.
    for (const bad of ['lossless', '', null, undefined, 'Balanced ']) {
      expect(MRC_PRESETS).toContain(normalizeMrcPreset(bad as string));
    }
    expect(normalizeMrcPreset('lossless')).toBe(DEFAULT_MRC_PRESET);
    expect(normalizeMrcPreset('Balanced ')).toBe('balanced');
  });
});

describe('mrcCompressParams', () => {
  it('routes through the one door, never a second op', () => {
    const params = mrcCompressParams({ preset: 'archival', pdfaSafe: true, verifyText: false });
    expect(params.quality).toBe('mrc');
    expect(params.mrc_preset).toBe('archival');
    expect(params.mrc_pdfa_safe).toBe(true);
    expect(params.mrc_verify_text).toBe(false);
  });

  it('sends no recognizer path when verification is off', () => {
    const params = mrcCompressParams(
      { preset: 'balanced', pdfaSafe: false, verifyText: false },
      { tesseractPath: 'C:/t/tesseract.exe' },
    );
    expect('tesseract_path' in params).toBe(false);
    expect('mrc_lang' in params).toBe(false);
  });

  it('sends the recognizer path and language when verification is on', () => {
    const params = mrcCompressParams(
      { preset: 'balanced', pdfaSafe: false, verifyText: true, lang: 'deu' },
      { tesseractPath: 'C:/t/tesseract.exe' },
    );
    expect(params.tesseract_path).toBe('C:/t/tesseract.exe');
    expect(params.mrc_lang).toBe('deu');
  });

  it('sends an EMPTY recognizer path rather than omitting it', () => {
    // The engine refuses by name when the switch is on and the recognizer is
    // missing, and that refusal is the point. Omitting the key would let the
    // engine's own default resolve something and skip the refusal.
    const params = mrcCompressParams({ preset: 'balanced', pdfaSafe: false, verifyText: true });
    expect(params.tesseract_path).toBe('');
  });
});

describe('mrcCodecFellBack', () => {
  it('is true only when the pass used something other than what was asked', () => {
    expect(mrcCodecFellBack(report())).toBe(false);
    expect(
      mrcCodecFellBack(report({ mask_codec: 'ccitt_g4', requested_mask_codec: 'jbig2_symbol' })),
    ).toBe(true);
  });

  it('does not claim a missing encoder when the document was merely mixed', () => {
    // The two notices say different things — a machine missing a tool, versus
    // a scan that did not suit a shared dictionary — and the provisioning one
    // would be a false statement about the user's install.
    expect(
      mrcCodecFellBack(
        report({ mask_codec: MRC_MASK_CODEC_MIXED, pages_mask_fallback: 2 }),
      ),
    ).toBe(false);
  });
});

describe('mrcPagesOffSharedDictionary', () => {
  it('counts the pages encoded on their own, and only for a mixed document', () => {
    expect(
      mrcPagesOffSharedDictionary(
        report({ mask_codec: MRC_MASK_CODEC_MIXED, pages_mask_fallback: 2 }),
      ),
    ).toBe(2);
    expect(mrcPagesOffSharedDictionary(report())).toBe(0);
    // A whole-document provisioning fallback is uniform, not mixed: it is the
    // OTHER notice's business, and counting it here would show both.
    expect(
      mrcPagesOffSharedDictionary(
        report({
          mask_codec: 'ccitt_g4',
          requested_mask_codec: 'jbig2_symbol',
          pages_mask_fallback: 3,
        }),
      ),
    ).toBe(0);
  });

  it('reads an engine report that predates the field as no fallback', () => {
    expect(mrcPagesOffSharedDictionary(report({ mask_codec: MRC_MASK_CODEC_MIXED }))).toBe(0);
  });
});

describe('mrcBatchNote', () => {
  it('states the saving', () => {
    expect(mrcBatchNote(report())).toBe('MRC compressed 3 page(s), 900000 -> 55000 bytes');
  });

  it('never hides a revert', () => {
    expect(mrcBatchNote(report({ pages_reverted: 2 }))).toBe(
      'MRC compressed 3 page(s), 900000 -> 55000 bytes; 2 page(s) reverted by text verification',
    );
  });

  it('is worded identically to the engine arm', () => {
    // Both drivers write the same log; a drift here is a drift in the audit
    // trail. The Python source is the other half of this pin.
    const python = readFileSync(
      resolve(__dirname, '..', 'src', 'engine', 'batch_ocr.py'),
      'utf8',
    );
    expect(python).toContain('f"MRC compressed {report[\'pages_mrc\']} page(s), "');
    expect(python).toContain("f\"{report['original_size']} -> {report['compressed_size']} bytes\"");
    expect(python).toContain("page(s) reverted by text verification");
  });
});
