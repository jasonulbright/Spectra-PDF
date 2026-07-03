import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { BASE_RASTER, dpr, logRenderError, renderBase, renderDetail } from './raster';

interface PageViewProps {
  pdf: PDFDocumentProxy | null; // null until the file's proxy resolves
  pageNumber: number;
  naturalWidth: number;
  naturalHeight: number;
  version: number;
  eager?: boolean;
  detail?: boolean;
}

function PageViewImpl({
  pdf,
  pageNumber,
  naturalWidth,
  naturalHeight,
  version,
  eager = false,
  detail = true,
}: PageViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const detailRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(eager);
  const [baseReady, setBaseReady] = useState(false);

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
      onReady: () => setBaseReady(true),
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

    const baseDevicePx = (BASE_RASTER / Math.max(naturalWidth, naturalHeight)) * naturalWidth;
    if (visW <= 0 || visH <= 0 || rect.width * dpr() <= baseDevicePx * 1.05) {
      detailCanvas.style.display = 'none';
      return;
    }

    let cancelled = false;
    let task: RenderTask | null = null;
    void renderDetail({
      pdf,
      pageNumber,
      naturalWidth,
      geometry: { rect, layoutW, visLeft, visTop, visW, visH },
      detailCanvas,
      isCancelled: () => cancelled,
      onTask: (t) => (task = t),
    }).catch(logRenderError(`Failed to render detail for page ${pageNumber}`));
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, version, detail, pdf, pageNumber, naturalWidth, naturalHeight]);

  return (
    <div className="pageview" ref={rootRef}>
      <canvas ref={baseRef} className={baseReady ? 'pageview-base ready' : 'pageview-base'} />
      <canvas ref={detailRef} className="pageview-detail" style={{ display: 'none' }} />
    </div>
  );
}

export const PageView = memo(PageViewImpl);
