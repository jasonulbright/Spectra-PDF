import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { contentKeyOf, openPrivateCopy } from '../../lib/pdfDocCache';
import {
  drawStampRaster, holdStampRaster, stampRasterDemand, stampRasterTier, stampRasterTurn, STAMP_RASTER_MAX_SIDE,
} from '../../lib/stamp-raster';
import type { StampRaster, StampRasterHold } from '../../lib/stamp-raster';
import { dpr } from './raster';

interface CarriedStampBodyProps {
  pdf: PDFDocumentProxy | null;
  /** The source page, 1-based. */
  pageNumber: number;
  /** pdf.js's id of the stamp in the source page. */
  annotationId: string;
  /** The page's pending rotation, without a view turn. */
  rotation: number;
  /** The box the body fills, in CSS pixels: the stamp's box in the stored
   *  frame, or in the view frame for a NoRotate stamp. */
  width: number;
  height: number;
  /** CSS pixels per point at the current zoom. */
  pixelsPerPoint: number;
  /** The stamp's rectangle in the file, in points; null when unknown. */
  rectangle: { width: number; height: number } | null;
  /** The stamp keeps its orientation when the page turns. */
  noRotate: boolean;
  color: string;
  label: string | undefined;
}

/** The body of an edited stamp whose appearance the commit carries: the
 *  appearance itself, stretched onto the edited box. The label look stands in
 *  only when the appearance cannot be rastered. Nothing is rastered until the
 *  body is near the viewport. */
export function CarriedStampBody({
  pdf,
  pageNumber,
  annotationId,
  rotation,
  width,
  height,
  pixelsPerPoint,
  rectangle,
  noRotate,
  color,
  label,
}: CarriedStampBodyProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  // The bitmap is held with the stamp it shows, so other bytes or another
  // stamp never draw it. Null: the stamp has no bitmap.
  const [held, setHeld] = useState<
    { pdf: PDFDocumentProxy; pageNumber: number; annotationId: string; raster: StampRaster | null } | undefined
  >(undefined);
  const raster =
    held && held.pdf === pdf && held.pageNumber === pageNumber && held.annotationId === annotationId
      ? held.raster
      : undefined;

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || near) return;
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
  }, [near]);

  // The bitmap is as large as the box on the screen asks, by tier: a stamp
  // drawn small holds a small bitmap at any zoom.
  const deviceScale = dpr();
  const tier = stampRasterTier(stampRasterDemand(
    { width: width * deviceScale, height: height * deviceScale },
    rectangle,
    pixelsPerPoint * deviceScale,
  ));
  useEffect(() => {
    if (!near || !pdf) return;
    let cancelled = false;
    let hold: StampRasterHold | undefined;
    void (async () => {
      const key = await (contentKeyOf(pdf) ?? null);
      if (cancelled) return;
      // Held until the stamp, the tier or the document changes: the last
      // holder cancels a render in flight and closes the copy it renders.
      hold = holdStampRaster({ pdf, contentKey: key, open: () => openPrivateCopy(pdf) }, pageNumber, annotationId, tier);
      const next = await hold.raster;
      if (cancelled) return;
      // A higher tier that fails leaves the standing bitmap in place.
      setHeld((standing) => ({
        pdf,
        pageNumber,
        annotationId,
        raster:
          next ??
          (standing && standing.pdf === pdf && standing.pageNumber === pageNumber && standing.annotationId === annotationId
            ? standing.raster
            : null),
      }));
    })();
    return () => {
      cancelled = true;
      hold?.release();
    };
  }, [near, pdf, pageNumber, annotationId, tier]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!raster) {
      canvas.dataset.drawn = 'false';
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const scale = dpr();
    const w = Math.max(1, Math.min(STAMP_RASTER_MAX_SIDE, Math.round(width * scale)));
    const h = Math.max(1, Math.min(STAMP_RASTER_MAX_SIDE, Math.round(height * scale)));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const context = canvas.getContext('2d');
    if (!context) return;
    drawStampRaster(context, raster, stampRasterTurn(raster.pageRotate, rotation, noRotate), w, h);
    canvas.dataset.drawn = 'true';
  }, [raster, rotation, noRotate, width, height]);

  if (raster === null) {
    return (
      <span className="page-annot-stamp-fallback" style={{ backgroundColor: `${color}22` }}>
        <span className="page-annot-stamp-label">{label}</span>
      </span>
    );
  }
  return (
    <canvas
      ref={canvasRef}
      className="page-annot-stamp-appearance"
      data-testid="stamp-appearance-preview"
    />
  );
}
