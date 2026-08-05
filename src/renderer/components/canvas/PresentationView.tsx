import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { OpenDocument } from '../../state/types';
import { PageView } from './PageView';
import { useTranslation } from 'react-i18next';
import { tChrome, tNumber } from '../../i18n';
import { formatKey } from '../../commands/keymap';

// Full-screen presentation mode.
// One page fills the screen on a black backdrop; arrow/space/PageUp-Down/Home/End
// navigate, Escape leaves. It is a self-contained OVERLAY over the whole app —
// deliberately NOT a change to the virtualized reading column (that stays the
// daily-use surface; a presentation is a transient lens on top of it), so it
// reuses PageView for rendering but owns none of the column's layout invariants.
//
// The OS window goes true-fullscreen via Tauri while it's up and is restored on
// exit; if that call is unavailable (non-Tauri host, e.g. a unit env) the fixed
// inset-0 overlay still covers the app, so the feature degrades to a maximized
// in-window presentation rather than failing.

export interface PresentationViewProps {
  doc: OpenDocument;
  proxies: Map<string, PDFDocumentProxy>;
  /** 0-based page to open on (the page being read). */
  startIndex: number;
  onExit: (landedPageId: string | null) => void;
}

export function PresentationView({
  doc,
  proxies,
  startIndex,
  onExit,
}: PresentationViewProps): React.JSX.Element {
  useTranslation();
  const pageCount = doc.pages.length;
  const clamp = useCallback(
    (i: number) => Math.max(0, Math.min(pageCount - 1, i)),
    [pageCount],
  );
  const [index, setIndex] = useState(() => clamp(startIndex));
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  // True OS fullscreen while presenting; restore on unmount. Best-effort —
  // a rejected/absent call leaves the in-window overlay covering the app.
  useEffect(() => {
    const win = getCurrentWindow();
    win.setFullscreen(true).catch(() => {});
    return () => {
      win.setFullscreen(false).catch(() => {});
    };
  }, []);

  // Focus the overlay so its key handler runs without a click first.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Measure the available area (re-measured on resize — entering/leaving OS
  // fullscreen changes it a beat after mount).
  useLayoutEffect(() => {
    const measure = (): void => {
      const el = containerRef.current;
      if (el) setBox({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    window.addEventListener('resize', measure);
    const t = setTimeout(measure, 120); // after the fullscreen transition
    return () => {
      window.removeEventListener('resize', measure);
      clearTimeout(t);
    };
  }, []);

  const exit = useCallback(() => {
    onExit(doc.pages[index]?.id ?? null);
  }, [onExit, doc.pages, index]);

  const step = useCallback((delta: number) => setIndex((i) => clamp(i + delta)), [clamp]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
        case 'Enter':
          e.preventDefault();
          step(1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          e.preventDefault();
          step(-1);
          break;
        case 'Home':
          e.preventDefault();
          setIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setIndex(pageCount - 1);
          break;
        case 'Escape':
        case 'F5':
          e.preventDefault();
          exit();
          break;
      }
    },
    [step, pageCount, exit],
  );

  const page = doc.pages[index];
  // Fit the page inside the viewport preserving aspect (letterbox), accounting
  // for the page's baked-in view rotation (a 90/270 page swaps its extents).
  const rotated = page && (page.rotation === 90 || page.rotation === 270);
  const natW = page ? (rotated ? page.height : page.width) : 1;
  const natH = page ? (rotated ? page.width : page.height) : 1;
  let dispW = 0;
  let dispH = 0;
  if (page && box.w > 0 && box.h > 0) {
    const scale = Math.min(box.w / natW, box.h / natH) * 0.96; // small margin
    dispW = Math.max(1, Math.round(natW * scale));
    dispH = Math.max(1, Math.round(natH * scale));
  }

  return (
    <div
      ref={containerRef}
      data-testid="presentation-view"
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={tChrome('canvas.present.label')}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[60] bg-black flex items-center justify-center outline-none select-none"
      // A click anywhere advances (the projector convention); a click on the
      // exit affordance stops propagation.
      onClick={() => step(1)}
      onContextMenu={(e) => {
        e.preventDefault(); // right-click goes back
        step(-1);
      }}
    >
      {page && dispW > 0 && (
        <PageView
          pdf={proxies.get(page.sourceDocId) ?? null}
          pageNumber={page.sourcePageIndex + 1}
          naturalWidth={page.width}
          naturalHeight={page.height}
          version={0}
          rotation={page.rotation}
          displayWidth={dispW}
          displayHeight={dispH}
          eager
        />
      )}

      {/* Minimal chrome: page counter + exit, both out of the way, fading. */}
      <div
        data-testid="presentation-counter"
        className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-white/10 text-white/80 text-sm tabular-nums"
      >
        {tChrome('canvas.present.counter', {
          current: tNumber(index + 1),
          total: tNumber(pageCount),
        })}
      </div>
      <button
        type="button"
        data-testid="presentation-exit"
        title={tChrome('canvas.present.exitTitle')}
        aria-label={tChrome('canvas.present.exitAria')}
        onClick={(e) => {
          e.stopPropagation();
          exit();
        }}
        className="absolute top-4 right-4 px-2.5 py-1 rounded bg-white/10 hover:bg-white/20 text-white/80 text-xs"
      >
        {formatKey('escape')}
      </button>
    </div>
  );
}
