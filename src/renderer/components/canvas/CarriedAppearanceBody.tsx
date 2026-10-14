import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { contentKeyOf, openPrivateCopy } from '../../lib/pdfDocCache';
import {
  drawAppearanceRaster, holdAppearanceRaster, appearanceRasterDemand, appearanceRasterTier, appearanceRasterTurn, APPEARANCE_RASTER_MAX_SIDE,
} from '../../lib/appearance-raster';
import type { AppearanceRaster, AppearanceRasterHold } from '../../lib/appearance-raster';
import { originalAppearancePlacement } from '../../lib/appearance-preview';
import { dpr } from './raster';

/** The bitmap of one annotation of the shown document at `tier`, held while
 *  `near`. Undefined: not known yet. Null: the annotation has no bitmap. The
 *  bitmap is held with the annotation it shows, so other bytes or another
 *  annotation never draw it. */
function useAppearanceRaster(
  pdf: PDFDocumentProxy | null, pageNumber: number, annotationId: string, tier: number, near: boolean,
): AppearanceRaster | null | undefined {
  const [held, setHeld] = useState<
    { pdf: PDFDocumentProxy; pageNumber: number; annotationId: string; raster: AppearanceRaster | null } | undefined
  >(undefined);
  useEffect(() => {
    if (!near || !pdf) return;
    let cancelled = false;
    let hold: AppearanceRasterHold | undefined;
    void (async () => {
      const key = await (contentKeyOf(pdf) ?? null);
      if (cancelled) return;
      // Held until the annotation, the tier or the document changes: the last
      // holder cancels a render in flight and closes the copy it renders.
      hold = holdAppearanceRaster({ pdf, contentKey: key, open: () => openPrivateCopy(pdf) }, pageNumber, annotationId, tier);
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
  return held && held.pdf === pdf && held.pageNumber === pageNumber && held.annotationId === annotationId ? held.raster : undefined;
}

/** Whether the element is near the viewport. Nothing is rastered before. */
function useNear(ref: React.RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
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
  }, [ref, near]);
  return near;
}

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
  const near = useNear(canvasRef);
  // The bitmap is as large as the box on the screen asks, by tier: a stamp
  // drawn small holds a small bitmap at any zoom.
  const deviceScale = dpr();
  const tier = appearanceRasterTier(appearanceRasterDemand(
    { width: width * deviceScale, height: height * deviceScale },
    rectangle,
    pixelsPerPoint * deviceScale,
  ));
  const raster = useAppearanceRaster(pdf, pageNumber, annotationId, tier, near);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!raster) {
      canvas.dataset.drawn = 'false';
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const scale = dpr();
    const w = Math.max(1, Math.min(APPEARANCE_RASTER_MAX_SIDE, Math.round(width * scale)));
    const h = Math.max(1, Math.min(APPEARANCE_RASTER_MAX_SIDE, Math.round(height * scale)));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const context = canvas.getContext('2d');
    if (!context) return;
    drawAppearanceRaster(context, raster, appearanceRasterTurn(raster.pageRotate, rotation, noRotate), w, h);
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

interface KeptAppearancePreviewProps {
  pdf: PDFDocumentProxy | null;
  /** The source page, 1-based. */
  pageNumber: number;
  /** pdf.js's id of the original in the source page. */
  annotationId: string;
  /** The move since the import, in the stored frame, display-normalized. */
  moved: { dx: number; dy: number };
  /** The page's pending rotation, without a view turn, and the view turn. */
  pendingRotation: number;
  viewRotation: number;
  /** The top-left corner of the annotation's own box in the view frame,
   *  display-normalized: the preview is placed from it. */
  origin: { x: number; y: number };
  /** The shown page in CSS pixels. */
  displayWidth: number;
  pageHeight: number;
  /** CSS pixels per point at the current zoom. */
  pixelsPerPoint: number;
  /** The appearance cannot be rastered: the caller draws its own body. */
  onMissing: () => void;
}

/** The appearance of an imported annotation the commit keeps as written,
 *  drawn where the commit puts it: the original's rectangle, moved as the
 *  user moved the annotation. It is the pixels of the appearance in the
 *  loaded bytes, so it is what the file shows after the commit. */
export function KeptAppearancePreview({
  pdf,
  pageNumber,
  annotationId,
  moved,
  pendingRotation,
  viewRotation,
  origin,
  displayWidth,
  pageHeight,
  pixelsPerPoint,
  onMissing,
}: KeptAppearancePreviewProps): React.JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const near = useNear(canvasRef);
  const tier = appearanceRasterTier(pixelsPerPoint * dpr());
  const raster = useAppearanceRaster(pdf, pageNumber, annotationId, tier, near);
  const placement = raster ? originalAppearancePlacement(raster, moved, pendingRotation, viewRotation) : null;
  const width = placement ? placement.box.w * displayWidth : 0;
  const height = placement ? placement.box.h * pageHeight : 0;
  const turn = placement?.turn ?? 0;

  const missing = raster === null;
  const reported = useRef(onMissing);
  reported.current = onMissing;
  useEffect(() => {
    if (missing) reported.current();
  }, [missing]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!raster) {
      canvas.dataset.drawn = 'false';
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const scale = dpr();
    const w = Math.max(1, Math.min(APPEARANCE_RASTER_MAX_SIDE, Math.round(width * scale)));
    const h = Math.max(1, Math.min(APPEARANCE_RASTER_MAX_SIDE, Math.round(height * scale)));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const context = canvas.getContext('2d');
    if (!context) return;
    drawAppearanceRaster(context, raster, turn, w, h);
    canvas.dataset.drawn = 'true';
  }, [raster, turn, width, height]);

  if (missing) return null;
  return (
    <canvas
      ref={canvasRef}
      className="page-annot-kept-appearance"
      data-testid="kept-appearance-preview"
      style={placement
        ? {
            left: (placement.box.x - origin.x) * displayWidth,
            top: (placement.box.y - origin.y) * pageHeight,
            width,
            height,
          }
        : { left: 0, top: 0, width: 1, height: 1 }}
    />
  );
}
