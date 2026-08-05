import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { NoFileOpen } from '../components/NoFileOpen';
import { StatusBar } from '../components/StatusBar';
import { ensureGsPath, getSettings } from './SettingsPanel';
import { tesseractPath } from '../lib/ocr-recognize';
import { OCR_LANGUAGES, DEFAULT_OCR_LANGUAGE } from '../ocr/languages';
import { toTesseractLang, describeLanguages } from '../ocr/language-selection';
import {
  MRC_PRESETS,
  isMrcQuality,
  mrcCodecFellBack,
  mrcCompressParams,
  normalizeMrcPreset,
  type MrcPreset,
  type MrcReport,
} from '../lib/mrc-presets';
import { TEST_HARNESS_ENABLED, registerCompress } from '../testHarness';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, tOcrLanguage, type UiKey } from '../i18n';

const PRESET_DPI: Record<string, number> = { screen: 72, ebook: 150, printer: 300, prepress: 300 };

/** Preset → its two catalog keys. Written out rather than composed from the
 * preset name: a key built by string concatenation is a key the catalog's
 * type union cannot check and the parity gate cannot see. */
const MRC_PRESET_KEYS: Record<MrcPreset, { label: UiKey; hint: UiKey }> = {
  archival: {
    label: 'panel.compress.mrcPresetArchival',
    hint: 'panel.compress.mrcPresetHintArchival',
  },
  balanced: {
    label: 'panel.compress.mrcPresetBalanced',
    hint: 'panel.compress.mrcPresetHintBalanced',
  },
  smallest: {
    label: 'panel.compress.mrcPresetSmallest',
    hint: 'panel.compress.mrcPresetHintSmallest',
  },
};

// O8 slice D — "Scanned document (MRC)" is a QUALITY of the same compress op,
// not a second operation (brief 40 § 6.1), which is why it joins this select
// rather than growing the tool list. Choosing it hides the DPI slider, because
// DPI is meaningless for MRC: the stencil stays at the scan's own resolution
// and that is the whole point of it (the engine refuses `dpi` alongside `mrc`
// rather than quietly dropping one).

export function CompressPanel(): React.ReactElement {
  // N12: re-render on language change; strings resolve via tChrome.
  useTranslation();
  const { activeFile, openNewFiles } = useActiveFile();
  const { call, saveFile } = useEngine();
  const [quality, setQuality] = useState<string>(() => getSettings().compressionQuality);
  const [dpi, setDpi] = useState<number>(PRESET_DPI[getSettings().compressionQuality] || 150);
  const [mrcPreset, setMrcPreset] = useState<MrcPreset>(() =>
    normalizeMrcPreset(getSettings().mrcPreset),
  );
  const [pdfaSafe, setPdfaSafe] = useState(false);
  const [verifyText, setVerifyText] = useState(false);
  // Which models the verification reads with. NOT cosmetic: the check scores a
  // source page against its reconstruction, and `text_similarity` scores a
  // source with NO recognizable words 1.0 (a scan with no text has nothing to
  // lose). Recognizing a German or Japanese scan with the English model
  // returns almost nothing from BOTH sides — so a hardcoded 'eng' would turn
  // the switch into a silent no-op on exactly the documents it matters for.
  // Every other OCR surface picks its languages the same way, with the same
  // '+'-joined string.
  const [verifyLangs, setVerifyLangs] = useState<string[]>([DEFAULT_OCR_LANGUAGE]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const mrc = isMrcQuality(quality);

  const handlePresetChange = (preset: string): void => {
    setQuality(preset);
    if (preset !== 'custom' && !isMrcQuality(preset)) {
      setDpi(PRESET_DPI[preset] || 150);
    }
  };

  const handleDpiChange = (value: number): void => {
    setDpi(value);
    setQuality('custom');
  };

  // The run itself, with the output path already chosen. Split out from the
  // button handler so the e2e harness can drive the REAL panel state through
  // the REAL engine call with an injected path — the native save dialog is
  // undrivable by WebDriver (the createPdfRun precedent), and a second
  // implementation for tests would be a test of the wrong code.
  const performCompress = useCallback(
    async (output: string): Promise<string> => {
      if (!activeFile) return '';
      setBusy(true);
      setStatus(tChrome('panel.compress.compressing'));
      try {
        const params: Record<string, unknown> = {
          file: activeFile.workingPath, output, gs_path: await ensureGsPath(),
        };
        if (mrc) {
          Object.assign(
            params,
            mrcCompressParams(
              { preset: mrcPreset, pdfaSafe, verifyText, lang: toTesseractLang(verifyLangs) },
              { tesseractPath: verifyText ? await tesseractPath() : undefined },
            ),
          );
        } else if (quality === 'custom') {
          params.dpi = dpi;
          params.quality = 'ebook'; // fallback label
        } else {
          params.quality = quality;
        }
        const r = await call('compress', params);
        const line = tChrome('panel.compress.result', {
          from: (r.original_size / 1024).toFixed(0),
          to: (r.compressed_size / 1024).toFixed(0),
          ratio: ((1 - r.compressed_size / r.original_size) * 100).toFixed(1),
        });
        setStatus(mrc ? `${line} ${describeMrc(r as unknown as MrcReport)}` : line);
        return 'ok';
      } catch (e: unknown) {
        setStatus(tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }));
        return 'error';
      } finally {
        setBusy(false);
      }
    },
    [activeFile, quality, dpi, mrc, mrcPreset, pdfaSafe, verifyText, verifyLangs, call],
  );

  const handleCompress = useCallback(async () => {
    if (!activeFile) return;
    const output = await saveFile('compressed.pdf');
    if (!output) return;
    await performCompress(output);
  }, [activeFile, saveFile, performCompress]);

  const harnessDeps = {
    performCompress,
    setQuality: handlePresetChange,
    setMrcPreset,
    setVerifyText,
    snapshot: { quality, mrcPreset, verifyText },
  };
  const harnessRef = useRef(harnessDeps);
  harnessRef.current = harnessDeps;
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerCompress({
      run: (output) => harnessRef.current.performCompress(output),
      setQuality: (value) => harnessRef.current.setQuality(value),
      setMrcPreset: (value) => harnessRef.current.setMrcPreset(normalizeMrcPreset(value)),
      setVerifyText: (value) => harnessRef.current.setVerifyText(value),
      snapshot: () => harnessRef.current.snapshot,
    });
    return () => registerCompress(null);
  }, []);

  if (!activeFile) return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.compress.open')} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">{tChrome('panel.common.workingOn')} <span className="text-neutral-200">{activeFile.name}</span> ({tChromeCount('panel.common.pageCount', activeFile.pageCount)})</div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.compress.quality')}</label>
        <select aria-label={tChrome('panel.compress.presetAria')} data-testid="compress-quality" value={quality} onChange={(e) => handlePresetChange(e.target.value)} className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm">
          <option value="screen">{tChrome('panel.compress.screen')}</option>
          <option value="ebook">{tChrome('panel.compress.ebook')}</option>
          <option value="printer">{tChrome('panel.compress.printer')}</option>
          <option value="prepress">{tChrome('panel.compress.prepress')}</option>
          <option value="mrc">{tChrome('panel.compress.mrc')}</option>
          <option value="custom">{tChrome('panel.compress.custom')}</option>
        </select>
      </div>
      {mrc ? (
        <div className="flex flex-col gap-3" data-testid="compress-mrc-options">
          <p className="text-xs text-neutral-500 max-w-md">{tChrome('panel.compress.mrcHint')}</p>
          <div>
            <span className="block text-sm text-neutral-400 mb-1">{tChrome('panel.compress.mrcPreset')}</span>
            <div role="radiogroup" aria-label={tChrome('panel.compress.mrcPreset')} className="flex flex-col gap-1">
              {MRC_PRESETS.map((preset) => (
                <label key={preset} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="mrc-preset"
                    data-testid={`mrc-preset-${preset}`}
                    checked={mrcPreset === preset}
                    onChange={() => setMrcPreset(preset)}
                    className="mt-1"
                  />
                  <span className="text-sm text-neutral-300">
                    {tChrome(MRC_PRESET_KEYS[preset].label)}
                    <span className="block text-xs text-neutral-500">
                      {tChrome(MRC_PRESET_KEYS[preset].hint)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" data-testid="mrc-pdfa-safe" checked={pdfaSafe} onChange={() => setPdfaSafe(!pdfaSafe)} />
            <span className="text-sm text-neutral-300">{tChrome('panel.compress.mrcPdfaSafe')}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" data-testid="mrc-verify" checked={verifyText} onChange={() => setVerifyText(!verifyText)} />
            <span className="text-sm text-neutral-300">{tChrome('panel.compress.mrcVerify')}</span>
          </label>
          <p className="text-xs text-neutral-500 max-w-md">{tChrome('panel.compress.mrcVerifyHint')}</p>
          {verifyText && (
            <div data-testid="mrc-verify-langs">
              <span className="block text-sm text-neutral-400 mb-1">
                {tChrome('panel.compress.mrcVerifyLanguages', {
                  summary: describeLanguages(verifyLangs),
                })}
              </span>
              <div className="max-h-28 overflow-y-auto rounded border border-neutral-700 bg-neutral-800 p-2 grid grid-cols-3 gap-x-3 gap-y-1 max-w-md">
                {OCR_LANGUAGES.map((l) => (
                  <label key={l.code} className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={verifyLangs.includes(l.code)}
                      onChange={() =>
                        setVerifyLangs(
                          verifyLangs.includes(l.code)
                            ? verifyLangs.filter((c) => c !== l.code)
                            : [...verifyLangs, l.code],
                        )
                      }
                      className="rounded bg-neutral-900 border-neutral-600"
                    />
                    <span className="text-neutral-300">{tOcrLanguage(l.code)}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div>
          <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.compress.dpiLabel', { dpi })}</label>
          <input type="range" aria-label={tChrome('panel.compress.dpiAria')} min={72} max={600} step={1} value={dpi}
            onChange={(e) => handleDpiChange(Number(e.target.value))}
            className="w-64 accent-blue-600" />
          <div className="flex justify-between w-64 text-xs text-neutral-600">
            <span>72</span><span>150</span><span>300</span><span>600</span>
          </div>
        </div>
      )}
      <button onClick={handleCompress} disabled={busy} className="self-start px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium">
        {busy ? tChrome('panel.compress.compressing') : tChrome('panel.compress.compress')}
      </button>
      <StatusBar message={status} busy={busy} />
    </div>
  );
}

/** The MRC half of the status line: what the pass actually did, never what it
 * was asked to do. The codec is reported because the encoder can be absent and
 * the fallback changes the size claim; the reverted count and the lowest
 * similarity are reported because a silent revert would be the very
 * degradation the switch exists to surface. */
function describeMrc(report: MrcReport): string {
  const parts = [
    tChrome('panel.compress.mrcResult', {
      pages: report.pages_mrc,
      untouched: report.pages_untouched,
    }),
  ];
  if (mrcCodecFellBack(report)) parts.push(tChrome('panel.compress.mrcFallbackNotice'));
  if (report.verify_text) {
    parts.push(
      report.pages_reverted > 0
        ? tChrome('panel.compress.mrcVerifyBelowThreshold', { pages: report.pages_reverted })
        : tChrome('panel.compress.mrcVerifyResult', {
            similarity: ((report.min_text_similarity ?? 1) * 100).toFixed(1),
          }),
    );
  }
  return parts.join(' ');
}
