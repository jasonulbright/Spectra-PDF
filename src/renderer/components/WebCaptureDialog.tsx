import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppModal } from '../hooks/useAppModal';
import { useOperationQueue } from '../hooks/useOperationQueue';
import { app } from '../lib/tauri-bridge';
import { TEST_HARNESS_ENABLED, registerWebCapture } from '../testHarness';
import { tChrome, tChromeCount, type UiKey } from '../i18n';
import {
  CAPTURE_DEPTHS,
  CAPTURE_PAPER_IDS,
  DEPTH_LABEL_KEYS,
  MAX_PAGES_CEILING,
  buildRequest,
  paperInches,
  previewHost,
  type CaptureDepth,
  type CapturePaper,
  type CaptureResult,
} from '../lib/web-capture';

// File ▸ Create ▸ From Web Page.
//
// The capture runs in a VISIBLE browser window that Rust creates and destroys.
// Nothing is fetched that the user does not both start and watch, the engine
// is not involved, and the posture line below is shown rather than assumed —
// a capability that reaches the network states what it does at the point the
// user decides to use it.
//
// The result is handed UP as source rows: a captured site lands in the Create
// PDF list, so it combines with local files, reorders, and gets its bookmarks
// from the assembly that actually ran.

export function WebCaptureDialog({
  onClose,
  onCaptured,
}: {
  onClose: () => void;
  /** The captured pages, in capture order, for the Create PDF list. */
  onCaptured: (result: CaptureResult) => void;
}): React.JSX.Element {
  useTranslation();
  const { track } = useOperationQueue();
  const [url, setUrl] = useState('');
  const [depth, setDepth] = useState<CaptureDepth>(0);
  const [maxPages, setMaxPages] = useState('10');
  const [paper, setPaper] = useState<CapturePaper>('letter');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [margin, setMargin] = useState('0.4');
  const [headersFooters, setHeadersFooters] = useState(false);
  const [backgrounds, setBackgrounds] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The same ref discipline Create PDF earned: the reentrancy window opens
  // before any state update lands, and a capture has no cancel.
  const capturingRef = useRef(false);

  const host = useMemo(() => previewHost(url), [url]);

  const request = useCallback(() => {
    const [width, height] = paperInches(paper);
    return buildRequest({
      url,
      depth,
      maxPages: Number.parseInt(maxPages, 10),
      pageWidthIn: width,
      pageHeightIn: height,
      orientation,
      marginIn: Number.parseFloat(margin),
      headersFooters,
      backgrounds,
      scale: 1,
    });
  }, [url, depth, maxPages, paper, orientation, margin, headersFooters, backgrounds]);

  const runCapture = useCallback(
    async (built: ReturnType<typeof buildRequest>) => {
      if (capturingRef.current) return null;
      capturingRef.current = true;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = (await track('web_capture', { file: built.url }, () =>
          app.captureWebPage(built),
        )) as CaptureResult;
        if (result.truncated) {
          setNotice(tChromeCount('dialog.webCapture.truncated', result.pages.length));
        }
        onCaptured(result);
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        capturingRef.current = false;
        setBusy(false);
      }
    },
    [track, onCaptured],
  );

  const capture = useCallback(() => {
    if (capturingRef.current || url.trim() === '') return;
    void runCapture(request());
  }, [url, request, runCapture]);

  // Harness bridge: a live capture drives a real browser window, so the spec
  // injects the request and runs the REAL command. `buildRequest` is the same
  // clamp a clicked capture goes through.
  const harnessRef = useRef({ runCapture });
  harnessRef.current = { runCapture };
  React.useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    registerWebCapture({
      run: (partial) => harnessRef.current.runCapture(buildRequest(partial)),
    });
    return () => registerWebCapture(null);
  }, []);

  const guardedClose = busy ? () => {} : onClose;
  const shellRef = useAppModal(guardedClose);

  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={guardedClose}
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('dialog.webCapture.title')}
        data-testid="web-capture-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[560px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome('dialog.webCapture.title')}</h3>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div>
            <label className="block text-xs text-neutral-400 mb-1" htmlFor="web-capture-url">
              {tChrome('dialog.webCapture.url')}
            </label>
            <input
              id="web-capture-url"
              data-testid="web-capture-url"
              type="text"
              spellCheck={false}
              placeholder={tChrome('dialog.webCapture.urlPlaceholder')}
              className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
              value={url}
              disabled={busy}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
                setNotice(null);
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-neutral-400 mb-1" htmlFor="web-capture-depth">
                {tChrome('dialog.webCapture.depth')}
              </label>
              <select
                id="web-capture-depth"
                data-testid="web-capture-depth"
                className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
                value={depth}
                disabled={busy}
                onChange={(e) => setDepth(Number(e.target.value) as CaptureDepth)}
              >
                {CAPTURE_DEPTHS.map((value) => (
                  <option key={value} value={value}>
                    {tChrome(DEPTH_LABEL_KEYS[value] as UiKey)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-neutral-400 mb-1" htmlFor="web-capture-max">
                {tChrome('dialog.webCapture.maxPages')}
              </label>
              <input
                id="web-capture-max"
                data-testid="web-capture-max"
                type="number"
                min={1}
                max={MAX_PAGES_CEILING}
                step={1}
                className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs disabled:opacity-40"
                value={maxPages}
                // A single-page capture cannot use a budget, so the control
                // does not pretend it can.
                disabled={busy || depth === 0}
                onChange={(e) => setMaxPages(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs text-neutral-400 mb-1" htmlFor="web-capture-paper">
                {tChrome('dialog.webCapture.paper')}
              </label>
              <select
                id="web-capture-paper"
                data-testid="web-capture-paper"
                className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
                value={paper}
                disabled={busy}
                onChange={(e) => setPaper(e.target.value as CapturePaper)}
              >
                {CAPTURE_PAPER_IDS.map((id) => (
                  <option key={id} value={id}>
                    {tChrome(`dialog.createPdf.pageSize.${id}` as UiKey)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                className="block text-xs text-neutral-400 mb-1"
                htmlFor="web-capture-orientation"
              >
                {tChrome('dialog.createPdf.orientation')}
              </label>
              <select
                id="web-capture-orientation"
                data-testid="web-capture-orientation"
                className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
                value={orientation}
                disabled={busy}
                onChange={(e) => setOrientation(e.target.value as 'portrait' | 'landscape')}
              >
                <option value="portrait">{tChrome('dialog.createPdf.orientation.portrait')}</option>
                <option value="landscape">
                  {tChrome('dialog.createPdf.orientation.landscape')}
                </option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-neutral-400 mb-1" htmlFor="web-capture-margin">
                {tChrome('dialog.webCapture.margin')}
              </label>
              <input
                id="web-capture-margin"
                data-testid="web-capture-margin"
                type="number"
                min={0}
                step={0.1}
                className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs"
                value={margin}
                disabled={busy}
                onChange={(e) => setMargin(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input
                type="checkbox"
                data-testid="web-capture-headers"
                checked={headersFooters}
                disabled={busy}
                onChange={(e) => setHeadersFooters(e.target.checked)}
              />
              {tChrome('dialog.webCapture.headersFooters')}
            </label>
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input
                type="checkbox"
                data-testid="web-capture-backgrounds"
                checked={backgrounds}
                disabled={busy}
                onChange={(e) => setBackgrounds(e.target.checked)}
              />
              {tChrome('dialog.webCapture.backgrounds')}
            </label>
          </div>

          {/* The host and the budget, stated BEFORE the capture runs. */}
          {host && (
            <p className="text-xs text-neutral-300" data-testid="web-capture-target">
              {tChromeCount('dialog.webCapture.willContact', depth === 0 ? 1 : request().maxPages, {
                host,
              })}
            </p>
          )}

          {/* The posture, in the product's own words, at the point of use. */}
          <p className="text-[11px] leading-relaxed text-neutral-400" data-testid="web-capture-posture">
            {tChrome('dialog.webCapture.posture')}
          </p>

          {error && (
            <p className="text-sm text-red-400" data-testid="web-capture-error" aria-live="polite">
              {error}
            </p>
          )}
          {notice && (
            <p className="text-xs text-amber-400" data-testid="web-capture-notice" aria-live="polite">
              {notice}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              data-testid="web-capture-run"
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
              disabled={busy || url.trim() === ''}
              onClick={capture}
            >
              {tChrome(busy ? 'dialog.webCapture.capturing' : 'dialog.webCapture.capture')}
            </button>
            <button
              type="button"
              data-testid="web-capture-close"
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
              onClick={onClose}
              disabled={busy}
            >
              {tChrome('dialog.common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
