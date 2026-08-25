import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useTranslation } from 'react-i18next';
import { tChrome } from '../i18n';

interface DropZoneProps {
  // position is the Tauri physical drop point — undefined on platforms
  // that don't report one; the handler falls back to appending when absent.
  onFilesDropped: (paths: string[], position?: { x: number; y: number }) => void;
  /**
   * A web address dragged in from a browser. It arrives as HTML5 drop data
   * (`text/uri-list`), NOT through Tauri's native file drop, which carries
   * paths only — which is why this rides the same handler that already stops
   * the webview from navigating to what was dropped.
   *
   * A drop is a user gesture, so it opens the download dialog PRE-FILLED with
   * the address; it never starts a request by itself.
   */
  onUrlDropped: (url: string) => void;
  children: React.ReactNode;
}

/** The first http(s) address in a `text/uri-list` payload. The format allows
 * several lines and `#` comments; anything else dropped (a file: URL, a text
 * selection) yields null and the drop is simply prevented as before. */
export function firstWebUri(data: string): string | null {
  for (const line of data.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (/^https?:\/\/\S+$/i.test(trimmed)) return trimmed;
    return null;
  }
  return null;
}

export function DropZone({ onFilesDropped, onUrlDropped, children }: DropZoneProps): React.ReactElement {
  // Re-render on language change; strings resolve via tChrome.
  useTranslation();
  const [dragging, setDragging] = useState(false);
  const callbackRef = useRef(onFilesDropped);
  callbackRef.current = onFilesDropped;

  useEffect(() => {
    const appWindow = getCurrentWebviewWindow();
    const unlisten = appWindow.onDragDropEvent((event) => {
      if (event.payload.type === 'enter' || event.payload.type === 'over') {
        setDragging(true);
      } else if (event.payload.type === 'leave') {
        setDragging(false);
      } else if (event.payload.type === 'drop') {
        setDragging(false);
        const paths = event.payload.paths.filter((p) =>
          /\.pdfx?$/i.test(p)
        );
        // Tauri reports the physical drop position; forward it so a drop onto a
        // canvas document imports there. Absent → append fallback.
        const position = event.payload.position as { x: number; y: number } | undefined;
        if (paths.length > 0) callbackRef.current(paths, position);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const urlRef = useRef(onUrlDropped);
  urlRef.current = onUrlDropped;

  // Prevent default browser drop behavior (would navigate to the file)
  const preventDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    preventDrop(e);
    const data =
      e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '';
    const url = firstWebUri(data);
    if (url) urlRef.current(url);
  }, [preventDrop]);

  return (
    <div
      onDragOver={preventDrop}
      onDrop={handleDrop}
      className="relative h-full"
    >
      {children}
      {dragging && (
        <div className="absolute inset-0 bg-blue-600/20 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center z-40 pointer-events-none">
          <div className="text-blue-300 text-lg font-medium">{tChrome('dialog.dropZone.hint')}</div>
        </div>
      )}
    </div>
  );
}
