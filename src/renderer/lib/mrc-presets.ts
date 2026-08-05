// The MRC preset mapping, as a pure module.
//
// There is no DOM test environment in this repo, so a rule that lives inside a
// component is a rule with no test. Everything a surface needs to decide about
// MRC — which quality value routes there, which presets exist, what parameters
// the engine gets, and how a report reads back — lives here and is covered by
// `tests/mrc-presets.test.ts`. The panels and the batch dialog then only wire
// controls to it.
//
// ONE DOOR: MRC is a `quality` of the `compress` op, never a second operation
// That is why this module exports a `quality` value rather
// than an op name — the panel, the batch dialog, the CLI, guided actions,
// watched folders and scheduled runs all reach the same `compress`.

/** The `quality` value that routes `compress` to the MRC pass. */
export const MRC_QUALITY = 'mrc';

/** The three presets, in the order they are offered — largest to smallest. */
export const MRC_PRESETS = ['archival', 'balanced', 'smallest'] as const;
export type MrcPreset = (typeof MRC_PRESETS)[number];

/** What `compress` itself defaults to; the panel opens here. */
export const DEFAULT_MRC_PRESET: MrcPreset = 'balanced';

export function isMrcQuality(quality: string): boolean {
  return quality.trim().toLowerCase() === MRC_QUALITY;
}

/** Narrow an arbitrary stored string (a settings value, a harness argument)
 * to a preset. An unknown value falls back to the default rather than being
 * sent to the engine, which would refuse the whole run by name. */
export function normalizeMrcPreset(value: string | null | undefined): MrcPreset {
  const key = (value ?? '').trim().toLowerCase();
  return (MRC_PRESETS as readonly string[]).includes(key)
    ? (key as MrcPreset)
    : DEFAULT_MRC_PRESET;
}

export interface MrcOptions {
  preset: MrcPreset;
  /** Keep every filter inside PDF/A-1's set (a modifier, not a fourth preset). */
  pdfaSafe: boolean;
  /** Recognise the source and the output and revert any page whose text did
   * not survive. Requires a recognizer path. */
  verifyText: boolean;
  /** Recognition language for the verification, Tesseract's own spelling. */
  lang?: string;
}

export const DEFAULT_MRC_OPTIONS: MrcOptions = {
  preset: DEFAULT_MRC_PRESET,
  pdfaSafe: false,
  verifyText: false,
};

/** The `compress` parameters for an MRC run — everything except the paths.
 *
 * `tesseract_path` is included ONLY when verification is on: the engine
 * refuses by name when the switch is set and the recognizer is missing, and
 * that refusal is the point (a silently skipped check would hand back exactly
 * the output the switch exists to prevent). */
export function mrcCompressParams(
  options: MrcOptions,
  paths: { tesseractPath?: string } = {},
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    quality: MRC_QUALITY,
    mrc_preset: options.preset,
    mrc_pdfa_safe: options.pdfaSafe,
    mrc_verify_text: options.verifyText,
  };
  if (options.verifyText) {
    params.mrc_lang = options.lang ?? 'eng';
    params.tesseract_path = paths.tesseractPath ?? '';
  }
  return params;
}

/** The shape `compress(quality="mrc")` returns (engine/mrc.py `mrc_compress`). */
export interface MrcReport {
  original_size: number;
  compressed_size: number;
  preset: string;
  mask_codec: string;
  requested_mask_codec: string;
  pages_mrc: number;
  pages_reverted: number;
  pages_untouched: number;
  verify_text: boolean;
  min_text_similarity: number | null;
}

/** True when the encoder the preset asked for was unavailable and the pass
 * fell back to CCITT G4. Never silent: a swapped codec makes the size claim
 * untrue, so the surfaces say so. */
export function mrcCodecFellBack(report: MrcReport): boolean {
  return report.mask_codec !== report.requested_mask_codec;
}

/** The batch-log note for one MRC'd file.
 *
 * ENGLISH and byte-identical to `engine/batch_ocr.py`'s `_mrc_step` — a run
 * logged one way by the GUI and another by the scheduler makes the audit trail
 * useless exactly where it matters most (the standing batch-log boundary; the
 * log is not a translated surface). */
export function mrcBatchNote(report: MrcReport): string {
  const note =
    `MRC compressed ${report.pages_mrc} page(s), ` +
    `${report.original_size} -> ${report.compressed_size} bytes`;
  return report.pages_reverted
    ? `${note}; ${report.pages_reverted} page(s) reverted by text verification`
    : note;
}
