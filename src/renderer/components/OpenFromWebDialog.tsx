import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppModal } from '../hooks/useAppModal';
import { app } from '../lib/tauri-bridge';
import { tChrome } from '../i18n';
import {
  WEB_URL_REFUSAL_KEYS,
  downloadStem,
  isPrivateHost,
  readWebUrl,
} from '../lib/web-open';

// File ▸ Open from Web Address.
//
// One user gesture, one request: the address is typed or pasted here, shown
// back in full as the string that will be fetched, and downloaded by the app's
// single outbound client to a temporary copy. That copy then enters the ONE
// open funnel like any file the user picked — nothing here parses, and nothing
// a document carries can reach this door.
//
// Cancel abandons the RESULT rather than the transfer: there is no way to stop
// a request already in flight, so the dialog says what cancelling actually
// does instead of implying it reaches across the wire.

export interface OpenFromWebResult {
  /** The downloaded copy's path, for the open funnel. */
  path: string;
  /** The address it came from — the document's provenance. */
  url: string;
}

export function OpenFromWebDialog({
  initialUrl,
  onClose,
  onDownloaded,
}: {
  /** Pre-filled address: a re-open from the recent list, or a dropped URL.
   * Pre-filled, never pre-fetched. */
  initialUrl?: string;
  onClose: () => void;
  /**
   * Hand the downloaded copy to the caller's open funnel. It resolves to an
   * error message when the funnel refused the file (a response that is not a
   * document it can read), so the refusal is shown HERE, beside the address
   * that produced it, rather than as a detached notice.
   */
  onDownloaded: (result: OpenFromWebResult) => Promise<string | null>;
}): React.JSX.Element {
  useTranslation();
  const [url, setUrl] = useState(initialUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The reentrancy window opens before any state update lands (the Create PDF
  // / Web Capture discipline), and the same ref carries the abandon flag: a
  // response that arrives after Cancel is discarded rather than opened.
  const runRef = useRef<{ busy: boolean; abandoned: boolean }>({
    busy: false,
    abandoned: false,
  });

  const verdict = useMemo(() => readWebUrl(url), [url]);

  const download = useCallback(async () => {
    if (runRef.current.busy) return;
    const read = readWebUrl(url);
    if (!read.ok) {
      setError(tChrome(WEB_URL_REFUSAL_KEYS[read.reason], { url: url.trim() }));
      return;
    }
    runRef.current = { busy: true, abandoned: false };
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await app.netRequest({
        url: read.url,
        method: 'get',
        fileName: downloadStem(read.url),
        // A user-typed address may legitimately name a host on the LAN, so a
        // private first hop is fetched (with the warning shown above) rather
        // than refused. Rust still refuses a redirect that STARTS public and
        // lands private — that hop was never seen.
        refusePrivate: false,
      });
      if (runRef.current.abandoned) return;
      if (response.status < 200 || response.status >= 300) {
        setError(
          tChrome('dialog.openWeb.rejected', {
            url: read.url,
            status: response.status,
          }),
        );
        return;
      }
      if (response.bytes === 0) {
        setError(tChrome('dialog.openWeb.empty', { url: read.url }));
        return;
      }
      // The funnel decides whether these bytes are a document. A refusal comes
      // back as its own text and is shown; it is not a crash and not a second
      // opinion formed here from the content type.
      // Provenance is the address the bytes actually came from — a same-origin
      // redirect moves it, and recording the typed one would name a place the
      // document did not come from.
      const refusal = await onDownloaded({
        path: response.path,
        url: response.finalUrl || read.url,
      });
      if (runRef.current.abandoned) return;
      if (refusal) {
        setError(
          tChrome('dialog.openWeb.notADocument', { url: read.url, detail: refusal }),
        );
        return;
      }
      onClose();
    } catch (err) {
      if (runRef.current.abandoned) return;
      setError(
        tChrome('dialog.openWeb.failed', {
          url: read.url,
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      runRef.current.busy = false;
      setBusy(false);
    }
  }, [url, onDownloaded, onClose]);

  const cancel = useCallback(() => {
    if (runRef.current.busy) {
      runRef.current.abandoned = true;
      runRef.current.busy = false;
      setBusy(false);
      setNotice(tChrome('dialog.openWeb.cancelled'));
      return;
    }
    onClose();
  }, [onClose]);

  const shellRef = useAppModal(cancel);

  return (
    <div
      data-app-modal
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={cancel}
    >
      <div
        ref={shellRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={tChrome('dialog.openWeb.title')}
        data-testid="open-web-dialog"
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[560px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
          <h3 className="text-sm font-semibold">{tChrome('dialog.openWeb.title')}</h3>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div>
            <label className="block text-xs text-neutral-400 mb-1" htmlFor="open-web-url">
              {tChrome('dialog.openWeb.url')}
            </label>
            <input
              id="open-web-url"
              data-testid="open-web-url"
              type="text"
              spellCheck={false}
              autoFocus
              placeholder={tChrome('dialog.openWeb.urlPlaceholder')}
              className="w-full px-2 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-xs ltr-notation"
              value={url}
              disabled={busy}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
                setNotice(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void download();
              }}
            />
          </div>

          {/* The exact address that will be requested, in full. */}
          {verdict.ok && (
            <p
              className="text-xs text-neutral-300 whitespace-pre-wrap break-all"
              data-testid="open-web-target"
            >
              {tChrome('dialog.openWeb.willFetch', { url: verdict.url })}
            </p>
          )}

          {verdict.ok && verdict.insecure && (
            <p className="text-xs text-amber-400" data-testid="open-web-insecure">
              {tChrome('dialog.openWeb.insecure')}
            </p>
          )}

          {verdict.ok && isPrivateHost(verdict.host) && (
            <p className="text-xs text-amber-400" data-testid="open-web-private">
              {tChrome('dialog.openWeb.privateWarning')}
            </p>
          )}

          <p className="text-[11px] leading-relaxed text-neutral-400" data-testid="open-web-posture">
            {tChrome('dialog.openWeb.posture')}
          </p>
          <p className="text-[11px] leading-relaxed text-neutral-400" data-testid="open-web-save-note">
            {tChrome('dialog.openWeb.saveNote')}
          </p>

          {error && (
            <p
              className="text-sm text-red-400 whitespace-pre-wrap break-words"
              data-testid="open-web-error"
              aria-live="polite"
            >
              {error}
            </p>
          )}
          {notice && (
            <p className="text-xs text-amber-400" data-testid="open-web-notice" aria-live="polite">
              {notice}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              data-testid="open-web-open"
              className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
              disabled={busy || !verdict.ok}
              onClick={() => void download()}
            >
              {tChrome(busy ? 'dialog.openWeb.opening' : 'dialog.openWeb.open')}
            </button>
            <button
              type="button"
              data-testid="open-web-cancel"
              className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
              onClick={cancel}
            >
              {tChrome('dialog.openWeb.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
