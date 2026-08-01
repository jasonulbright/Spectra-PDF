import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { BASE_RASTER, dpr, logRenderError, renderBase, renderDetail } from './raster';

interface PageViewProps {
  pdf: PDFDocumentProxy | null; // null until the file's proxy resolves
  pageNumber: number;
  naturalWidth: number;
  naturalHeight: number;
  version: number;
  // Pending in-memory rotation. Rendered via CSS on the (unrotated) raster;
  // the cell passes its own pixel box because a 90°/270° canvas needs the
  // swapped extents, which percentages can't express.
  rotation?: 0 | 90 | 180 | 270;
  displayWidth?: number;
  displayHeight?: number;
  eager?: boolean;
  detail?: boolean;
}

function PageViewImpl({
  pdf,
  pageNumber,
  naturalWidth,
  naturalHeight,
  version,
  rotation = 0,
  displayWidth,
  displayHeight,
  eager = false,
  detail = true,
}: PageViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const detailRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(eager);
  const [baseReady, setBaseReady] = useState(false);
  // Ref mirror of "has ever painted" — read by the render effect without
  // joining its dep array (a state read there would re-trigger renders on
  // the ready flip). Once true, later renders are buffer-swap re-blits and
  // route through the shared batcher (see raster.ts).
  const hasPaintedRef = useRef(false);

  useEffect(() => {
    if (eager) return;
    const el = rootRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [eager]);

  useEffect(() => {
    if (!near || !pdf) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    void renderBase({
      pdf,
      pageNumber,
      naturalWidth,
      naturalHeight,
      baseRef,
      isCancelled: () => cancelled,
      onTask: (t) => (task = t),
      onReady: () => {
        hasPaintedRef.current = true;
        setBaseReady(true);
      },
      reblit: hasPaintedRef.current,
    }).catch(logRenderError(`Failed to render page ${pageNumber}`));
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, pdf, pageNumber, naturalWidth, naturalHeight]);

  useEffect(() => {
    if (!near || !pdf) return;
    const root = rootRef.current;
    const detailCanvas = detailRef.current;
    if (!root || !detailCanvas) return;
    if (!detail) {
      detailCanvas.style.display = 'none';
      return;
    }

    const rect = root.getBoundingClientRect();
    const layoutW = root.offsetWidth;
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const visLeft = Math.max(0, rect.left);
    const visTop = Math.max(0, rect.top);
    const visRight = Math.min(winW, rect.right);
    const visBottom = Math.min(winH, rect.bottom);
    const visW = visRight - visLeft;
    const visH = visBottom - visTop;

    // P11: with a pending 90°/270° turn the page's natural HEIGHT runs along
    // the display x-axis — both the render scale and the "is the base raster
    // already enough" threshold measure in display orientation. The pending
    // turn itself is baked into the detail viewport (renderDetail's
    // rotationExtra), so its pixels land display-oriented while the BASE
    // raster keeps its unrotated-render-plus-CSS-transform presentation.
    const rotSwapped = rotation === 90 || rotation === 270;
    const displayNaturalW = rotSwapped ? naturalHeight : naturalWidth;
    const baseDevicePx = (BASE_RASTER / Math.max(naturalWidth, naturalHeight)) * displayNaturalW;
    if (visW <= 0 || visH <= 0 || rect.width * dpr() <= baseDevicePx * 1.05) {
      detailCanvas.style.display = 'none';
      return;
    }

    let cancelled = false;
    let task: RenderTask | null = null;
    void renderDetail({
      pdf,
      pageNumber,
      naturalWidth: displayNaturalW,
      geometry: { rect, layoutW, visLeft, visTop, visW, visH },
      detailCanvas,
      isCancelled: () => cancelled,
      onTask: (t) => (task = t),
      rotationExtra: rotation,
    }).catch(logRenderError(`Failed to render detail for page ${pageNumber}`));
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, version, detail, rotation, pdf, pageNumber, naturalWidth, naturalHeight]);

  const swapped = rotation === 90 || rotation === 270;
  const baseStyle: React.CSSProperties | undefined =
    rotation !== 0 && displayWidth != null && displayHeight != null
      ? {
          left: '50%',
          top: '50%',
          width: swapped ? displayHeight : displayWidth,
          height: swapped ? displayWidth : displayHeight,
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        }
      : undefined;

  return (
    <div className="pageview" ref={rootRef}>
      <canvas
        ref={baseRef}
        className={baseReady ? 'pageview-base ready' : 'pageview-base'}
        style={baseStyle}
      />
      <canvas ref={detailRef} className="pageview-detail" style={{ display: 'none' }} />
    </div>
  );
}

export const PageView = memo(PageViewImpl);
