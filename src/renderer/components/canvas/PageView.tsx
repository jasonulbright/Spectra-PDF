import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { BASE_RASTER, dpr, logRenderError, renderBase, renderDetail, renderSeparation } from './raster';

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
  /** A separation composite standing in for the viewer's raster while Output
   *  Preview is armed. It paints onto its own canvas above the base, so the
   *  base still holds the viewer's pixels and dropping this restores the page
   *  with nothing to re-render. */
  separation?: Blob | null;
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
  separation = null,
}: PageViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const detailRef = useRef<HTMLCanvasElement>(null);
  const separationRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(eager);
  const [baseReady, setBaseReady] = useState(false);
  const [separationReady, setSeparationReady] = useState(false);
  const hasPaintedSeparationRef = useRef(false);
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
    if (!separation) {
      setSeparationReady(false);
      return;
    }
    let cancelled = false;
    void renderSeparation({
      image: separation,
      canvasRef: separationRef,
      isCancelled: () => cancelled,
      onReady: () => {
        hasPaintedSeparationRef.current = true;
        setSeparationReady(true);
      },
      reblit: hasPaintedSeparationRef.current,
    }).catch(logRenderError(`Failed to render separations for page ${pageNumber}`));
    return () => {
      cancelled = true;
    };
  }, [separation, pageNumber]);

  useEffect(() => {
    if (!near || !pdf) return;
    const root = rootRef.current;
    const detailCanvas = detailRef.current;
    if (!root || !detailCanvas) return;
    // The detail canvas is the viewer's own sharper RGB render. It must not
    // sit on top of a separation composite, which is a different rendering of
    // the page and the only one that can show overprint.
    if (!detail || separation) {
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

    // With a pending 90°/270° turn the page's natural HEIGHT runs along
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
  }, [near, version, detail, rotation, pdf, pageNumber, naturalWidth, naturalHeight, separation]);

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
      <canvas
        ref={separationRef}
        data-testid={separationReady ? 'pageview-separation' : undefined}
        className={separationReady ? 'pageview-separation ready' : 'pageview-separation'}
        style={baseStyle}
      />
    </div>
  );
}

export const PageView = memo(PageViewImpl);
